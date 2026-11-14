/* Help-text formatting: a usage table (rows of [flag, description], or a
   plain string for a heading line) rendered with the flag column padded
   and the description word-wrapped to the terminal width. */
import { ttyGetWinSize } from 'misc';

/* terminal width, or 80 when stdout is not a tty (piped, redirected). */
function termWidth() {
  try {
    const w = ttyGetWinSize(1)?.[0];
    if(w > 0) return w;
  } catch(e) {}
  return 80;
}

export function lineWrap(str, max = termWidth()) {
  const result = [];
  let line = '';

  for(const word of str.split(/\s+/g)) {
    if(line.length && word.length + 1 + line.length > max) {
      result.push(line);
      line = '';
    }
    line += (line.length ? ' ' : '') + word;
  }

  if(line.length > 0) result.push(line);
  return result;
}

export function formatUsage(table, column = 16) {
  const width = termWidth();
  const lines = [];

  for(let line of table) {
    if(Array.isArray(line) && line.length < 2) line = line[0] ?? '';
    if(typeof line == 'string') {
      lines.push(...lineWrap(line, width));
      continue;
    }
    {
      const [arg, desc] = line;
      let pad;
      if(arg.length >= column) {
        lines.push('  ' + arg);
        line = ' '.repeat(column + 2);
        pad = column + 2;
      } else {
        line = '  ' + arg.padEnd(column, ' ');
        pad = line.length;
      }
      let i = 0;
      for(const l of lineWrap(desc ?? '', width - pad)) {
        if(i++ > 0) {
          lines.push(line);
          line = ' '.repeat(pad);
        }
        line += l;
      }
    }

    lines.push(line);
  }

  return lines.join('\n');
}
