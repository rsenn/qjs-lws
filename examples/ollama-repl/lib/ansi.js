import { isatty, ttyGetWinSize } from 'os';
import { out as stdout } from 'std';

/* stdout is not a tty: a script or LLM drives the REPL over a pipe (see the
   REPL's "Piped mode"), so output carries no escape sequences. Same test as
   the base REPL's own `piped`. */
export const piped = !isatty(stdout.fileno());

const sgr = code => (piped ? s => s : s => `\x1b[${code}m${s}\x1b[0m`);

export const dim = sgr('2');
export const red = sgr('31');
export const green = sgr('32');
export const yellow = sgr('33');

/** terminal width in columns, or 0 when stdout is not a tty (no wrapping) */
export function termWidth() {
  if(piped) return 0;
  const size = ttyGetWinSize(stdout.fileno());
  return size?.[0] > 0 ? size[0] : 0;
}

/**
 * `prefix` + `text`, word wrapped to the terminal width, every continuation
 * line indented to the column where `text` starts (a hanging indent). A word
 * longer than a whole line is split. `prefix` may contain escape codes: pass
 * its visible width as `prefixWidth`.
 *
 * @param {string} prefix
 * @param {string} text
 * @param {number} [prefixWidth]  visible width of `prefix`
 * @param {number} [width]        columns, default the terminal's (0 = no wrapping)
 */
export function wrapHanging(prefix, text, prefixWidth = prefix.length, width = termWidth()) {
  const room = width - prefixWidth;
  if(width <= 0 || room < 10) return prefix + text;

  const lines = [];
  let line = '';

  for(let word of text.split(/\s+/).filter(Boolean)) {
    while(word.length > room) {
      if(line) lines.push(line), (line = '');
      lines.push(word.slice(0, room));
      word = word.slice(room);
    }
    if(line && line.length + 1 + word.length > room) lines.push(line), (line = word);
    else line = line ? `${line} ${word}` : word;
  }

  if(line || !lines.length) lines.push(line);

  return lines.map((l, i) => (i ? ' '.repeat(prefixWidth) : prefix) + l).join('\n');
}
