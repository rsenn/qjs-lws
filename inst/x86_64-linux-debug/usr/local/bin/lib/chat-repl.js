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

  #onAbort;

  /**
   * @param {string} name    ps1 prefix (e.g. "you" -> "you> ")
   * @param {(line: string) => Promise<void>} onLine  called once per
   *   submitted, non-empty, non-directive line, one at a time (a line
   *   submitted while a previous one is still being handled is queued,
   *   not run concurrently - see #run() below); the REPL prompt doesn't
   *   reappear until every queued onLine() call has settled.
   * @param {string} [root] project root, for Tab-completing paths.
   * @param {() => boolean} [onAbort] called on Ctrl-C before the base
   *   REPL's own handling (see sigintHandler() below); should cancel
   *   whatever request is currently in flight and return true if it did,
   *   false if nothing was actually pending.
   */
  constructor(name, onLine, root = '.', onAbort) {
    super(name, false);
    this.onLine = onLine;
    this.#root = root;
    this.#onAbort = onAbort;
    this.showColors = false;
    this.ps1 = BRIGHT_WHITE + this.ps1;
    this.inspectOptions.maxStringLength = Infinity;
    this.historyLoad(); // also registers historySave() as a cleanup handler
  }

  /**
   * Base REPL's own Ctrl-C (see /usr/local/lib/quickjs/repl.js's
   * sigintHandler()) just forwards to readline, which without a request
   * in flight is the desired "press again to quit" behavior - but with one
   * in flight, forwarding it the same way did nothing to the actual
   * pending chat()/chatStream() call (it kept running in the background)
   * and a second, impatient press then killed the whole app instead of
   * just that one request. Ask `onAbort` (repl.js wires it to the active
   * client's abort()) whether there's actually a request to cancel first -
   * if so, cancel it and stop there; otherwise fall through to the base
   * behavior unchanged.
   */
  sigintHandler(arg) {
    if(this.#onAbort?.()) return;
    super.sigintHandler(arg);
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
       submissions.

       lastCmd/lastCursorPos are reset right alongside cmd/cursorPos,
       mirroring what readlinePrintPrompt() (base REPL) always does when it
       prints a fresh prompt - except no new prompt is printed here
       (onLine() may run for a long time: a whole chat round, tokens
       streamed straight to stdout by chatRound()/repl.js, bypassing
       readline's own cursor tracking entirely). Without this second
       reset, a keystroke typed before the next prompt reappears makes
       update() (repl.js) diff against the *previous* submitted command
       line instead of blank - it then relocates the cursor back to that
       stale position and clears forward, tearing into whatever the
       spinner/streamed reply has since printed there ("the prompt
       spilling into the output"). With lastCmd reset to '' too, update()
       takes its cheap append-from-current-cursor path instead: the typed
       character still lands wherever the streamed output currently
       leaves the cursor (unavoidable without buffering input separately -
       tolerable), but nothing already on screen gets relocated over or
       erased. */
    this.cmd = '';
    this.cursorPos = 0;
    this.lastCmd = '';
    this.lastCursorPos = 0;

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
   * Asks a yes/no question and waits for the answer - used to gate
   * run_command tool calls (lib/tool-requests.js) on user approval before
   * a shell script actually executes. Deliberately bypasses handleCmd()/#run()/
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
           closure, whose resolve() on a second call is a silent no-op).

           lastCmd/lastCursorPos reset alongside cmd/cursorPos for the same
           reason as handleCmd()'s own reset (see its comment) - answering
           doesn't print a fresh prompt either (the caller's onLine() call
           is still in progress), so leaving them stale would let the next
           keystroke's update() (repl.js) relocate the cursor back to this
           confirm prompt's line and clear forward, over whatever's
           printed since. */
        this.cmd = '';
        this.cursorPos = 0;
        this.lastCmd = '';
        this.lastCursorPos = 0;

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

  /**
   * Asks a free-text question and waits for the typed answer - backs the
   * `ask_user` tool (lib/tool-requests.js). Same shape/reasoning as
   * confirm() above (bypasses handleCmd()/#run(), resets
   * cmd/cursorPos/lastCmd/lastCursorPos in its one-off callback) - see
   * confirm()'s own doc comment for why.
   *
   * @returns {Promise<string>}
   */
  ask(promptText) {
    const savedPs1 = this.ps1;
    let answered = false;

    return new Promise(resolve => {
      this.ps1 = '\x1b[33m(answer)> \x1b[0m';
      console.log(`\x1b[33m${promptText}\x1b[0m`);

      const cb = answer => {
        this.cmd = '';
        this.cursorPos = 0;
        this.lastCmd = '';
        this.lastCursorPos = 0;

        if(!answered) {
          answered = true;
          this.ps1 = savedPs1;
          resolve((answer ?? '').trim());
        } else if(answer) {
          this.handleCmd(answer);
        }
      };

      this.readlineStart('', cb);
    });
  }
}
