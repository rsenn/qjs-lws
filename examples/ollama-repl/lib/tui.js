/**
 * tui: the terminal layout of ollama-repl, built on qjs-modules' terminal
 * module. The transcript scrolls in a scroll region (so the terminal's own
 * scrollback keeps it), the bottom rows stay put:
 *
 *   row 1 .. top-1   transcript: everything written to std.out
 *   row top          rule with the activity (spinner, elapsed time)
 *   rows below       input, the REPL's line editor (grows with the text)
 *   last rows        status lines: model, route, tokens, context, quota
 *
 * ```js
 * const tui = new Tui({ status: () => 'qwen 1.2k tok' });
 * tui.start();            // std.out.puts now writes into the transcript
 * tui.setActivity('▘ Making it so…');
 * tui.close();
 * ```
 *
 * The REPL draws its input with relative moves and an erase to the end of
 * the screen. lib/chat-repl.js moves the cursor to the input's first row
 * (moveToInput()) before each redraw and repaints the status line after
 * it, which keeps that code unchanged. The cursor always rests in the
 * input. Transcript writes jump to the remembered output position and
 * back (ESC 7 / ESC 8), so keys typed while the model works land in the
 * input.
 */
import { out as stdout } from 'std';
import { signal } from 'os';
import { SIGWINCH } from 'util';
import { Region, charWidth, layoutInput, stringWidth, ttyWrite, windowSize } from 'terminal';

const ESC = '\x1b';
const CSI = ESC + '[';
const SAVE = ESC + '7';
const RESTORE = ESC + '8';

/* one escape sequence at the start of a string, same set terminal.js strips */
const ANSI_AT = /^\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[ -\/]*[0-~])/;

const goto = (row, col = 1) => `${CSI}${row};${col}H`;

/* press, release and wheel reports in SGR form (decoded by the REPL's line editor) */
const MOUSE_ON = `${CSI}?1000h${CSI}?1006h`;
const MOUSE_OFF = `${CSI}?1000l${CSI}?1006l`;
const HISTORY_MAX = 10000;
const SGR = /^\x1b\[[\d;]*m$/;

/** str cut to `width` cells, escape sequences kept, attributes reset at the end */
export function clip(str, width) {
  let out = '',
    w = 0;

  for(let i = 0; i < str.length; ) {
    const m = str[i] === ESC && ANSI_AT.exec(str.slice(i));

    if(m) {
      out += m[0];
      i += m[0].length;
      continue;
    }

    const ch = String.fromCodePoint(str.codePointAt(i));
    const cw = charWidth(ch);
    if(w + cw > width) break;

    out += ch;
    w += cw;
    i += ch.length;
  }

  return out + CSI + '0m';
}

export class Tui {
  #out;
  #status;
  #puts = null;
  #activity = '';
  #paintRule;
  /* the transcript as lines, for scrolling back: done lines, the one being written, the SGR in effect */
  #hist = [];
  /* per history line: 0 always shown, 1 only in the verbose view, 2 only outside it */
  #kinds = [];
  #cur = '';
  #sgr = '';
  /** what the lines written now are: 0 always shown, 1 verbose view only, 2 compact view only (see setVerbose) */
  kind = 0;
  /** the verbose view is on: lines of kind 1 show, lines of kind 2 are hidden */
  verbose = false;
  /** lines the view is scrolled up from the end of the transcript, 0: following it */
  scrollOff = 0;
  /** whether the terminal reports the mouse (the wheel scrolls the transcript) */
  mouse = true;

  /* the input and status rows remember what they show: a redraw writes only rows that changed */
  #inputRegion = new Region(1, 1);
  #statusRegion = new Region(1, 1);
  #ruleRegion = new Region(1, 1);

  /** transcript writes held while something else (the pager) owns the screen, else null */
  #held = null;
  #resizePending = false;
  #closed = true;

  cols = 80;
  rows = 24;
  /** rows the input takes now */
  inputRows = 1;
  /** rows of the status area at the bottom */
  statusRows = 1;
  /** (width, height) => lines of the right-hand pane, null: no pane */
  pane = null;
  /** columns of the pane, its divider included */
  paneWidth = 0;

  /** output position: row (1-based) and column (0-based, == cols: wrap pending) */
  oRow = 1;
  oCol = 0;

  /**
   * @param {object} opts
   * @param {() => string|string[]} opts.status  the status lines, read on every repaint
   * @param {number} [opts.statusRows]   how many status lines there are (1)
   * @param {(cols: number) => void} [opts.onResize]  called after the window changed size
   * @param {(cols: number, label: string) => string} [opts.paintRule]  draws the rule above the input, else a dim line
   * @param {FILE} [opts.out]            terminal to draw on (std.out)
   */
  constructor({ status, onResize, paintRule, statusRows = 1, mouse = true, out = stdout } = {}) {
    this.mouse = mouse;
    this.#out = out;
    this.statusRows = statusRows;
    this.#status = status ?? (() => '');
    this.onResize = onResize;
    this.#paintRule = paintRule;
  }

  get active() {
    return !this.#closed;
  }

  /** columns of the transcript, left of the pane */
  get width() {
    return this.pane ? this.cols - this.paneWidth : this.cols;
  }

  /**
   * a pane on the right of the transcript, fn(width, height) gives its
   * lines; null takes it away. too narrow a terminal (under 80 columns)
   * gets no pane.
   */
  setPane(fn) {
    const had = !!this.pane;

    this.pane = fn && this.cols >= 80 ? fn : null;
    this.paneWidth = this.pane ? Math.max(30, Math.floor(this.cols * 0.42)) : 0;

    /* the transcript may run into the pane's columns, and back */
    if(this.pane || had) {
      let s = SAVE;
      for(let r = 1; r < this.top; r++) s += `${goto(r, (this.pane ? this.width : this.cols - Math.max(30, Math.floor(this.cols * 0.42))) + 1)}${CSI}0m${CSI}K`;
      this.#write(s + RESTORE);
    }

    this.oCol = Math.min(this.oCol, this.width);
    this.drawPane();
    return !!this.pane;
  }

  drawPane() {
    if(!this.pane || this.#closed || this.#held) return;

    const height = this.top - 1;
    const w = this.paneWidth - 2;
    const lines = this.pane(w, height) ?? [];
    let s = SAVE;

    for(let r = 1; r <= height; r++) s += `${goto(r, this.width + 1)}${CSI}0m${CSI}2m│${CSI}0m ${clip(lines[r - 1] ?? '', w)}${CSI}K`;

    this.#write(s + RESTORE);
  }

  /** first row of the bottom area (the rule), the transcript ends above it */
  get top() {
    return this.rows - this.inputRows - this.statusRows;
  }

  /** first input row */
  get inputTop() {
    return this.top + 1;
  }

  #write(s) {
    ttyWrite(this.#out, s);
  }

  /**
   * takes over the terminal: blank screen (the old content goes to the
   * scrollback), scroll region set, std.out.puts redirected into the
   * transcript
   */
  start() {
    [this.cols, this.rows] = windowSize(this.#out);
    this.#closed = false;
    this.#write('\n'.repeat(this.rows) + goto(1));
    this.oRow = 1;
    this.oCol = 0;
    this.#layout();

    const puts = (this.#puts = this.#out.puts.bind(this.#out));
    this.#out.puts = s => (this.#closed ? puts(s) : this.write(String(s)));

    signal(SIGWINCH, () => this.resize());
    if(this.mouse) this.#write(MOUSE_ON);
  }

  /** mouse reports on (wheel scrolls, Shift-drag selects text) or off (the terminal's own selection) */
  setMouse(on) {
    this.mouse = !!on;
    if(!this.#closed) this.#write(on ? MOUSE_ON : MOUSE_OFF);
  }

  /** gives the terminal back: whole screen scrolls again, cursor below everything */
  close() {
    if(this.#closed) return;
    this.#closed = true;

    if(this.#puts) this.#out.puts = this.#puts;
    signal(SIGWINCH, null);
    if(this.mouse) this.#write(MOUSE_OFF);
    this.#write(`${CSI}r${goto(this.rows)}\r${CSI}K\n`);
  }

  #layout() {
    this.#inputRegion.invalidate();
    this.#statusRegion.invalidate();
    this.#ruleRegion.invalidate();
    this.#write(`${CSI}1;${this.top - 1}r`);
    this.oRow = Math.min(this.oRow, this.top - 1);
    this.drawRule();
    this.drawStatus();
    if(this.pane && this.cols < 80) this.pane = null; // a resize made the window too narrow for it
    if(this.pane) {
      this.paneWidth = Math.max(30, Math.floor(this.cols * 0.42));
      this.drawPane();
    }
  }

  /**
   * text into the transcript at the output position, cursor back where
   * it was. Wrapping and scrolling are tracked, so the next write goes on
   * where this one ended.
   */
  write(text) {
    if(this.#held) return void this.#held.push({ text, kind: this.kind });

    /* a line the current view hides is still kept in the history, wrapped like a shown one, for when the view changes */
    const dry = !this.#shows(this.kind);
    const kept = dry ? { row: this.oRow, col: this.oCol, cur: this.#cur, sgr: this.#sgr } : null;

    if(dry) {
      this.#cur = '';
      this.#sgr = '';
      this.oCol = 0;
    }

    const bottom = this.top - 1;
    let s = SAVE + goto(this.oRow, Math.min(this.oCol, this.cols - 1) + 1) + CSI + '0m'; // the input's color is saved with the cursor

    let scrolled = false,
      added = 0;
    const newline = () => {
      s += '\r\n';
      this.oCol = 0;
      if(this.oRow < bottom) this.oRow++;
      else scrolled = true;

      this.#hist.push(this.#cur + (this.#sgr ? CSI + '0m' : ''));
      this.#kinds.push(this.kind);
      if(this.#hist.length > HISTORY_MAX) {
        this.#hist.splice(0, this.#hist.length - HISTORY_MAX);
        this.#kinds.splice(0, this.#kinds.length - HISTORY_MAX);
      }
      this.#cur = this.#sgr;
      added++;
    };

    for(let i = 0; i < text.length; ) {
      const c = text[i];

      if(c === ESC) {
        const m = ANSI_AT.exec(text.slice(i));

        if(m) {
          s += m[0];
          i += m[0].length;

          if(SGR.test(m[0])) {
            this.#cur += m[0];
            this.#sgr = /^\x1b\[0?m$/.test(m[0]) ? '' : this.#sgr + m[0];
          }
          continue;
        }
      }

      if(c === '\n') {
        newline();
        i++;
        continue;
      }

      if(c === '\r') {
        s += '\r';
        this.#cur = this.#sgr; // the line is written again from its start
        this.oCol = 0;
        i++;
        continue;
      }

      if(c === '\b') {
        if(this.oCol > 0) {
          s += '\b';
          this.oCol = Math.min(this.oCol, this.cols) - 1;
        }

        i++;
        continue;
      }

      if(c === '\t') {
        const n = Math.min(8 - (this.oCol % 8), Math.max(1, this.width - this.oCol));
        text = text.slice(0, i) + ' '.repeat(n) + text.slice(i + 1);
        continue;
      }

      const ch = String.fromCodePoint(text.codePointAt(i));
      const w = charWidth(ch);
      i += ch.length;

      if(w === 0 && ch < ' ') continue; // other controls would move the cursor behind our back
      if(this.oCol + w > this.width) newline();

      s += ch;
      this.#cur += ch;
      this.oCol += w;
    }

    if(dry) {
      this.#cur = kept.cur;
      this.#sgr = kept.sgr;
      this.oRow = kept.row;
      this.oCol = kept.col;
      return true;
    }

    /* scrolled back: the new text is in the history, the view stays where the user put it */
    if(this.scrollOff > 0) {
      this.scrollOff += added;
      this.drawRule();
      return true;
    }

    this.#write(s + RESTORE);

    /* scrolling moved the pane up with the transcript, an erase in the text may have cut into it */
    if(this.pane && (scrolled || /\x1b\[[0-2]?K/.test(text))) this.drawPane();
    return true;
  }

  /** activity text in the rule above the input (spinner), '' or null clears it */
  setActivity(text) {
    this.#activity = text ?? '';
    if(!this.#closed) this.drawRule();
  }

  /**
   * scrolls the transcript view by n lines, negative goes back. returns
   * whether it moved. back at the end the view follows the output again.
   */
  #shows(kind) {
    return kind === 0 || (kind === 1) === this.verbose;
  }

  #shownLines() {
    return this.#hist.filter((_, i) => this.#shows(this.#kinds[i]));
  }

  /** switches the view: lines of kind 1 (verbose only) and 2 (compact only) appear or go, the past ones too */
  setVerbose(on) {
    if(this.verbose === !!on) return;
    this.verbose = !!on;
    if(this.#closed || this.#held) return;

    this.scrollOff = 0;
    this.#drawHistory();
    this.drawRule();
  }

  scrollBy(n) {
    if(this.#closed || this.#held) return false;

    const height = this.top - 1;
    const max = Math.max(0, this.#shownLines().length + 1 - height);
    const off = Math.max(0, Math.min(max, this.scrollOff - n));
    if(off === this.scrollOff) return false;

    this.scrollOff = off;
    this.#drawHistory();
    this.drawRule();
    return true;
  }

  /** back to the end of the transcript */
  scrollEnd() {
    return this.scrollBy(this.scrollOff);
  }

  /* the transcript rows drawn from the history, ending scrollOff lines before its end */
  #drawHistory() {
    const height = this.top - 1;
    const all = [...this.#shownLines(), this.#cur];
    const end = all.length - this.scrollOff;
    const view = all.slice(Math.max(0, end - height), end);
    let s = SAVE;

    for(let r = 0; r < height; r++) s += `${goto(r + 1)}${CSI}0m${CSI}2K${view[r] !== undefined ? clip(view[r], this.width) : ''}`;
    this.#write(s + RESTORE);
    this.drawPane();

    /* at the end the output goes on after the last line */
    if(this.scrollOff === 0) {
      this.oRow = Math.max(1, view.length);
      this.oCol = stringWidth(this.#cur);
    }
  }

  /** another full-screen view takes over: transcript writes wait, nothing is drawn */
  suspend() {
    this.#held ??= [];
  }

  get suspended() {
    return this.#held !== null;
  }

  /** the layout drawn again (after a resize meanwhile, too), then the held writes */
  resume() {
    const held = this.#held ?? [];
    this.#held = null;

    if(this.#resizePending) {
      this.#resizePending = false;
      this.resize();
    } else this.#layout();

    const kind = this.kind;

    for(const h of held) {
      this.kind = h.kind;
      this.write(h.text);
    }

    this.kind = kind;
  }

  drawRule() {
    if(this.#held) return;
    if(this.scrollOff > 0) {
      const label = `↑ ${this.scrollOff} lines up · PgDn, wheel or any key goes back${this.#activity ? ` · ${this.#activity}` : ''}`;
      return this.#drawRuleLine(`${CSI}7m${clip(` ${label} `.padEnd(this.cols), this.cols)}`);
    }

    if(this.#paintRule) return this.#drawRuleLine(clip(this.#paintRule(this.cols, this.#activity), this.cols));

    const label = this.#activity ? `─ ${this.#activity} ` : '';
    const line = label + '─'.repeat(Math.max(0, this.cols - stringWidth(label)));
    this.#drawRuleLine(`${CSI}2m${clip(line, this.cols)}`);
  }

  /* the rule row, written only when it changed */
  #drawRuleLine(line) {
    const s = this.#ruleRegion.moveTo(this.top, 1, this.cols).update([line]);
    if(s) this.#write(SAVE + s + RESTORE);
  }

  drawStatus() {
    if(this.#closed || this.#held) return;

    const lines = [].concat(this.#status()).map(l => clip(l ?? '', this.cols - 1));
    const s = this.#statusRegion.moveTo(this.rows - this.statusRows + 1, this.statusRows, this.cols).update(lines);

    if(s) this.#write(SAVE + s + RESTORE);
  }

  /** lines in the input rows instead of the line editor (a dialog), cursor hidden until showCursor() */
  drawInput(lines) {
    if(this.#held) return;
    this.ensureInputRows(lines.length);

    this.#write(CSI + '?25l' + this.#inputRegion.moveTo(this.inputTop, this.inputRows, this.cols).update(lines.map(l => clip(l, this.cols - 1))));
    this.drawStatus();
  }

  /**
   * the line editor's text in the input rows, prompt before it, cont
   * before each line after a newline, the cursor at index cursor. only
   * rows that changed are written, nothing below them is erased, so
   * typing does not flicker. `ghost` is a completion hint drawn dark grey
   * after the text; the cursor stays at `cursor`.
   */
  drawEditor(prompt, cont, text, cursor, ghost = '') {
    if(this.#closed || this.#held) return;

    let { lines, row, col } = layoutInput([prompt, cont], text.replaceAll('\t', ' ') + ghost, cursor, this.cols);
    this.ensureInputRows(lines.length);

    /* a completion hint after the text, dark grey, only when it fits on the row of the cursor; the cursor stays before it */
    if(ghost && lines.length && lines[lines.length - 1].endsWith(ghost)) {
      const last = lines.length - 1;
      lines[last] = `${lines[last].slice(0, -ghost.length)}${CSI}38;5;240m${ghost}${CSI}0m`;
    }

    /* more rows than fit: keep the cursor's row in view */
    const skip = Math.max(0, Math.min(row - this.inputRows + 1, lines.length - this.inputRows));
    lines = lines.slice(skip, skip + this.inputRows);

    const s = this.#inputRegion.moveTo(this.inputTop, this.inputRows, this.cols).update(lines);
    this.#write(`${s ? CSI + '?25l' + s : ''}${goto(this.inputTop + row - skip, col + 1)}${CSI}?25h`);
  }

  showCursor() {
    this.#write(CSI + '?25h');
  }

  /** puts the cursor on the first input row, column 1 */
  moveToInput() {
    this.#write(goto(this.inputTop));
  }

  /** Ctrl-L: empty transcript, output from the top again */
  clear() {
    this.scrollOff = 0;
    this.#write(`${CSI}r${CSI}2J`);
    this.oRow = 1;
    this.oCol = 0;
    this.#layout();
  }

  /**
   * makes room for an input of `n` rows (at most half the screen). A
   * taller input scrolls the transcript up, a shorter one gives the rows
   * back to it.
   */
  ensureInputRows(n) {
    n = Math.max(1, Math.min(n, Math.floor(this.rows / 2)));
    if(n === this.inputRows || this.#closed || this.#held) return;

    const grow = n - this.inputRows;
    const oldTop = this.top;

    if(grow > 0) {
      /* scroll the transcript up by grow rows while the region is still the old one */
      this.#write(`${SAVE}${goto(this.top - 1)}${'\n'.repeat(grow)}${RESTORE}`);
      this.oRow = Math.max(1, this.oRow - grow);
    }

    this.inputRows = n;
    /* a shrinking input leaves its old rows above the new rule */
    this.#write(`${SAVE}${goto(Math.min(oldTop, this.top))}${CSI}J${RESTORE}`);
    this.#layout();
  }

  /** after SIGWINCH: new size, layout drawn again */
  resize() {
    if(this.#closed) return;

    if(this.#held) {
      this.#resizePending = true; // drawn on resume(), the full-screen view resizes itself
      return void this.onResize?.(windowSize(this.#out)[0]);
    }

    const oldHeight = this.rows - this.top + 1;
    this.scrollOff = 0;

    [this.cols, this.rows] = windowSize(this.#out);
    this.inputRows = Math.min(this.inputRows, Math.max(1, Math.floor(this.rows / 2)));

    /* the terminal reflowed the old bottom area to somewhere near the new
       one: erase that much above the new rule too, output goes on there */
    const from = Math.max(1, this.top - oldHeight);
    this.#write(`${CSI}r${goto(from)}${CSI}J`);
    this.oRow = from;
    this.oCol = 0;
    this.#layout();
    this.onResize?.(this.cols);
  }

  /** rows the REPL needs for `prompt` and the lines of `cmd` at the current width */
  rowsFor(prompt, cmd, ps2width = 0) {
    let n = 0;

    for(const [k, line] of cmd.split('\n').entries()) n += Math.floor(((k ? ps2width : stringWidth(prompt)) + stringWidth(line)) / this.cols) + 1;

    return n;
  }
}

