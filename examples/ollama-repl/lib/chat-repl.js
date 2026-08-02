/**
 * Adapts qjs-modules' interactive `REPL` (built-in module 'repl' -
 * /usr/local/lib/quickjs/repl.js, a full-featured readline: history
 * (up/down arrow, ^R reverse-search), line editing (^A/^E/^K/word-motion/
 * kill-ring), persisted-across-sessions history file) to a chat loop
 * instead of a JS eval loop.
 *
 * `REPL#handleCmd()` is the method that runs once a line is submitted -
 * normally it colorizes/evals the line as JS (see repl.js). The stock
 * extension point for a non-JS handler, `run(inputHandler)` (which sets
 * `this.handleInput`), doesn't actually work in this build: `handleCmd()`
 * only consults `this.handleInput` when `hasBignum` is false, but this
 * build has BigFloat, so every submitted line silently takes the
 * BigFloatEnv/evalAndPrintStart path instead, no matter what
 * `run()` was given. Overriding `handleCmd()` directly sidesteps that
 * entirely - confirmed working (including a fix below for a related
 * batching bug) against a real interactive run.
 */
import { readdir, S_IFDIR } from 'os';
import { fileMode } from './match.js';
import { REPL } from 'repl';

/* Bright white (not bold-as-in-JS-syntax-colors - just the one plain,
   readable color) instead of the base REPL's live JS-syntax highlighting
   (identifiers/keywords/strings each in a different color, since it
   normally colorizes input as JavaScript for its eval loop - meaningless,
   and visually noisy, for plain chat prompts). showColors=false below
   turns off colorizeJs()/printColorText() entirely, which means the
   prompt text itself is drawn with a single out.puts(this.cmd) call and
   *no* embedded color codes of its own - terminals keep whatever SGR
   (color) state was last set until something changes it, so emitting
   this code (with no trailing reset) as part of ps1 - which gets
   reprinted at the start of every prompt cycle, in readlinePrintPrompt()
   - makes the typed text inherit it too. */
const BRIGHT_WHITE = '\x1b[97m';

export class ChatREPL extends REPL {
  #busy = false;
  #queue = [];
  #root;

  /**
   * @param {string} name    ps1 prefix (e.g. "you" -> "you> ")
   * @param {(line: string) => Promise<void>} onLine  called once per
   *   submitted, non-empty, non-directive line, one at a time (a line
   *   submitted while a previous one is still being handled is queued,
   *   not run concurrently - see #run() below); the REPL prompt doesn't
   *   reappear until every queued onLine() call has settled.
   * @param {string} [root] project root, for Tab-completing paths.
   */
  constructor(name, onLine, root = '.') {
    super(name, false);
    this.onLine = onLine;
    this.#root = root;
    this.showColors = false;
    this.ps1 = BRIGHT_WHITE + this.ps1;
    this.historyLoad(); // also registers historySave() as a cleanup handler
  }

  /**
   * Tab-completion for filesystem paths (relative to `root`) instead of
   * the base REPL's default JS-identifier/property completion - the only
   * part of getCompletions()'s `{ tab, pos, ctx }` contract that matters
   * here is `tab` (candidate replacement strings) and `pos` (how much of
   * the current word is already typed, i.e. where to start inserting
   * from); `ctx` is only consulted for JS-specific paren/dot insertion
   * (completion(), repl.js) that doesn't apply to a plain path.
   */
  getCompletions(line, pos) {
    const start = line.slice(0, pos).search(/[^\s]*$/);
    const word = line.slice(start, pos);
    const slash = word.lastIndexOf('/');
    const dirPart = slash === -1 ? '' : word.slice(0, slash + 1);
    const prefix = slash === -1 ? word : word.slice(slash + 1);

    const base = this.#root === '.' ? dirPart || '.' : dirPart ? `${this.#root}/${dirPart}` : this.#root;
    const [names] = readdir(base);

    const tab = (names ?? [])
      .filter(name => name !== '.' && name !== '..' && name.startsWith(prefix))
      .sort()
      .map(name => {
        const isDir = fileMode(this.#root === '.' ? `${dirPart}${name}` : `${this.#root}/${dirPart}${name}`) == S_IFDIR;
        return dirPart + name + (isDir ? '/' : '');
      });

    return { tab, pos: word.length, ctx: {} };
  }

  handleCmd(expr) {
    if(expr === null) {
      // Ctrl-D on an empty line - same intent as /exit.
      this.exit(0);
      return true;
    }

    if(expr === '') return false;

    this.historyAdd(expr);

    /* Reset the line buffer *before* onLine() below resolves -
       termReadHandler() (repl.js) drains every currently-buffered byte in
       one synchronous loop, so if more than one line was already waiting
       (piped input, paste, fast typing outrunning a response) the bytes
       for the *next* line arrive and get appended to `this.cmd` before
       our promise settles and a fresh prompt/readlineStart() resets it.
       Confirmed via a standalone repro: without this reset, three piped
       lines ("hello"/"world"/"/exit") collapsed into
       "hello"/"helloworld"/"helloworld/exit" instead of three separate
       submissions. */
    this.cmd = '';
    this.cursorPos = 0;

    /* The same batched-bytes situation means a *second* complete line can
       arrive and reach handleCmd() again before the first's onLine()
       promise has settled - e.g. piped "<prompt>\n/exit\n" both land in
       one termReadHandler() pass. Without this guard that ran onLine()
       for both concurrently, so "/exit" could reach repl.exit()->std.exit()
       and kill the process while the first (real, in-flight network)
       request was still pending - confirmed directly: the reply and its
       log line never appeared. Queue instead of running concurrently. */
    if(this.#busy) {
      this.#queue.push(expr);
      return true;
    }

    this.#run(expr);
    return true; // tells readlineHandleCmd() not to re-prompt immediately
  }

  #run(expr) {
    this.#busy = true;

    this.onLine(expr)
      .catch(err => console.log(`\x1b[31merror: ${err.message}\x1b[0m`))
      .then(() => {
        this.#busy = false;

        if(this.#queue.length) this.#run(this.#queue.shift());
        else this.handleCmdEnd();
      });
  }

  /**
   * Asks a yes/no question and waits for the answer - used to gate RUN:
   * requests (lib/tool-requests.js) on user approval before a shell
   * command actually executes. Deliberately bypasses handleCmd()/#run()/
   * the busy-queue above entirely (calling the base REPL's own
   * readlineStart() directly, with its own one-off callback) rather than
   * going through onLine() - this is normally invoked *from inside* an
   * in-progress onLine() call (while #busy is already true), so routing
   * it through the same dispatch would just queue the answer behind the
   * very call that's waiting on it, deadlocking forever.
   *
   * @returns {Promise<boolean>}
   */
  confirm(promptText) {
    const savedPs1 = this.ps1;
    let answered = false;

    return new Promise(resolve => {
      this.ps1 = '\x1b[33m[y/N]\x1b[0m ';
      console.log(`\x1b[33m${promptText}\x1b[0m`);

      const cb = answer => {
        /* Same batched-bytes situation as handleCmd()'s own reset (see its
           comment): termReadHandler() can drain several already-piped/
           pasted lines in one synchronous pass, so a line meant for the
           *next* normal prompt can reach this one-shot callback again
           before readlineStart() below is what would normally reset
           `this.cmd`. Reset it ourselves every time this fires, and
           forward any line beyond the first real answer to handleCmd()
           instead of silently dropping it (confirmed directly: without
           this, piped "y"/"next prompt" lost the second line entirely -
           readlineCallback stayed pointed at this already-settled
           closure, whose resolve() on a second call is a silent no-op). */
        this.cmd = '';
        this.cursorPos = 0;

        if(!answered) {
          answered = true;
          this.ps1 = savedPs1;
          resolve(/^y(es)?$/i.test((answer ?? '').trim()));
        } else if(answer) {
          this.handleCmd(answer);
        }
      };

      this.readlineStart('', cb);
    });
  }
}
