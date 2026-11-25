/**
 * rawcolor: colors for the raw content Ctrl-O verbose mode shows - what
 * goes to the model, what it calls, what the tools and the gateway answer.
 * Pure string functions in the look.js palette (teal keys, lime strings,
 * amber numbers, violet literals); nothing is written here.
 *
 * Except colorArgs() they never change the visible text: stripping the
 * escape sequences gives back the input (test-rawcolor.js checks it).
 *
 * ```js
 * showPanel('tool result', colorContent(output, { code: name === 'read_file' }));
 * ```
 */
import { highlight } from './markdown.js';

const CSI = '\x1b[';
const fg = hex => `${CSI}38;2;${[1, 3, 5].map(k => parseInt(hex.slice(k, k + 2), 16)).join(';')}m`;

const TEAL = fg('#2dd4bf');
const LIME = fg('#a3e635');
const AMBER = fg('#fbbf24');
const VIOLET = fg('#c084fc');
const GREEN = fg('#4ade80');
const RED = fg('#f87171');
const DIM = `${CSI}2m`;
const BOLD = `${CSI}1m`;
const RESET = `${CSI}0m`;

const paint = (color, s) => (s === '' ? s : `${color}${s}${RESET}`);

/**
 * JSON text, one line at a time: keys teal, strings lime, numbers amber,
 * true/false/null violet, punctuation dim. Works on a fragment too.
 */
export function colorJson(text) {
  return String(text).replace(/("(?:[^"\\\n]|\\.)*")(\s*:)?|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|\b(true|false|null)\b|([{}[\],:])/g, (m, str, colon, num, lit, punct) => {
    if(str) return colon ? paint(TEAL, str) + paint(DIM, colon) : paint(LIME, str);
    if(num) return paint(AMBER, num);
    if(lit) return paint(VIOLET, lit);
    return paint(DIM, punct);
  });
}

/** whether text is one JSON object or array */
const isJson = text => {
  const t = text.trim();
  if(!/^[{[]/.test(t) || t.length > 200000) return false;

  try {
    JSON.parse(t);
    return true;
  } catch(e) {
    return false;
  }
};

/**
 * Text of a message or a tool result, colored by what each line is: a JSON
 * document, a fenced code block (code highlighted), diff lines (+ green, -
 * red, @@ violet), `File: path` headers, grep style `path:line:text`,
 * error lines (red) and the [handoff]/[compacted] notes. `code` highlights
 * every line as source (a file read by read_file).
 */
export function colorContent(text, { code = false } = {}) {
  const s = String(text ?? '');
  if(isJson(s)) return s.split('\n').map(colorJson).join('\n');

  let fenced = false;

  return s
    .split('\n')
    .map(line => {
      if(/^\s*```/.test(line)) {
        fenced = !fenced;
        return paint(DIM, line);
      }

      if(fenced || code) return highlight(line);

      if(/^(diff --git|index |\+\+\+ |--- )/.test(line)) return paint(BOLD, line);
      if(/^@@/.test(line)) return paint(VIOLET, line);
      if(/^\+/.test(line)) return paint(GREEN, line);
      if(/^-/.test(line) && !/^-{3,}\s*$/.test(line)) return paint(RED, line);

      const file = /^(File: )(.+)$/.exec(line);
      if(file) return paint(DIM, file[1]) + paint(`${BOLD}${TEAL}`, file[2]);

      const grep = /^([^\s:][^\s:]*):(\d+):(.*)$/.exec(line);
      if(grep) return `${paint(TEAL, grep[1])}${paint(DIM, ':')}${paint(AMBER, grep[2])}${paint(DIM, ':')}${grep[3]}`;

      if(/^\s*(error|Error|FAIL|fatal)\b/.test(line)) return paint(RED, line);
      if(/^\[(handoff|compacted)\]/.test(line)) return paint(VIOLET, line);
      if(/^\(.*\)$/.test(line)) return paint(DIM, line);
      return line;
    })
    .join('\n');
}

/**
 * A tool call's arguments: JSON, but a string with line breaks (the text
 * an edit puts in, a file written) is shown as a block of lines below its
 * key, code highlighted, instead of one line of \n escapes.
 */
export function colorArgs(args) {
  const entries = Object.entries(args ?? {});
  if(!entries.length) return paint(DIM, '(no arguments)');

  return entries
    .map(([key, value]) => {
      const head = `${paint(TEAL, key)}${paint(DIM, ':')}`;
      if(typeof value === 'string' && value.includes('\n')) return `${head}\n${value.split('\n').map(l => `${paint(DIM, '│')} ${highlight(l)}`).join('\n')}`;
      return `${head} ${colorJson(JSON.stringify(value))}`;
    })
    .join('\n');
}

/**
 * The lines of formatMeta() (`key   value`, then `headers` and indented
 * `x-name: value`): keys dim, a status by class (2xx green, 4xx amber,
 * 5xx red), routes and names teal, numbers with units amber.
 */
export function colorMeta(text) {
  let inHeaders = false;

  return String(text ?? '')
    .split('\n')
    .map(line => {
      if(line === 'headers') {
        inHeaders = true;
        return paint(DIM, line);
      }

      if(inHeaders) {
        const h = /^(\s+)([^:]+)(:\s*)(.*)$/.exec(line);
        return h ? `${h[1]}${paint(VIOLET, h[2])}${paint(DIM, h[3])}${h[4]}` : line;
      }

      const m = /^(\S[\S ]{0,10}?)(\s+)(.*)$/.exec(line);
      if(!m) return line;

      const [, key, gap, value] = m;
      let v = value;

      if(key.trim() === 'status') {
        const code = parseInt(value, 10);
        v = paint(code >= 500 ? RED : code >= 400 ? AMBER : GREEN, value);
      } else if(/^(requested|model|routed via|platform|provider|trail)/.test(key)) v = paint(TEAL, value);
      else v = value.replace(/\b\d[\d.,]*(?:ms|s|k|M|%)?\b/g, n => paint(AMBER, n));

      return `${paint(DIM, key)}${gap}${v}`;
    })
    .join('\n');
}
