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
import { gradient, stringWidth, stripAnsi, ttyRead, EAGAIN } from 'terminal';
import { Pager } from './pager.js';
import { STOPS, remoteMark, remoteText, note } from './look.js';
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
const RESET = '\x1b[0m';

/* a steering line that only says stop */
const STOP_WORD = /^(stop|cancel|abort|halt)[.!]?$/i;


/** the widest cell of each column over the rows that have cells */
const cellWidths = rows => {
  const w = [];
  for(const r of rows) if(r) r.forEach((c, i) => (w[i] = Math.max(w[i] ?? 0, stringWidth(c))));
  return w;
};

/**
 * the columns to show in `room` cells: all, then the ones named in `drop` (in that order) are left out until the
 * widest row fits
 */
function keepColumns(rows, drop, room) {
  const w = cellWidths(rows);
  const keep = w.map((_, i) => i);
  const total = () => keep.reduce((n, i) => n + w[i], 0) + 2 * (keep.length - 1);

  for(const d of drop) {
    if(total() <= room) break;
    keep.splice(keep.indexOf(d), 1);
  }

  return { keep, w };
}

/** row k as aligned columns of `keep`, separated by two spaces; the last column is not padded */
const columns = (rows, k, { keep, w }) => keep.map((i, j) => (j === keep.length - 1 ? rows[k][i] ?? '' : (rows[k][i] ?? '') + ' '.repeat(Math.max(0, w[i] - stringWidth(rows[k][i] ?? ''))))).join('  ');

/** Ctrl-X and then this key: a view of the split pane */
const SPLIT_CHORD = { d: '/split diff', g: '/split git', s: '/split status', n: '/split net', o: '/split off', '0': '/split off', '\t': '/split next' };

export class ChatREPL extends REPL {
  #busy = false;
  #queue = [];
  #chordX = false;
  #front = false;
  #current = null; /* the line #run() is handling */
  #frontQueued = false;
  /** called whenever the queue of pending prompts changed (repl.js saves the session and redraws the status) */
  onQueue = null;
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
  #historyPath;

  /**
   * Down on the newest history entry with text in the input starts one new empty entry (only one: on an empty
   * newest entry it does nothing); the empty entry is dropped again when a line is added
   */
  historyNext() {
    const { history } = this;

    const atNewest = this.cmd !== '' && this.historyIndex === history.length - 1;

    if(atNewest) {
      if(this.lineMove(1)) return;
      history.push('');
      this.historyIndex = history.length - 1;
      this.cmd = '';
      this.cursorPos = 0;
      return;
    }

    return super.historyNext();
  }

  historyAdd(str) {
    const { history } = this;
    if(history.length && history[history.length - 1] === '') history.pop();
    return super.historyAdd(str);
  }

  /** a named session keeps its own history file */
  historyFile() {
    return this.#historyPath ?? super.historyFile();
  }

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
  /** the model name now in use, to see whether a /model line changed it */
  getModel = null;
  onImmediate = null;

  /**
   * (command, words before the cursor's word, the word) => candidate words
   * for the argument of a slash command, [] when it takes none, null to
   * leave it to the filename completion
   */
  argCompleter = null;

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
  constructor(name, onLine, root = '.', onAbort, historyPath) {
    super(name, false);
    this.#historyPath = historyPath ?? null;
    this.onLine = onLine;
    this.#root = root;
    this.#onAbort = onAbort;
    this.showColors = false;
    /* line editing only when input is a terminal: the base REPL decides
       from stdout alone, but a script feeding stdin needs piped mode too */
    this.piped ||= !isatty(stdin.fileno());
    this.setPromptName(name);
    this.inspectOptions.maxStringLength = Infinity;
    this.historyLoad(); // also registers historySave() as a cleanup handler

    const cycle = () => void this.onCycleMode?.();
    this.commands['\x1b[Z'] = cycle; // Shift-Tab
    this.commands['\x1b\t'] = cycle; // Alt-Tab, where the window manager lets it through
    this.commands['\x0f'] = () => void this.onToggleVerbose?.(); // Ctrl-O
    /* Ctrl-X Ctrl-S sends the typed prompt now, ahead of the queue, cancelling the running request; Ctrl-S alone stays the search */
    const search = this.commands['\x13'];
    this.commands['\x18'] = () => void (this.#chordX = true);
    this.commands['\x13'] = function(k) {
      if(!this.#chordX) return search.call(this, k);
      this.#chordX = false;
      this.#sendNow();
    };
    /* the split pane: F2 next view, Shift-F2 the one before, Alt-1..4 diff/git/status/net, Alt-0 off, Alt-\\ on or off;
       Ctrl-X then d, g, s, n, o (off) or Tab does the same where the terminal does not pass the others */
    for(const k of ['\x1bOQ', '\x1b[12~']) this.commands[k] = () => void this.runNow('/split next');
    for(const k of ['\x1b[1;2Q', '\x1b[24~']) this.commands[k] = () => void this.runNow('/split prev');
    ['diff', 'git', 'status', 'net'].forEach((m, i) => (this.commands[`\x1b${i + 1}`] = () => void this.runNow(`/split ${m}`)));
    this.commands['\x1b0'] = () => void this.runNow('/split off');
    this.commands['\x1b\\'] = () => void this.runNow('/split');
    /* PgUp/PgDn scroll the transcript back and forth (the TUI keeps its own history) */
    this.commands['\x1b[5~'] = () => void this.tui?.scrollBy(-Math.max(1, this.tui.top - 2));
    this.commands['\x1b[6~'] = () => void this.tui?.scrollBy(Math.max(1, this.tui.top - 2));
    /* Alt-PgUp/PgDn scroll the split pane instead of the transcript */
    this.commands['\x1b[5;3~'] = () => void this.tui?.scrollPane(-Math.max(1, this.tui.top - 2));
    this.commands['\x1b[6;3~'] = () => void this.tui?.scrollPane(Math.max(1, this.tui.top - 2));
  }

  /** the prompts waiting behind the running one, oldest first */
  get queue() {
    return [...this.#queue];
  }

  /** removes the pending prompt number `n` (1-based), returns it or undefined */
  dropQueued(n) {
    const [gone] = this.#queue.splice(n - 1, 1);
    if(gone !== undefined) this.#queueChanged();
    return gone;
  }

  clearQueue() {
    const n = this.#queue.length;
    this.#queue.length = 0;
    if(n) this.#queueChanged();
    return n;
  }

  /** puts prompts saved with a session back: they run one after the other, the first at once when nothing runs */
  restoreQueue(list) {
    for(const expr of list) {
      if(this.#busy) this.#queue.push(expr);
      else this.#run(expr);
    }

    this.#queueChanged();
  }

  #queueChanged() {
    this.onQueue?.();
    if(this.#tuiOn) this.tui.drawStatus();
  }

  /** Ctrl-X Ctrl-S: the typed line goes first, a running request is cancelled for it; idle it is just submitted */
  #sendNow() {
    if(!this.cmd.trim()) return;

    this.#front = true;
    this.#frontQueued = false;
    this.handleKey('\r');
    this.#front = false;

    if(this.#frontQueued) this.#onAbort?.();
    this.#frontQueued = false;
  }

  /** Ctrl-X Ctrl-S for a remote line (control socket): `expr` goes first, a running request is cancelled for it */
  sendNow(expr, from) {
    this.#front = true;
    this.#frontQueued = false;
    this.handleCmd(expr, from);
    this.#front = false;

    if(this.#frontQueued) this.#onAbort?.();
    this.#frontQueued = false;
  }

  /** a command line from a shortcut key: runs at once, beside a running request, without touching the line being typed */
  runNow(line) {
    if(this.onImmediate) Promise.resolve(this.onImmediate(line)).catch(err => console.log(red(`error: ${err.message}`)));
    else this.restoreQueue([line]);
  }

  /** New prompt text (the model name) after a /model switch. */
  setPromptName(name) {
    this.ps1 = this.piped ? name + '> ' : `${gradient('◆', STOPS.slice(0, 1))} ${BRIGHT_WHITE}${name}${RESET} ${gradient('❯❯', STOPS.slice(1))} ${BRIGHT_WHITE}`;
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
   * Esc interrupts the running request, like Ctrl-C (and like Claude Code).
   * The base line editor takes a lone ESC byte as the start of an escape
   * sequence and waits for the next key, so Esc alone did nothing there. A
   * terminal sends a lone Esc key press as a read of exactly one 0x1b byte,
   * while arrow keys, Alt-keys and the rest arrive as one read with the whole
   * sequence: that is the difference used here. (A sequence that a slow link
   * splits right after its ESC byte is taken for an Esc press.) With no
   * request running a lone Esc is ignored (the editor would otherwise
   * swallow the next key as an Alt chord); while a dialog is open the byte
   * goes to the base editor as before.
   */
  termReadHandler() {
    if(this.piped) return super.termReadHandler();

    const l = ttyRead(stdin.fileno(), this.readBuf.buffer, 0, this.readBuf.length);
    if(l == -EAGAIN) return;

    if(l === 1 && this.readBuf[0] === 0x1b && !this.#dialog) {
      /* idle, a lone Esc is dropped: handed to the editor it would swallow the next key as an Alt chord */
      if(this.#busy && this.#onAbort?.()) this.tui?.write('\n(interrupted)\n');
      return;
    }

    for(let i = 0; i < l; i++) this.handleByte(this.readBuf[i]);
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

    const arg = this.argCandidates(line.slice(0, pos));
    if(arg) return { tab: arg.names.map(n => n + ' '), pos: arg.word.length, ctx: {} };

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
   * The candidates for the argument being typed after a slash command
   * ('/mode pl' -> plan), or null when the line is not such a command or the
   * command leaves its argument to the filename completion.
   *
   * @param {string} text  the line up to the cursor
   * @returns {{names: string[], word: string}|null}
   */
  argCandidates(text) {
    const m = /^(\/[a-z-]+)\s+([\s\S]*)$/.exec(text);
    if(!m || !this.argCompleter) return null;

    const words = m[2].split(/\s+/);
    const word = words.pop();
    const names = this.argCompleter(m[1], words, word);

    return names ? { names: names.filter(n => n.startsWith(word)), word } : null;
  }

  /**
   * What Tab would add to a slash command typed at the start of the line,
   * shown dark grey after the cursor: the part the matching commands have
   * in common ('/mo' -> 'de', for /mode and /model). '' when nothing would
   * be added, the cursor is not at the end or the line is not a command name.
   */
  ghost() {
    const line = this.cmd;
    if(this.cursorPos !== line.length || !line.startsWith('/')) return '';

    /* an argument: what the matching candidates have in common beyond the typed word */
    if(/\s/.test(line)) {
      const arg = this.argCandidates(line);
      if(!arg?.names.length) return '';

      let common = arg.names[0];
      for(const n of arg.names) while(!n.startsWith(common)) common = common.slice(0, -1);
      return common.slice(arg.word.length);
    }

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
    if(this.#tuiOn) this.tui.write(`\n${from === 'remote' ? `${remoteMark()} ` : from ? `[${from}]> ` : '\x1b[38;2;45;212;191m❯\x1b[0m '}${from === 'remote' ? remoteText(expr) : `\x1b[1;97m${expr}\x1b[0m`}\n`);

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
    /* a steering line that is only a control word cancels the running request and is not sent to the model */
    if(this.#front && this.#busy && STOP_WORD.test(expr.trim())) {
      this.#inputDone();
      if(this.#onAbort?.() && this.#tuiOn) this.tui.write('\x1b[2m⚡ cancelled\x1b[0m\n');
      return true;
    }

    /* /model NAME while a request runs: switch at once, cancel the request and send its prompt again to the new model */
    const switching = this.#busy && /^\/model\s+(?!(list|skip|unskip)\b)\S/.test(expr.trim());

    if(this.#busy && this.onImmediate && (switching || this.immediate?.(expr))) {
      const redo = switching && this.#current !== null && !this.#current.startsWith('/') ? this.#current : null;
      const before = this.getModel?.();

      Promise.resolve(this.onImmediate(expr))
        .catch(err => console.log(red(`error: ${err.message}`)))
        .then(() => {
          if(redo === null || !this.#busy || this.#current !== redo || this.getModel?.() === before) return;

          this.#queue.unshift(redo);
          this.#queueChanged();
          if(this.#onAbort?.() && this.#tuiOn) this.tui.write('\x1b[2m⚡ the running request is cancelled, its prompt goes to the new model\x1b[0m\n');
        });
      return true;
    }

    if(this.#busy) {
      if(this.#front) {
        this.#queue.unshift(expr);
        this.#frontQueued = true;
      } else this.#queue.push(expr);

      if(this.#tuiOn) this.tui.write(`\x1b[2m${this.#front ? '⚡ sent now, the running request is cancelled' : `⏳ queued, ${this.#queue.length} waiting`}\x1b[0m\n`);
      this.#queueChanged();
      return true;
    }

    this.#run(expr);
    return true; // tells readlineHandleCmd() not to re-prompt immediately
  }

  #run(expr) {
    this.#current = expr;
    this.#busy = true;
    this.pipeBusy = true; // piped: hold EOF/the next line back until this settles

    this.onLine(expr)
      .catch(err => console.log(red(`error: ${err.message}`)))
      .then(() => {
        this.#busy = false;

        if(this.#queue.length) {
          const next = this.#queue.shift();
          this.#queueChanged();
          this.#run(next);
        }
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
  openPager(title, text, { select } = {}) {
    if(!this.#tuiOn) return void console.log(`${title}\n${text}`);
    if(this.#pager) return;

    this.tui.suspend();
    this.#pager = new Pager({
      title,
      text,
      out: stdout,
      header: this.pagerHeader,
      select,
      sync: this.tui.sync,
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
   * the control socket answers it the same way. a list of cell rows (the
   * model chooser) is filtered by typing instead (j k y n and digits are
   * text then): the words must all be in a row, the last option stays, Esc Esc
   * clears the filter first.
   *
   *   await repl.choose('Apply this change?', ['Yes', 'Yes, always', 'No'])   // 0, 1 or 2
   */
  async choose(question, rawOptions, { view, drop = [] } = {}) {
    /* an option is a string, or an array of cells that are aligned in columns with the others' (the selected row gets a background) */
    const cells = rawOptions.some(Array.isArray) ? rawOptions.map(o => (Array.isArray(o) ? o : null)) : null;
    const options = rawOptions.map(o => (Array.isArray(o) ? o.filter(Boolean).join(' · ') : o));
    const last = options.length - 1;
    const pick = s => {
      s = String(s ?? '').trim();
      return /^\d+$/.test(s) && +s >= 1 && +s <= options.length ? +s - 1 : /^y(es)?$/i.test(s) ? 0 : last;
    };

    if(!this.#tuiOn) return pick(await this.ask(`${question}\n${options.map((o, k) => `  ${k + 1}. ${o}`).join('\n')}\n(1-${options.length}, y = 1, n = ${options.length})`));

    this.onPrompt?.('choose', `${question} ${options.map((o, k) => `${k + 1}. ${o}`).join(' ')}`.replace(/\x1b\[[0-9;]*m/g, ''));

    return new Promise(resolve => {
      this.#dialog = {
        question,
        options,
        cells,
        drop,
        sel: 0,
        pick,
        view,
        /* a list of aligned cells (the model chooser) is filtered by typing; the last option stays, it is the way out */
        filterable: !!cells,
        filter: '',
        plain: options.map(o => stripAnsi(o).toLowerCase()),
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

  /** the options (indexes) a filterable dialog shows: those holding every word typed, and always the last one */
  #visible(d) {
    const all = d.options.map((_, i) => i);
    const words = d.filter.toLowerCase().split(/\s+/).filter(Boolean);
    return words.length ? all.filter(i => i === all.length - 1 || words.every(w => d.plain[i].includes(w))) : all;
  }

  #drawDialog() {
    const d = this.#dialog;
    const vis = this.#visible(d);
    /* a long list scrolls: a window that keeps the selection in view, with how many options are hidden above and below */
    const room = Math.max(5, (this.tui.rows ?? 30) - 9);
    const n = vis.length;
    const rows = Math.min(n, room);
    d.sel = Math.min(d.sel, n - 1);
    d.top = Math.max(0, Math.min(d.top ?? 0, n - rows));
    if(d.sel < d.top) d.top = d.sel;
    if(d.sel >= d.top + rows) d.top = d.sel - rows + 1;

    const lines = [
      `\x1b[1;33m? ${d.question}\x1b[0m`,
      ...(d.top > 0 ? [`\x1b[2m  ↑ ${d.top} more above\x1b[0m`] : []),
      ...vis.slice(d.top, d.top + rows).map((k, j) => {
        const o = d.options[k];
        const at = d.top + j;
        if(d.layoutCols !== this.tui.cols) {
          d.layoutCols = this.tui.cols;
          d.layout = d.cells ? keepColumns(d.cells.filter(Boolean), d.drop, (this.tui.cols ?? 80) - 6) : null;
        }
        const text = d.cells?.[k] ? columns(d.cells, k, d.layout) : o;
        if(at !== d.sel) return `  \x1b[2m○\x1b[0m ${text}`;
        /* the selected row: a background across the width, kept through the resets inside the cells */
        const bg = '\x1b[48;2;30;64;60m';
        const row = `  \x1b[1;32m●\x1b[0m${bg} ${text}`.replace(/\x1b\[0m/g, `\x1b[0m${bg}`);
        return `${row}${' '.repeat(Math.max(0, (this.tui.cols ?? 80) - stringWidth(row) - 1))}\x1b[0m`;
      }),
      ...(d.top + rows < n ? [`\x1b[2m  ↓ ${n - d.top - rows} more below · PgDn End\x1b[0m`] : []),
      d.filterable
        ? `\x1b[2m  type to filter\x1b[0m${d.filter ? ` \x1b[33m${d.filter}▏\x1b[0m\x1b[2m · ${n - 1} of ${d.options.length - 1}` : ''}\x1b[2m · ↑↓ PgUp PgDn · Enter · Esc Esc${d.filter ? ' clears, again' : ''} none\x1b[0m`
        : `\x1b[2m  ↑↓ PgUp PgDn choose · Enter · 1-9 · y · n/Esc Esc${d.view ? ' · v view all' : ''}\x1b[0m`,
    ];

    this.tui.drawInput(lines);
  }

  handleKey(keys) {
    if(this.#pager) return void this.#pager.key(keys);

    /* any other key while scrolled back returns to the end first, then does its job */
    if(this.tui?.scrollOff && keys !== '\x1b[5~' && keys !== '\x1b[6~' && keys !== '\x1b[5;3~' && keys !== '\x1b[6;3~') this.tui.scrollEnd();

    const d = this.#dialog;
    if(!d) {
      /* Ctrl-X and then a letter: a view of the split pane; any other key ends the chord (Ctrl-X Ctrl-S sends now) */
      if(this.#chordX && SPLIT_CHORD[keys]) {
        this.#chordX = false;
        return void this.runNow(SPLIT_CHORD[keys]);
      }
      if(keys !== '\x18' && keys !== '\x13') this.#chordX = false;
      return super.handleKey(keys);
    }

    if(keys === 'v' && d.view && !d.filterable) return void d.view();

    const vis = this.#visible(d);
    const n = vis.length;
    const filtering = d.filterable;

    /* typing filters: printable text is added, Backspace removes, Ctrl-U and the first Esc Esc clear it */
    if(filtering && /^[^\x00-\x1f\x7f]+$/.test(keys) && !keys.startsWith('\x1b')) {
      d.filter += keys;
      d.sel = 0;
    } else if(filtering && (keys === '\x7f' || keys === '\b')) {
      d.filter = [...d.filter].slice(0, -1).join('');
      d.sel = 0;
    } else if(filtering && keys === '\x15') {
      d.filter = '';
      d.sel = 0;
    } else if(filtering && keys === '\x1b\x1b' && d.filter) {
      d.filter = '';
      d.sel = 0;
    } else if(keys === '\x1b[A' || (!filtering && keys === 'k') || keys === '\x10') d.sel = (d.sel + n - 1) % n;
    else if(keys === '\x1b[B' || (!filtering && keys === 'j') || keys === '\x0e' || keys === '\t') d.sel = (d.sel + 1) % n;
    else if(keys === '\x1b[6~') d.sel = Math.min(n - 1, d.sel + Math.max(3, (this.tui.rows ?? 30) - 12));
    else if(keys === '\x1b[5~') d.sel = Math.max(0, d.sel - Math.max(3, (this.tui.rows ?? 30) - 12));
    else if(keys === '\x1b[H' || keys === '\x1b[1~') d.sel = 0;
    else if(keys === '\x1b[F' || keys === '\x1b[4~') d.sel = n - 1;
    else if(keys === '\r' || keys === '\n') return d.finish(vis[d.sel]);
    else if(!filtering && /^[1-9yYnN]$/.test(keys)) return d.finish(d.pick(keys));
    else if(keys === '\x1b\x1b' || keys === '\x03') return d.finish(d.options.length - 1);

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
    else if(this.#tuiOn && !this.#dialog) {
      /* over the split pane (right of the transcript) the wheel scrolls the pane */
      const x = +(/<\d+;(\d+)/.exec(keys)?.[1] ?? 0);
      if(this.tui.pane && x > this.tui.width) this.tui.scrollPane(b === 64 ? -3 : 3);
      else this.tui.scrollBy(b === 64 ? -3 : 3);
    }
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

    /* keep the typed line: the base also calls this after listing the Tab candidates */
    this.tui.drawEditor(this.prompt, ' '.repeat(this.plen) + this.ps2, this.cmd, this.cursorPos, this.ghost());
    this.renderRow = 0;
    this.lastCmd = this.cmd;
    this.lastCursorPos = this.cursorPos;
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
    if(this.#tuiOn && this.cmd === '' && this.lastFun !== this.controlC) return void this.tui.write(`${note('press Ctrl+C again, Ctrl+D or type /exit to quit', 'quit')}\n`);

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
