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
import { isatty, readdir, S_IFDIR } from 'os';
import { in as stdin, out as stdout } from 'std';
import { fileMode } from './match.js';
import { expandHome } from './paths.js';
import { REPL } from 'repl';
import { stripAnsi } from 'terminal';
import { Pager } from './pager.js';
import { red, yellow } from './ansi.js';

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

  /* hooks for lib/control-socket.js: onIdle() once every submitted line
     has been handled, onPrompt(kind, text) when a question is put to the
     terminal user */
  onIdle;
  onPrompt;

  /* lib/tui.js layout while it is active: the line editor is drawn in its
     input rows, see the overrides at the end of the class */
  tui = null;

  /* key hooks: Shift-Tab or Alt-Tab cycles the mode, Ctrl-O toggles verbose */
  onCycleMode;
  onToggleVerbose;
  /** (cols, label) => the pager's header line, else reverse video */
  pagerHeader;

  /** slash commands Tab completes at the start of the line ('/cd', ...) */
  commandNames = [];

  /**
   * (line) => boolean: lines handled at once even while the model works
   * (flags and read-only reports); `onImmediate(line)` runs them beside the
   * running request instead of queueing them behind it. Everything else
   * waits its turn, a line that changes the conversation must not overlap.
   */
  immediate = null;
  onImmediate = null;

  /** () => skill names, completed after '/skill ' */
  skillNames = null;

  get busy() {
    return this.#busy;
  }

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
    /* line editing only when input is a terminal: the base REPL decides
       from stdout alone, but a script feeding stdin needs piped mode too */
    this.piped ||= !isatty(stdin.fileno());
    if(!this.piped) this.ps1 = BRIGHT_WHITE + this.ps1;
    this.inspectOptions.maxStringLength = Infinity;
    this.historyLoad(); // also registers historySave() as a cleanup handler

    const cycle = () => void this.onCycleMode?.();
    this.commands['\x1b[Z'] = cycle; // Shift-Tab
    this.commands['\x1b\t'] = cycle; // Alt-Tab, where the window manager lets it through
    this.commands['\x0f'] = () => void this.onToggleVerbose?.(); // Ctrl-O
    /* PgUp/PgDn scroll the transcript back and forth (the TUI keeps its own history) */
    this.commands['\x1b[5~'] = () => void this.tui?.scrollBy(-Math.max(1, this.tui.top - 2));
    this.commands['\x1b[6~'] = () => void this.tui?.scrollBy(Math.max(1, this.tui.top - 2));
  }

  /** New prompt text (the model name) after a /model switch. */
  setPromptName(name) {
    this.ps1 = (this.piped ? '' : BRIGHT_WHITE) + name + '> ';
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
   * Tab completion: slash-command names at the start of the line, else a
   * filesystem path relative to the root. A typed ~ or ~user stays as
   * typed, an absolute path is taken as is, after /cd only directories
   * are offered. Returns the base REPL's { tab, pos, ctx } shape: tab the
   * replacement candidates, pos how much of the word is already typed.
   *
   *   '/mo'          -> ['/mode ', '/model ']
   *   '/cd ~/Sou'    -> ['~/Sources/']
   *   'see /usr/inc' -> ['/usr/include/']
   */
  getCompletions(line, pos) {
    const start = line.slice(0, pos).search(/[^\s]*$/);
    const word = line.slice(start, pos);

    if(start === 0 && word.startsWith('/') && !word.includes('/', 1)) {
      const names = this.commandNames.filter(n => n.startsWith(word));
      if(names.length) return { tab: names.map(n => n + ' '), pos: word.length, ctx: {} };
    }

    const skill = this.skillNames && /^\/skill\s+(\S*)$/.exec(line.slice(0, pos));
    if(skill) {
      const names = this.skillNames().filter(n => n.startsWith(skill[1]));
      return { tab: names.map(n => n + ' '), pos: skill[1].length, ctx: {} };
    }

    const dirsOnly = /^\/cd\s+$/.test(line.slice(0, start));
    const slash = word.lastIndexOf('/');
    const dirPart = slash === -1 ? '' : word.slice(0, slash + 1);
    const prefix = slash === -1 ? word : word.slice(slash + 1);

    /* ~ alone (no slash yet): complete it to ~/ */
    if(/^~[^/]*$/.test(word) && expandHome(word + '/') !== word + '/') return { tab: [word + '/'], pos: word.length, ctx: {} };

    const real = expandHome(dirPart);
    const base = real.startsWith('/') ? real || '/' : this.#root === '.' ? real || '.' : real ? `${this.#root}/${real}` : this.#root;
    const [names] = readdir(base);

    const tab = (names ?? [])
      .filter(name => name !== '.' && name !== '..' && name.startsWith(prefix))
      .sort()
      .map(name => ({ name, isDir: fileMode(`${base.replace(/\/$/, '')}/${name}`) == S_IFDIR }))
      .filter(({ isDir }) => isDir || !dirsOnly)
      .map(({ name, isDir }) => dirPart + name + (isDir ? '/' : ''));

    return { tab, pos: word.length, ctx: {} };
  }

  /**
   * What Tab would add to a slash command typed at the start of the line,
   * shown dark grey after the cursor: the part the matching commands have
   * in common ('/mo' -> 'de', for /mode and /model). '' when nothing would
   * be added, the cursor is not at the end or the line is not a command name.
   */
  ghost() {
    const line = this.cmd;
    if(this.cursorPos !== line.length || !line.startsWith('/') || /\s/.test(line)) return '';

    const names = this.commandNames.filter(n => n.startsWith(line));
    if(!names.length) return '';

    let common = names[0];
    for(const n of names) while(!n.startsWith(common)) common = common.slice(0, -1);

    return common.slice(line.length);
  }

  /* Enter always submits: the base REPL's continuation() parses the line
     as JavaScript and keeps it open while a bracket/quote/regex is
     unterminated, so "/model list" (a leading "/" starts a regex literal)
     just printed "  ..." continuation lines instead of running. */
  continuation() {
    return null;
  }

  /**
   * @param {string|null} expr  the submitted line, null for Ctrl-D
   * @param {string} [from]     who sent it, shown in the transcript (remote)
   */
  handleCmd(expr, from) {
    if(expr === null) {
      // Ctrl-D on an empty line - same intent as /exit.
      this.exit(0);
      return true;
    }

    if(this.#dialog && from === 'remote') {
      this.#dialog.finish(this.#dialog.pick(expr));
      return true;
    }

    if(expr === '') return false;

    this.historyAdd(expr);
    if(this.#tuiOn) this.tui.write(`\n${from ? `[${from}]` : ''}\x1b[1;97m> ${expr}\x1b[0m\n`);

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
    this.#inputDone();

    /* The same batched-bytes situation means a *second* complete line can
       arrive and reach handleCmd() again before the first's onLine()
       promise has settled - e.g. piped "<prompt>\n/exit\n" both land in
       one termReadHandler() pass. Without this guard that ran onLine()
       for both concurrently, so "/exit" could reach repl.exit()->std.exit()
       and kill the process while the first (real, in-flight network)
       request was still pending - confirmed directly: the reply and its
       log line never appeared. Queue instead of running concurrently. */
    if(this.#busy && this.onImmediate && this.immediate?.(expr)) {
      Promise.resolve(this.onImmediate(expr)).catch(err => console.log(red(`error: ${err.message}`)));
      return true;
    }

    if(this.#busy) {
      this.#queue.push(expr);
      return true;
    }

    this.#run(expr);
    return true; // tells readlineHandleCmd() not to re-prompt immediately
  }

  #run(expr) {
    this.#busy = true;
    this.pipeBusy = true; // piped: hold EOF/the next line back until this settles

    this.onLine(expr)
      .catch(err => console.log(red(`error: ${err.message}`)))
      .then(() => {
        this.#busy = false;

        if(this.#queue.length) this.#run(this.#queue.shift());
        else {
          /* TUI: keys typed while the model worked stay in the input */
          const typed = this.#tuiOn ? this.cmd : '';
          this.handleCmdEnd();

          if(typed) {
            this.cmd = typed;
            this.cursorPos = typed.length;
            this.update();
          }

          this.onIdle?.();
        }
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
      this.ps1 = yellow('[y/N]') + ' ';
      console.log(promptText.includes('\x1b') ? promptText : yellow(promptText)); // a styled one (a TUI panel) keeps its colors
      this.onPrompt?.('confirm', stripAnsi(promptText));

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
        if(!answered) {
          this.ps1 = savedPs1;
          this.#inputDone(`${yellow('[y/N]')} ${answer ?? ''}\n`);
          answered = true;
          this.pipeBusy = true;
          resolve(/^y(es)?$/i.test((answer ?? '').trim()));
        } else if(answer) {
          this.handleCmd(answer);
        }
      };

      this.readlineStart('', cb);
      this.#awaitPipedAnswer();
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
      this.ps1 = yellow('(answer)>') + ' ';
      console.log(yellow(promptText));
      this.onPrompt?.('ask', promptText);

      const cb = answer => {
        if(!answered) {
          this.ps1 = savedPs1;
          this.#inputDone(`${yellow('(answer)>')} ${answer ?? ''}\n`);
          answered = true;
          this.pipeBusy = true;
          resolve((answer ?? '').trim());
        } else if(answer) {
          this.handleCmd(answer);
        }
      };

      this.readlineStart('', cb);
      this.#awaitPipedAnswer();
    });
  }

  /** the open choose() dialog: { question, options, sel, finish, view } */
  #dialog = null;
  /** the open full-screen pager, keys go there first */
  #pager = null;

  /**
   * text full-screen in a scrollable pager (TUI), printed elsewhere. the
   * transcript waits behind it, keys go to it until q.
   */
  openPager(title, text) {
    if(!this.#tuiOn) return void console.log(`${title}\n${text}`);
    if(this.#pager) return;

    this.tui.suspend();
    this.#pager = new Pager({
      title,
      text,
      out: stdout,
      header: this.pagerHeader,
      onClose: () => {
        this.#pager = null;
        this.tui.resume();
        this.render();
      },
    }).open();
  }

  /**
   * a question with a fixed set of answers, returns the index chosen.
   * TUI: a dialog in the input rows, up/down (j/k, Tab) and Enter, a
   * digit, y for the first and n, Esc Esc or Ctrl-C for the last option.
   * elsewhere a numbered question answered by number, y or n. a line from
   * the control socket answers it the same way.
   *
   *   await repl.choose('Apply this change?', ['Yes', 'Yes, always', 'No'])   // 0, 1 or 2
   */
  async choose(question, options, { view } = {}) {
    const last = options.length - 1;
    const pick = s => {
      s = String(s ?? '').trim();
      return /^\d+$/.test(s) && +s >= 1 && +s <= options.length ? +s - 1 : /^y(es)?$/i.test(s) ? 0 : last;
    };

    if(!this.#tuiOn) return pick(await this.ask(`${question}\n${options.map((o, k) => `  ${k + 1}. ${o}`).join('\n')}\n(1-${options.length}, y = 1, n = ${options.length})`));

    this.onPrompt?.('choose', `${question} ${options.map((o, k) => `${k + 1}. ${o}`).join(' ')}`);

    return new Promise(resolve => {
      this.#dialog = {
        question,
        options,
        sel: 0,
        pick,
        view,
        finish: k => {
          this.#dialog = null;
          this.tui.showCursor();
          this.tui.write(`  ${k === last ? '\x1b[31m✗' : '\x1b[32m✓'} ${options[k]}\x1b[0m\n`);
          this.render();
          resolve(k);
        },
      };
      this.#drawDialog();
    });
  }

  #drawDialog() {
    const d = this.#dialog;
    const lines = [
      `\x1b[1;33m? ${d.question}\x1b[0m`,
      ...d.options.map((o, k) => (k === d.sel ? `  \x1b[1;32m● ${o}\x1b[0m` : `  \x1b[2m○\x1b[0m ${o}`)),
      `\x1b[2m  ↑↓ choose · Enter · 1-${d.options.length} · y · n/Esc Esc${d.view ? ' · v view all' : ''}\x1b[0m`,
    ];

    this.tui.drawInput(lines);
  }

  handleKey(keys) {
    if(this.#pager) return void this.#pager.key(keys);

    /* any other key while scrolled back returns to the end first, then does its job */
    if(this.tui?.scrollOff && keys !== '\x1b[5~' && keys !== '\x1b[6~') this.tui.scrollEnd();

    const d = this.#dialog;
    if(!d) return super.handleKey(keys);

    if(keys === 'v' && d.view) return void d.view();

    const n = d.options.length;

    if(keys === '\x1b[A' || keys === 'k' || keys === '\x10') d.sel = (d.sel + n - 1) % n;
    else if(keys === '\x1b[B' || keys === 'j' || keys === '\x0e' || keys === '\t') d.sel = (d.sel + 1) % n;
    else if(keys === '\r' || keys === '\n') return d.finish(d.sel);
    else if(/^[1-9yYnN]$/.test(keys)) return d.finish(d.pick(keys));
    else if(keys === '\x1b\x1b' || keys === '\x03') return d.finish(n - 1);

    this.#drawDialog();
  }

  /**
   * an SGR mouse report from the line editor: the wheel scrolls the pager
   * when it is open, else the transcript, 3 lines per notch. clicks are
   * ignored.
   */
  handleMouse(keys) {
    const b = +(/<(\d+)/.exec(keys)?.[1] ?? -1);
    if(b !== 64 && b !== 65) return;

    if(this.#pager) for(let k = 0; k < 3; k++) this.#pager.key(b === 64 ? '\x1b[A' : '\x1b[B');
    else if(this.#tuiOn && !this.#dialog) this.tui.scrollBy(b === 64 ? -3 : 3);
  }

  get #tuiOn() {
    return !!this.tui?.active;
  }

  /**
   * empties the line buffer after a submitted line (see handleCmd()), TUI:
   * `echo` goes to the transcript and the input shows the prompt again,
   * ready for keys typed ahead
   */
  #inputDone(echo) {
    this.cmd = '';
    this.cursorPos = 0;
    this.lastCmd = '';
    this.lastCursorPos = 0;

    if(!this.#tuiOn) return;
    if(echo) this.tui.write(echo);
    this.prompt = this.pstate + this.ps1;
    this.render();
  }

  /* TUI overrides of the base line editor: each redraw starts at the first
     input row with renderRow 0, so its relative moves and its erase to the
     end of the screen stay inside the input, the status line is painted
     again after it */

  render(cursorMarks = true) {
    if(!this.#tuiOn) return super.render(cursorMarks);
    if(this.#pager) return this.#pager.resize(); // only a resize reaches here while it is open
    if(this.#dialog) return this.#drawDialog(); // the dialog owns the input rows until it is answered

    this.tui.drawEditor(this.prompt, ' '.repeat(this.plen) + this.ps2, this.cmd, this.cursorPos, this.ghost());
    this.renderRow = 0;
    this.lastCmd = this.cmd;
    this.lastCursorPos = this.cursorPos;
    this.tui.drawStatus();
  }

  paintLine(text, index) {
    if(!this.#tuiOn) return super.paintLine(text, index);
    if(this.#pager) return;
    if(this.#dialog) return this.#drawDialog();

    this.tui.drawEditor('', '', text, text.length > index ? index : text.length);
    this.renderRow = 0;
    this.tui.drawStatus();
  }

  readlinePrintPrompt() {
    if(!this.#tuiOn) return super.readlinePrintPrompt();
    if(this.#pager) return;
    if(this.#dialog) return this.#drawDialog();

    this.tui.drawEditor(this.prompt, '', '', 0);
    this.renderRow = 0;
    this.tui.drawStatus();
  }

  readlineRemovePrompt() {
    if(!this.#tuiOn) return super.readlineRemovePrompt();

    this.tui.drawEditor('', '', '', 0);
    this.renderRow = 0;
  }

  /* the base moves below the input to print there, the TUI prints into the transcript */
  moveBelow() {
    if(!this.#tuiOn) return super.moveBelow();

    const pos = this.cursorPos;
    this.cursorPos = this.cmd.length;
    this.render(false);
    this.cursorPos = pos;
  }

  showCompletions(tab) {
    if(!this.#tuiOn) return super.showCompletions(tab);

    this.tui.write(tab.join('  ') + '\n');
  }

  controlC() {
    if(this.#tuiOn && this.cmd === '' && this.lastFun !== this.controlC) return void this.tui.write('(to exit press Ctrl+C again, Ctrl+D or type /exit)\n');

    return super.controlC();
  }

  controlL() {
    if(!this.#tuiOn) return super.controlL();

    this.tui.clear();
    this.render();
  }

  /* Piped: the line being handled holds pipeBusy, so the next input line
     would wait behind the very question it is meant to answer. Release it
     for the one-off callback (which re-takes it on the first answer). */
  #awaitPipedAnswer() {
    if(!this.piped) return;

    this.pipeBusy = false;
    this.pipeDrain();
  }
}
