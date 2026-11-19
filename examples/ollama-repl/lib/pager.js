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
 * The wheel arrives as mouse reports when the TUI has them on (ChatREPL
 * passes them as up and down keys), else through alternate scroll mode
 * (1007), where the terminal sends it as up and down keys itself.
 */
import { ScrollView, pad, truncate, ttyWrite, windowSize, wrap } from 'terminal';

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
   */
  constructor({ title, text, out, onClose, header }) {
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

    const lines = this.#text.split('\n').flatMap(l => wrap(l, this.cols - 2));
    this.#view = new ScrollView(Math.max(1, this.rows - 2), lines);
    this.#view.follow = false;
    this.#view.scrollTo(offset);
    this.draw();
  }

  resize() {
    if(this.#view) this.#layout(this.#view.offset);
  }

  draw() {
    const v = this.#view;
    const last = Math.min(v.lines.length, v.offset + v.height);
    const where = `${v.lines.length ? v.offset + 1 : 0}-${last} of ${v.lines.length}`;
    const body = v.render(this.cols);
    const foot = `${CSI}2m${truncate(` ${where} · ↑↓ PgUp PgDn Home End wheel · q back`, this.cols)}${CSI}0m`;

    let s = goto(1) + `${CSI}2K` + this.header(this.cols, truncate(this.title, this.cols - 4));
    body.forEach((l, k) => (s += `${goto(k + 2)}${CSI}2K${l}${CSI}0m`));
    s += `${goto(this.rows)}${CSI}2K${foot}`;
    ttyWrite(this.#out, s);
  }

  /** one key from the line editor; returns false once the pager closed */
  key(keys) {
    if(keys === 'q' || keys === 'Q' || keys === '\x1b\x1b' || keys === '\x03') return this.close(), false;

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
