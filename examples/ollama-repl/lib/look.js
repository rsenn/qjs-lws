/**
 * look: the visual style of the ollama-repl TUI - a teal to amber
 * gradient, rounded panels, meters - built from qjs-modules' terminal
 * widgets. Everything returns strings, nothing is written here.
 *
 * ```js
 * console.log(banner([['model', 'qwen']], ['/help lists commands'], 100));
 * console.log(panel('request #3', formatMeta(meta), tui.width));
 * ```
 */
import { BOX_ROUNDED, bigText, boxLines, gradient, keyValue, pad, progressBar, rule, stringWidth, stripAnsi, style, wrap } from 'terminal';
import { getenv } from 'std';
import { piped } from './ansi.js';

/** colors of the gradient, the accent is its first stop */
export const STOPS = ['#2dd4bf', '#a3e635', '#fbbf24'];
export const ACCENT = STOPS[0];
export const WARN = STOPS[2];

/** the marker in front of a model reply: waves rising into the sun, in the gradient (single-width glyphs only) */
export const replyMark = () => `${gradient('≋≈☼', STOPS)} `;

/** the marker in front of a line that arrived over the control socket, instead of a typed one */
export const remoteMark = () => `${style('⇄', { fg: ACCENT })} ${style('remote', { fg: ACCENT, bold: true })} ${style('❯', { fg: STOPS[1] })}`;

/** the text of a remote line: dark grey, so the marker stands out */
export const remoteText = text => style(text, { fg: '#8a8a8a' });

/** the control socket line: where it listens and how to talk to it, in colour */
export const controlNote = (path, name) => (piped ? `(control socket: ${path}, session name: ${name} - ollama-repl-ctl -s ${name} send ...)` : `${style('⇄', { fg: ACCENT })} ${style('control socket', { fg: ACCENT, bold: true })} ${style(path, { dim: true })} ${style('·', { dim: true })} ${style('session', { fg: ACCENT })} ${style(name, { fg: STOPS[1], bold: true })} ${style('·', { dim: true })} ${style(`ollama-repl-ctl -s ${name} send …`, { fg: WARN })}`);

/** the colour of every file name: between pink and magenta */
export const FILE = '#f472d0';

/** colours of the generic highlighter: token counts, sizes, times, other numbers, arrows */
export const TOKENS = '#38bdf8';
export const SIZES = '#a78bfa';
export const TIMES = '#fbbf24';
export const NUMBERS = '#fdba74';
export const ARROWS = '#a3e635';

const N = String.raw`\d[\d.,]*`;
const HL_RE = new RegExp(
  [
    String.raw`(?<path>(?:~?\.{0,2}\/)?(?:[\w.@+-]+\/)+[\w.@+-]*|\b[\w-]+\.(?:js|mjs|cjs|ts|json|md|c|h|cc|cpp|hpp|txt|sh|ya?ml|html|css|py|log|cmake)\b)`,
    String.raw`(?<arrow>->|=>|<-)`,
    String.raw`(?<tok>~?\b${N}[kM]?(?:\+${N}[kM]?)?(?= (?:tok|tokens|reasoning|cached|in|out)\b))`,
    String.raw`(?<size>~?\b${N}[kKMG]?B?(?= (?:chars|bytes|[KMG]B)\b)|~?\b${N}[KMG]B\b|~?\b${N}G\b)`,
    String.raw`(?<time>~?\b\d+(?:\.\d+)?(?:ms|min|s|m|h|d)\b)`,
    String.raw`(?<num>~?\b${N}[kMG]?\b)`,
  ].join('|'),
  'g'
);

const ARROW = { '->': '→', '=>': '⇒', '<-': '←' };
const HL = { path: FILE, tok: TOKENS, size: SIZES, time: TIMES, num: NUMBERS, arrow: ARROWS };

/**
 * Generic highlighter: file names in the file colour, token counts, sizes, times and other numbers each in
 * their own, arrows drawn as → ⇒ ←; everything else in `base` (a style, may be empty).
 *
 * @param {string} text
 * @param {object} [base]  style of the remaining text
 */
export function highlight(text, base = {}) {
  if(piped) return String(text);
  let out = '';
  let at = 0;

  for(const m of String(text).matchAll(HL_RE)) {
    const kind = Object.keys(m.groups).find(k => m.groups[k] !== undefined);
    if(m.index > at) out += style(text.slice(at, m.index), base);
    out += style(kind === 'arrow' ? ARROW[m[0]] : m[0], kind === 'arrow' ? { fg: ARROWS, bold: true } : { fg: HL[kind] });
    at = m.index + m[0].length;
  }

  return out + (at < text.length ? style(text.slice(at), base) : '');
}

/** kept for the callers that name it so: the highlighter with a base style */
export const paintText = (text, base = {}) => highlight(text, base);

/** a file name or path in the file colour */
export const file = text => style(text, { fg: FILE });

/** "label: rest": the label bold in `color`, the rest painted (file names, numbers) */
function labelled(text, color) {
  const m = /^([A-Za-z][\w ]{1,24}):( [^]*)?$/.exec(text);
  if(!m) return paintText(text, { fg: '#cbd5e1' }, true);
  return `${style(m[1] + ':', { fg: color, bold: true })}${m[2] ? paintText(m[2], { fg: '#cbd5e1' }, true) : ''}`;
}

/** icon and colour of each kind of note() */
const NOTES = { info: ['ⓘ', ACCENT], ok: ['✓', '#4ade80'], warn: ['⚠', WARN], skip: ['⤼', STOPS[1]], attach: ['📎', ACCENT], link: ['⇄', ACCENT], wait: ['◌', ACCENT], resume: ['↻', STOPS[1]], quit: ['⏻', WARN] };

/** a one-line message: an icon in the accent colour, then the text dimmed; piped, the old `(text)` */
export const note = (text, kind = 'info') => (piped ? `(${text})` : `${style(NOTES[kind][0], { fg: NOTES[kind][1] })} ${labelled(text, NOTES[kind][1])}`);

/** a status note: a wave in the accent colour, then the text dimmed */
export const waveNote = text => `${style('≋', { fg: ACCENT })} ${labelled(text, ACCENT)}`;

/** a horizontal line in the gradient, with an optional label */
export const gradientRule = (cols, label = '') => gradient(rule(cols, { label }), STOPS);

/**
 * text in a rounded box with a bold title, at most cols - 1 wide
 *
 *   ╭─ request #3 ──────╮
 *   │ model  qwen3-coder │
 *   ╰───────────────────╯
 */
export function panel(title, text, cols, { border = ACCENT, max = Infinity, more } = {}) {
  let lines = String(text).replace(/\n+$/, '').split('\n');
  if(lines.length > max) lines = [...lines.slice(0, max), style(more?.(lines.length - max) ?? `… ${lines.length - max} more lines`, { dim: true })];

  const width = Math.max(10, Math.min(cols - 1, Math.max(...lines.map(stringWidth), stringWidth(title) + 4) + 4));

  return boxLines(lines, { title: style(title, { bold: true }), width, chars: BOX_ROUNDED, border: { fg: border } }).join('\n');
}

/** lines of left and right next to each other, right starting gap cells after the widest left line */
export function sideBySide(left, right, gap = 3) {
  const w = Math.max(0, ...left.map(stringWidth));

  return Array.from({ length: Math.max(left.length, right.length) }, (_, k) => pad(left[k] ?? '', w) + ' '.repeat(gap) + (right[k] ?? '')).map(l => l.replace(/ +$/, ''));
}

/**
 * the startup screen and /about: the name in block letters, the facts
 * of the session in a panel beside it (below it on a narrow terminal),
 * a green status line and numbered tips
 */
export function banner(rows, tips, cols) {
  const name = cols >= 66 ? gradient(bigText('ollama-repl', { half: true }), STOPS) : [gradient(style('ollama-repl', { bold: true }), STOPS)];
  const nameWidth = Math.max(...name.map(stringWidth));
  const beside = cols - nameWidth - 3 >= 44;
  const info = keyValue(rows, { keyStyle: { fg: ACCENT, bold: true }, width: (beside ? cols - nameWidth - 3 : cols) - 8 });
  const box = panel('about', info.join('\n'), beside ? cols - nameWidth - 3 : cols).split('\n');
  const top = beside ? sideBySide(['', ...name], box) : [...name, '', ...box];
  const tip = (t, k) => `${style(`${k + 1}.`, { fg: ACCENT })} ${t.replace(/\/[a-z-]+/g, c => style(c, { fg: WARN, bold: true }))}`;

  return [...top, '', `${style('●', { fg: '#4ade80' })} ${style('session initialized', { fg: '#4ade80' })}`, '', style('Tips for getting started:', { bold: true }), ...tips.map(tip), ''].join('\n');
}

/** text that already is a panel (starts with a rounded corner) */
const isPanel = text => /^(\x1b\[[\d;]*m)*╭/.test(text);

/**
 * the output of a /command as a panel titled with the command line.
 * red border for errors, "key: value" lines get colored keys, a single
 * "(note)" line loses its parentheses.
 */
export function reportPanel(title, text, cols, opts = {}) {
  text = text.replace(/\n+$/, '');
  if(isPanel(text)) return text;

  const plain = stripAnsi(text);
  const error = /^error\b/m.test(plain) || text.includes('\x1b[31m');
  if(!plain.includes('\n') && /^\(.*\)$/.test(plain)) text = plain.slice(1, -1);

  text = text.replace(/^([a-z][a-z /-]{0,18}):( +|$)/gm, (m, k, sp) => style(k + ':', { fg: ACCENT }) + sp);
  return panel(title, text, cols, { ...opts, border: error ? '#f87171' : ACCENT });
}

const HELP_KEY = 24;

/** one command of /help: the command in a fixed column, its text wrapped beside it, a long command on its own line */
function helpEntry(cmd, text, width) {
  const key = style(cmd, { fg: ACCENT, bold: true });
  const body = wrap(text, Math.max(20, width - HELP_KEY - 4));
  const indent = ' '.repeat(HELP_KEY + 4);

  if(stringWidth(cmd) > HELP_KEY) return ['  ' + key, ...body.map(l => indent + l)];
  return body.map((l, k) => (k ? indent : '  ' + pad(key, HELP_KEY) + '  ') + l);
}

/**
 * HELP_TEXT ("/cmd ARGS - what it does" per line) as a panel with
 * sections, each command highlighted and its text wrapped beside it
 */
export function helpPanel(helpText, sections, cols) {
  const entries = helpText.split('\n').map(l => {
    const k = l.indexOf(' - ');
    return k > 0 && l.startsWith('/') ? [l.slice(0, k).trim(), l.slice(k + 3)] : [null, l];
  });
  const width = cols - 6;
  const used = new Set();
  const out = [];

  for(const [title, names] of sections) {
    const rows = entries.filter(([c]) => c && names.some(n => c === n || c.startsWith(n + ' ') || c.startsWith(n + ',')));
    if(!rows.length) continue;

    rows.forEach(r => used.add(r));
    out.push(style(title, { bold: true, fg: WARN }), ...rows.flatMap(([c, t]) => helpEntry(c, t, width)), '');
  }

  const rest = entries.filter(r => r[0] && !used.has(r));
  if(rest.length) out.push(style('more', { bold: true, fg: WARN }), ...rest.flatMap(([c, t]) => helpEntry(c, t, width)), '');
  out.push(...entries.filter(([c, t]) => !c && t).map(([, t]) => style(t, { dim: true })));

  return panel('help', out.join('\n'), cols);
}

const num = n => style(String(n ?? '').padStart(4), { dim: true });

/**
 * a write tool's change, colored, with the file's line numbers
 *
 *     12 - old line
 *     12 + new line
 *
 * content is the file as it is now, before the change (after false) or
 * after it, to find the line. write_file shows the new content.
 */
export function numberedDiff(name, args, content, after) {
  const lineOf = s => {
    const k = s && content ? content.indexOf(s) : -1;
    return k < 0 ? null : content.slice(0, k).split('\n').length;
  };
  const rows = (text, sign, from) => String(text ?? '').split('\n').map((l, k) => style(`${num(from == null ? null : from + k)} ${sign} ${l}`, { fg: sign === '+' ? '#4ade80' : '#f87171' }));

  if(name === 'edit_file') {
    const at = lineOf(after ? args.new_string : args.old_string);
    return [...rows(args.old_string, '-', at), ...rows(args.new_string, '+', at)].join('\n');
  }

  if(name === 'insert_above') return [style(`${num(lineOf(args.anchor))}   above: ${args.anchor ?? '?'}`, { dim: true }), ...rows(args.text, '+', after ? lineOf(args.text) : lineOf(args.anchor))].join('\n');
  if(name === 'write_file') return rows(args.content, '+', 1).join('\n');
  return '';
}

/** what a tool call works on, for its one-line summary */
export function toolTarget(name, args = {}) {
  if(name === 'run_command') return `$ ${args.command ?? ''}`;
  if(name === 'grep') return `${args.pattern ?? ''}${args.path ? ` in ${args.path}` : ''}`;
  if(name === 'ask_user') return args.question ?? '';
  if(name === 'for_each') return `${(args.items ?? []).length} items: ${args.task ?? ''}`;
  return args.path ?? args.file ?? Object.values(args).filter(v => typeof v == 'string')[0] ?? '';
}

/** ● tool target, the line shown when the model calls a tool */
export const toolLine = (name, args) => `${style('●', { fg: ACCENT })} ${style(name, { bold: true })} ${name === 'run_command' || name === 'ask_user' ? toolTarget(name, args) : paintText(toolTarget(name, args))}`;

/** ⎿ what came back: the first line if short, else its size; errors red */
export function toolResult(output) {
  const text = String(output ?? '');
  const lines = text.split('\n');
  const error = /^error\b/.test(text);
  const shown = lines.length === 1 && text.length <= 100 ? text : `${lines.length} lines, ${text.length} chars`;

  return `  ${style('⎿', { dim: true })} ${error ? style(shown, { fg: '#f87171' }) : highlight(shown, { dim: true })}`;
}

/** fraction as a bar of width cells, green, amber from 60 %, red from 85 % */
export function meter(fraction, width) {
  const f = Math.max(0, Math.min(1, fraction || 0));
  const fg = f >= 0.85 ? '#f87171' : f >= 0.6 ? WARN : '#4ade80';

  return progressBar(f, width, { style: { fg }, empty: '·', emptyStyle: { dim: true } });
}

/** the mode as a colored badge, code is an SGR color (MODE_COLOR) */
export const modeBadge = (mode, code) => `\x1b[1;7;${code}m ${mode} \x1b[0m`;

/**
 * path with the home directory as ~, cut at the left to max cells
 *
 *   shortPath('/home/u/src/a/b')      // '~/src/a/b' with HOME=/home/u
 *   shortPath('/home/u/src/a/b', 6)   // '…c/a/b'
 */
export function shortPath(path, max = Infinity) {
  const home = getenv('HOME');
  const p = home && (path === home || path.startsWith(home + '/')) ? '~' + path.slice(home.length) : path;

  return p.length > max ? '…' + p.slice(p.length - max + 1) : p;
}
