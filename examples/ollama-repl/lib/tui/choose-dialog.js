/**
 * The state machine of `ChatREPL#choose()`'s dialog without the terminal: which options show, how the window
 * scrolls, what a key does. `d` is the dialog object `{ options, plain, filter, filterable, sel, top, view }`;
 * `dialogKey` changes it and says whether the key finished the dialog.
 */

/** the index an answer typed or sent by the control socket means: a number, y = the first, anything else = the last */
export const pickAnswer = (answer, count) => {
  const s = String(answer ?? '').trim();
  return /^\d+$/.test(s) && +s >= 1 && +s <= count ? +s - 1 : /^y(es)?$/i.test(s) ? 0 : count - 1;
};

/** the options (indexes) a filterable dialog shows: those holding every word typed, and always the last one */
export function visibleOptions(d) {
  const all = d.options.map((_, i) => i);
  const words = d.filter.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? all.filter(i => i === all.length - 1 || words.every(w => d.plain[i].includes(w))) : all;
}

/** a long list scrolls: sets d.sel and d.top so the selection stays in view, returns how many rows show */
export function scrollWindow(d, count, terminalRows = 30) {
  const room = Math.max(5, terminalRows - 9);
  const rows = Math.min(count, room);

  d.sel = Math.min(d.sel, count - 1);
  d.top = Math.max(0, Math.min(d.top ?? 0, count - rows));
  if(d.sel < d.top) d.top = d.sel;
  if(d.sel >= d.top + rows) d.top = d.sel - rows + 1;
  return rows;
}

/**
 * One key in the dialog.
 *
 * @returns {{finish: number}|{view: true}|null} finish: the dialog ends with this option; view: show all; null: redraw
 */
export function dialogKey(d, keys, terminalRows = 30) {
  if(keys === 'v' && d.view && !d.filterable) return { view: true };

  const vis = visibleOptions(d);
  const n = vis.length;
  const filtering = d.filterable;
  const page = Math.max(3, terminalRows - 12);

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
  else if(keys === '\x1b[6~') d.sel = Math.min(n - 1, d.sel + page);
  else if(keys === '\x1b[5~') d.sel = Math.max(0, d.sel - page);
  else if(keys === '\x1b[H' || keys === '\x1b[1~') d.sel = 0;
  else if(keys === '\x1b[F' || keys === '\x1b[4~') d.sel = n - 1;
  else if(keys === '\r' || keys === '\n') return { finish: vis[d.sel] };
  else if(!filtering && /^[1-9yYnN]$/.test(keys)) return { finish: pickAnswer(keys, d.options.length) };
  else if(keys === '\x1b\x1b' || keys === '\x03') return { finish: d.options.length - 1 };

  return null;
}
