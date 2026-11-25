/**
 * pager: a long text full-screen on the alternate screen, scrolled with
 * the keys and the mouse wheel, the transcript untouched behind it.
 *
 * ```js
 * const pager = new Pager({ title: 'edit_file a.txt', text, out: std.out, onClose });
 * pager.open();
 * pager.key('\x1b[6~');   // keys from the line editor, until onClose
 * ```
 *
 *   up/down j/k   one line        PgUp/PgDn space   one page
 *   Home/End g/G  start, end      wheel             3 lines (alternate scroll)
 *   q, Esc Esc, Ctrl-C            back
 *
 * With `select` the lines after the header are rows that can be marked:
 *   up/down j/k   move the cursor   shift+up/down J/K  mark a range from where it started
 *   space         toggle the row     a all, c clear      PgUp/PgDn Home End move a page / to the ends
 *   Enter, e ...  an action key of `select.actions` closes the pager and calls `select.onAction(name, ids)`
 *   left/right    focus a column header: typing filters the rows on that column (all filters must match),
 *                 Backspace deletes, Ctrl-U clears it, down/Enter/Tab go back to the rows, Esc Esc unfocuses
 *                 (in the rows it clears the filters first, then closes). Marks are kept while rows are hidden.
 *
 * The wheel arrives as mouse reports when the TUI has them on (ChatREPL
 * passes them as up and down keys), else through alternate scroll mode
 * (1007), where the terminal sends it as up and down keys itself.
 */
import { ScrollView, pad, stringWidth, truncate, ttyWrite, windowSize, wrap } from 'terminal';
import * as terminal from 'terminal';

/* a frame in synchronized output (mode 2026) where the terminal has it */
const syncWrite = terminal.syncOutput ?? ttyWrite;

const CSI = '\x1b[';
const goto = row => `${CSI}${row};1H`;

const KEYS = {
  '\x1b[A': v => v.scrollBy(-1),
  k: v => v.scrollBy(-1),
  '\x1b[B': v => v.scrollBy(1),
  j: v => v.scrollBy(1),
  '\r': v => v.scrollBy(1),
  '\x1b[5~': v => v.pageUp(),
  b: v => v.pageUp(),
  '\x1b[6~': v => v.pageDown(),
  ' ': v => v.pageDown(),
  '\x1b[H': v => v.home(),
  '\x1b[1~': v => v.home(),
  g: v => v.home(),
  '\x1b[F': v => v.end(),
  '\x1b[4~': v => v.end(),
  G: v => v.end(),
};

export class Pager {
  #out;
  #text;
  #view = null;
  cols = 80;
  rows = 24;

  /**
   * @param {object} o
   * @param {string} o.title     shown in the header
   * @param {string} o.text      the content, escape sequences kept
   * @param {FILE} o.out         the terminal
   * @param {() => void} [o.onClose]
   * @param {(cols: number, label: string) => string} [o.header]  draws the header line
   * @param {{ids: string[], columns?: string[], cell?: (row: number, col: number) => string, build?: (v: {rows: number[], focus: number|null, filters: Map<number, string>}) => string, head?: number, actions: Object<string, [string, string]>, onAction: (name: string, ids: string[]) => void}} [o.select]
   *   ids: one per row after the `head` header lines (default 1); actions: key -> [name, what it does]; the rows are not wrapped.
   *   Filtering needs columns (the header names), cell (the plain text of a cell) and build (the text of the header and the
   *   given rows, the focused header and the filters shown in it)
   */
  constructor({ title, text, out, onClose, header, select, sync = false }) {
    this.sync = sync;
    this.select = select ?? null;
    this.cursor = 0;
    this.marked = new Set();
    this.anchor = null;
    this.base = null;
    /** the column whose header has the focus, and the filter text of each column */
    this.focus = null;
    this.filters = new Map();
    /** the rows (indexes into select.ids) that pass the filters, in order; the cursor is an index into this */
    this.visible = select ? select.ids.map((_, i) => i) : [];
    this.title = title;
    this.#text = String(text).replace(/\n+$/, '');
    this.#out = out;
    this.onClose = onClose;
    this.header = header ?? ((cols, label) => `${CSI}7m${pad(' ' + label, cols)}${CSI}0m`);
  }

  get isOpen() {
    return this.#view !== null;
  }

  open() {
    ttyWrite(this.#out, `${CSI}?1049h${CSI}?1007h${CSI}?25l`);
    this.#layout(0);
    return this;
  }

  /** wraps the text for the current width, keeps the top line where it was */
  #layout(offset) {
    [this.cols, this.rows] = windowSize(this.#out);

    if(this.select) {
      /* a selectable list is not wrapped, and only the rows on the screen are decorated and cut (the cut is the
         slow part: one per row, 613 rows on /model health) */
      const lines = this.#text.split('\n');
      const height = Math.max(1, this.rows - 2);
      const view = {
        lines,
        height,
        offset: 0,
        scrollTo: o => (view.offset = Math.max(0, Math.min(Math.max(0, lines.length - height), o))),
        render: () => Array.from({ length: height }, (_, k) => (view.offset + k < lines.length ? this.#decorate(lines[view.offset + k], view.offset + k) : '')),
      };
      this.#view = view;
      view.scrollTo(offset);
      return this.draw();
    }

    const lines = this.#text.split('\n').flatMap(l => wrap(l, this.cols - 2));
    this.#view = new ScrollView(Math.max(1, this.rows - 2), lines);
    this.#view.follow = false;
    this.#view.scrollTo(offset);
    this.draw();
  }

  /** line i of a selectable list: a cursor and a box in front, a background for the cursor row and a tint for the marked ones */
  #decorate(l, i) {
    const head = this.select.head ?? 1;
    const k = i - head;
    if(k < 0 || k >= this.visible.length) return `     ${l}`;

    const CUR = `${CSI}48;2;30;64;60m`;
    const MARK = `${CSI}48;2;52;40;84m`;
    const here = k === this.cursor;
    const on = this.marked.has(this.visible[k]);
    const bg = here ? CUR : on ? MARK : '';
    const line = truncate(`${here ? `${CSI}1;32m▶${CSI}0m` : ' '}${on ? `${CSI}1;35m[x]${CSI}0m` : `${CSI}2m[ ]${CSI}0m`} ${l}`, this.cols - 1);
    if(!bg) return line;
    return `${bg}${line.replace(/\x1b\[0m/g, `${CSI}0m${bg}`)}${' '.repeat(Math.max(0, this.cols - 1 - stringWidth(line)))}${CSI}0m`;
  }

  /** moves the cursor; with `extend` the rows between where the range started and the cursor are marked */
  #move(to, extend) {
    const n = this.visible.length;
    if(!n) return;
    const next = Math.max(0, Math.min(n - 1, to));

    if(extend) {
      if(this.anchor === null) {
        this.anchor = this.cursor;
        this.base = new Set(this.marked);
      }
      this.cursor = next;
      this.marked = new Set(this.base);
      for(let i = Math.min(this.anchor, next); i <= Math.max(this.anchor, next); i++) this.marked.add(this.visible[i]);
    } else {
      this.anchor = null;
      this.cursor = next;
    }

    this.#relayout();
  }

  /** redraws after the marks or the cursor changed, the cursor row kept in view */
  #relayout() {
    const head = this.select.head ?? 1;
    const h = Math.max(1, this.rows - 2);
    let off = this.#view.offset;
    const at = head + this.cursor;
    if(at < off) off = at;
    if(at >= off + h) off = at - h + 1;
    if(this.cursor < h - head) off = 0;
    this.#layout(off);
  }

  /** the rows that pass every filter; keeps the cursor on the same row when it still passes, rebuilds the text */
  #refilter() {
    const s = this.select;
    const keep = this.visible[this.cursor];
    this.visible = s.ids.map((_, i) => i).filter(r => [...this.filters].every(([c, f]) => String(s.cell(r, c)).toLowerCase().includes(f.toLowerCase())));
    this.cursor = Math.max(0, this.visible.indexOf(keep));
    this.anchor = null;
    this.#rebuild();
  }

  /** the text of the header and the visible rows, with the focus and the filters shown in the header */
  #rebuild() {
    const s = this.select;
    this.#text = s.build ? String(s.build({ rows: this.visible, focus: this.focus, filters: this.filters })).replace(/\n+$/, '') : this.#text;
    if(!this.visible.length) this.#text += `\n${CSI}2m(no row matches the filters)${CSI}0m`;
    this.cursor = Math.min(this.cursor, Math.max(0, this.visible.length - 1));
    this.#relayout();
  }

  /** a key while a column header has the focus: it edits that column's filter */
  #filterKey(keys) {
    const s = this.select;
    const n = s.columns.length;

    if(keys === '\x1b[D') this.focus = Math.max(0, this.focus - 1);
    else if(keys === '\x1b[C') this.focus = Math.min(n - 1, this.focus + 1);
    else if(keys === '\x1b[B' || keys === '\r' || keys === '\n' || keys === '\t' || keys === '\x1b\x1b') this.focus = null;
    else if(keys === '\x7f' || keys === '\b') {
      const f = (this.filters.get(this.focus) ?? '').slice(0, -1);
      if(f) this.filters.set(this.focus, f);
      else this.filters.delete(this.focus);
      return this.#refilter();
    } else if(keys === '\x15') {
      this.filters.delete(this.focus);
      return this.#refilter();
    } else if(/^[^\x00-\x1f\x7f]+$/.test(keys)) {
      this.filters.set(this.focus, (this.filters.get(this.focus) ?? '') + keys);
      return this.#refilter();
    } else return;

    this.#rebuild();
  }

  #selectKey(keys) {
    const s = this.select;
    const page = Math.max(1, this.rows - 4);

    if(s.columns && this.focus !== null) return this.#filterKey(keys);

    if(s.columns && (keys === '\x1b[D' || keys === '\x1b[C' || keys === 'f' || keys === '/')) {
      this.focus = keys === '\x1b[D' ? s.columns.length - 1 : 0;
      return this.#rebuild();
    }

    if(keys === '\x1b[A' || keys === 'k') return this.#move(this.cursor - 1, false);
    if(keys === '\x1b[B' || keys === 'j') return this.#move(this.cursor + 1, false);
    if(keys === '\x1b[1;2A' || keys === 'K') return this.#move(this.cursor - 1, true);
    if(keys === '\x1b[1;2B' || keys === 'J') return this.#move(this.cursor + 1, true);
    if(keys === '\x1b[5~' || keys === 'b') return this.#move(this.cursor - page, false);
    if(keys === '\x1b[6~') return this.#move(this.cursor + page, false);
    if(keys === '\x1b[H' || keys === '\x1b[1~' || keys === 'g') return this.#move(0, false);
    if(keys === '\x1b[F' || keys === '\x1b[4~' || keys === 'G') return this.#move(this.visible.length - 1, false);

    if(keys === ' ') {
      const r = this.visible[this.cursor];
      if(r === undefined) return;
      this.anchor = null;
      if(!this.marked.delete(r)) this.marked.add(r);
      return this.#relayout();
    }
    if(keys === 'a') {
      for(const r of this.visible) this.marked.add(r);
      this.anchor = null;
      return this.#relayout();
    }
    if(keys === 'c') {
      this.marked = new Set();
      this.anchor = null;
      return this.#relayout();
    }

    const act = s.actions[keys] ?? (keys === '\n' ? s.actions['\r'] : null);
    if(act) {
      const rows = this.marked.size ? [...this.marked].sort((a, b) => a - b) : this.visible.length ? [this.visible[this.cursor]] : [];
      if(!rows.length) return;
      this.close();
      s.onAction(act[0], rows.map(i => s.ids[i]));
    }
  }

  resize() {
    if(this.#view) this.#layout(this.#view.offset);
  }

  draw() {
    const v = this.#view;
    const last = Math.min(v.lines.length, v.offset + v.height);
    const where = `${v.lines.length ? v.offset + 1 : 0}-${last} of ${v.lines.length}`;
    const body = v.render(this.cols);
    const sel = this.select;
    const hidden = sel ? [...this.marked].filter(r => !this.visible.includes(r)).length : 0;
    const foot = sel
      ? this.focus !== null
        ? `${CSI}2m${truncate(` filter ${sel.columns[this.focus]}: ${CSI}0m${CSI}33m${this.filters.get(this.focus) ?? ''}${CSI}5m▏${CSI}0m${CSI}2m · type to filter · ←→ column · Backspace · Ctrl-U clear · ↓/Enter rows · Esc Esc unfocus`, this.cols)}${CSI}0m`
        : `${CSI}2m${truncate(` ${this.marked.size} marked${hidden ? ` (${hidden} hidden)` : ''}${this.filters.size ? ` · ${this.visible.length} of ${sel.ids.length} rows` : ''} · space toggle · shift+↑↓ range · a all · c clear${sel.columns ? ' · ←→ filter' : ''} · ${Object.entries(sel.actions).map(([k, [, what]]) => `${k === '\r' ? 'Enter' : k} ${what}`).join(' · ')} · q back`, this.cols)}${CSI}0m`
      : `${CSI}2m${truncate(` ${where} · ↑↓ PgUp PgDn Home End wheel · q back`, this.cols)}${CSI}0m`;

    let s = goto(1) + `${CSI}2K` + this.header(this.cols, truncate(this.title, this.cols - 4));
    body.forEach((l, k) => (s += `${goto(k + 2)}${CSI}2K${l}${CSI}0m`));
    s += `${goto(this.rows)}${CSI}2K${foot}`;
    (this.sync ? syncWrite : ttyWrite)(this.#out, s);
  }

  /** one key from the line editor; returns false once the pager closed */
  key(keys) {
    if(keys === '\x03') return this.close(), false;

    /* in a column filter the letters are text; Esc Esc ends it. In the rows Esc Esc clears the filters before it closes */
    if(this.select?.columns && this.focus !== null) {
      this.#selectKey(keys);
      return this.isOpen;
    }
    if(this.select?.columns && keys === '\x1b\x1b' && this.filters.size) {
      this.filters.clear();
      this.#refilter();
      return true;
    }

    if(keys === 'q' || keys === 'Q' || keys === '\x1b\x1b') return this.close(), false;

    if(this.select) {
      this.#selectKey(keys);
      return this.isOpen;
    }

    const f = KEYS[keys];
    if(f) {
      f(this.#view);
      this.draw();
    }

    return true;
  }

  close() {
    if(!this.#view) return;

    this.#view = null;
    ttyWrite(this.#out, `${CSI}?1007l${CSI}?25h${CSI}?1049l`);
    this.onClose?.();
  }
}
