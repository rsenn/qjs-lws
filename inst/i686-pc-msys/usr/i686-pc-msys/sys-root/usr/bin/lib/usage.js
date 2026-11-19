/* Help-text formatting. A usage table is a list of rows:
     'text'            plain line, word-wrapped ('' = blank line)
     '@Title'          section heading (bold)
     [flag, desc]      option: flag in a padded column (green), desc
                       word-wrapped beside it, a flag wider than the
                       column goes on its own line above the desc
   Colors apply on a tty only; width is 80 when not a tty. */
import { ttyGetWinSize, isatty } from 'os';
import { out as stdout } from 'std';

const tty = isatty(stdout.fileno());
const sgr = code => (tty ? s => `\x1b[${code}m${s}\x1b[0m` : s => s);
const bold = sgr('1');
const green = sgr('32');

function termWidth() {
  try {
    const w = tty ? ttyGetWinSize(stdout.fileno())?.[0] : 0;
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

export function formatUsage(table, column = 24) {
  const width = termWidth() - 1;
  const pad = column + 4;
  const lines = [];

  for(const row of table) {
    if(typeof row == 'string') {
      if(row[0] == '@') lines.push(bold(row.slice(1) + ':'));
      else if(row === '') lines.push('');
      else lines.push(...lineWrap(row, width));
      continue;
    }

    const [arg, desc] = row;
    let first = '  ' + green(arg) + ' '.repeat(Math.max(2, column + 2 - arg.length));

    if(arg.length > column) {
      lines.push('  ' + green(arg));
      first = ' '.repeat(pad);
    }

    let i = 0;
    for(const l of lineWrap(desc ?? '', width - pad)) {
      lines.push((i++ ? ' '.repeat(pad) : first) + l);
    }
    if(!i) lines.push(first.trimEnd());
  }

  return lines.join('\n');
}
