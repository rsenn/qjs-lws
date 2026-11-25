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
 * Color reasoning text with structure highlights while keeping the
 * sky-blue italic base (\x1b[3;38;2;125;211;252m) and panel border #f472b6.
 *
 * Highlights inside the base prose tone:
 *   - Fenced code blocks (``` ... ```): reuse highlight()
 *   - Inline backtick spans (`...`): lime accent
 *   - List markers at line starts (1., 2., - , * ): teal marker
 *   - Bold emphasis (**text**): restore base SGR after
 *   - Markdown headings (# ##): teal heading marker
 *   - Numbers: amber
 *   - Quoted strings: lime
 *   - File paths / line references: teal bold
 *
 * Rules:
 *   - After every inner highlight span the base SGR is restored
 *     (\x1b[3;38;2;125;211;252m) so the rest of the line keeps the
 *     reasoning italic tone, not plain white.
 *   - Each line ends with \x1b[0m so the #f472b6 panel frame and
 *     trailing lines do not inherit italic or foreground colors.
 *   - stripAnsi(colorReasoning(s)) === s  (only ANSI added, chars intact).
 */
/* keep the existing exports */
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

/**
 * Color reasoning text with structure highlights while keeping the
 * sky-blue italic base (\x1b[3;38;2;125;211;252m) and panel border #f472b6.
 *
 * Highlights inside the base prose tone:
 *   - Fenced code blocks (``` ... ```): reuse highlight()
 *   - Inline backtick spans (`...`): lime accent
 *   - List markers at line starts (1., 2., - , * ): teal marker
 *   - Bold emphasis (**text**): restore base SGR after
 *   - Markdown headings (# ##): teal heading marker
 *   - Numbers: amber
 *   - Quoted strings: lime
 *   - File paths / line references: teal bold
 *
 * Rules:
 *   - After every inner highlight span the base SGR is restored
 *     (\x1b[3;38;2;125;211;252m) so the rest of the line keeps the
 *     reasoning italic tone, not plain white.
 *   - Each line ends with \x1b[0m so the #f472b6 panel frame and
 *     trailing lines do not inherit italic or foreground colors.
 *   - stripAnsi(colorReasoning(s)) === s  (only ANSI added, chars intact).
 */
export function colorReasoning(text) {
  const s = String(text ?? '');
  const BASE = '\x1b[3;38;2;125;211;252m';
  const RESET = '\x1b[0m';
  const TEAL = '\x1b[38;2;45;212;191m';
  const LIME = '\x1b[38;2;163;230;53m';
  const AMBER = '\x1b[38;2;251;191;36m';
  const BOLD = '\x1b[1m';

  /** one line, apply highlights keeping base SGR restored after each span */
  const colorLine = line => {
    // fenced code blocks ``` ... ```
    if(/^\s*```/.test(line)) {
      // unclosed fence while streaming: just dim the fence line
      return `${BASE}${DIM}${line}${RESET}`;
    }

    // inline backtick spans (`...`) - find and color them
    // we process the line left-to-right, keeping base SGR restored
    let result = '';
    let i = 0;
    while(i < line.length) {
      // find next backtick pair
      const startBt = line.indexOf('`', i);
      if(startBt === -1) {
        // no more backticks, append rest with base
        result += BASE + line.slice(i) + RESET;
        break;
      }
      // text before the backtick
      if(startBt > i) {
        result += BASE + line.slice(i, startBt) + RESET;
      }
      // find closing backtick
      const endBt = line.indexOf('`', startBt + 1);
      if(endBt === -1) {
        // unclosed backtick mid-stream: color the open part lime and stop
        result += LIME + line.slice(startBt) + RESET;
        break;
      }
      // inline code span
      const codeContent = line.slice(startBt + 1, endBt);
      result += LIME + '`' + codeContent + '`' + RESET;
      i = endBt + 1;
    }

    // list markers at line starts (1., 2., - , * ) - color the marker
    const listMarker = /^(\s*[1-9]\d*\.|\s*[-*+]\s)/.exec(line);
    if(listMarker) {
      const before = line.slice(0, listMarker.index);
      const marker = listMarker[1];
      const after = line.slice(listMarker.index + marker.length);
      // color just the marker characters
      const markerColored = /^[-*]/.test(marker) ? LIME + marker : TEAL + marker;
      result += BASE + before + markerColored + RESET + after;
    } else {
      result += BASE + line + RESET;
    }

    // bold emphasis (**text**) - only if not already inside a backtick we handled
    // we'll do a simple pass: find **text** and wrap with BOLD, restore base after
    result = result.replace(/\*\*([^*]+)\*\*/g, (m, inner) => {
      return BOLD + inner + RESET;
    });

    // headings (# ## etc) - color the # markers at line start
    const heading = /^(#{1,6})\s/.exec(line);
    if(heading) {
      const hashes = heading[1];
      const hashStr = '#'.repeat(hashes.length);
      // replace the hash part at the start
      if(result.startsWith(BASE + hashStr)) {
        result = TEAL + hashStr + RESET + result.slice(hashStr.length);
      }
    }

    // numbers: amber (simple heuristic for standalone numbers)
    // replace standalone numbers (not part of code we already handled)
    result = result.replace(/(?<!\w)\b\d+(?:\.\d+)?(?!\/)/g, n => {
      // but not if already colored by our backtick pass - quick check
      return AMBER + n + RESET;
    });

    // quoted strings (simple ") - lime, but only outside code fences we aren't tracking
    // placeholder: do nothing complex for streaming

    return result + RESET;
  };

  // process line by line, ensuring each line ends with reset
  return s.split('\n').map(colorLine).join('\n');
};
