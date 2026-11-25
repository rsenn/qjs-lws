/**
 * markdown: renders the model's markdown for the terminal, one line at a
 * time, so a streamed reply is shown as each line completes.
 *
 * ```js
 * const md = new MarkdownStream();
 * stdout.puts(md.push(token));   // complete lines, styled
 * stdout.puts(md.end());         // the rest
 * ```
 *
 *   # Heading        bold, teal (level 1), amber (level 2), bold (3+)
 *   - item, 1. item  colored bullet or number, [ ] [x] as ☐ ☑
 *   > quote          dim bar
 *   ```js ... ```    code in a frame, strings, numbers, comments and
 *                    keywords colored
 *   `code` **b** *i* ~~s~~ [text](url)   inline styles
 */
import { stripAnsi } from 'terminal';

const CSI = '\x1b[';
const fg = hex => `${CSI}38;2;${[1, 3, 5].map(k => parseInt(hex.slice(k, k + 2), 16)).join(';')}m`;

const TEAL = fg('#2dd4bf');
const AMBER = fg('#fbbf24');
const LIME = fg('#a3e635');
const VIOLET = fg('#c084fc');
const GREEN = fg('#4ade80');
const DIM = CSI + '2m';
const BOLD = CSI + '1m';
const RESET = CSI + '0m';

const KEYWORDS = new Set(
  'async await break case catch class const continue def default delete do elif else enum export extends false fn for from func function if impl import in include instanceof let match mut new nil None null pub return self static struct switch this throw true True False try type typeof undefined var void while yield'.split(' '),
);

/* one line of code, colored by token: comments, strings, numbers, keywords */
export function highlight(line) {
  return line.replace(/(\/\/.*$|#(?!include|define)\s.*$|\/\*.*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(\d[\d_.xXa-fA-F]*)\b|\b([A-Za-z_]\w*)\b/g, (m, comment, str, num, word) => {
    if(comment) return DIM + comment + RESET;
    if(str) return LIME + str + RESET;
    if(num) return AMBER + num + RESET;
    return KEYWORDS.has(word) ? VIOLET + word + RESET : word;
  });
}

/* inline markdown of one line: `code` first, so nothing inside it is touched */
export function inline(text) {
  return text
    .split(/(`[^`]+`)/)
    .map((part, k) =>
      k % 2
        ? AMBER + part.slice(1, -1) + RESET
        : part
            .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (m, a, b) => BOLD + (a ?? b) + RESET)
            .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\*)/g, (m, pre, t) => `${pre}${CSI}3m${t}${RESET}`)
            .replace(/~~([^~]+)~~/g, (m, t) => `${CSI}9m${t}${RESET}`)
            .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, t, u) => `${CSI}4m${t}${RESET}${DIM} (${u})${RESET}`),
    )
    .join('');
}

export class MarkdownStream {
  #rest = '';
  #code = null; // language of the open fence, '' for none, null outside

  /** complete lines of text so far, rendered, each ending in \n */
  push(text) {
    const lines = (this.#rest + text).split('\n');
    this.#rest = lines.pop();
    return lines.map(l => this.line(l) + '\n').join('');
  }

  /** whatever is left after the last newline, rendered */
  end() {
    const rest = this.#rest;
    this.#rest = '';
    return rest ? this.line(rest) : '';
  }

  /** one line, with the state of an open code fence */
  line(l) {
    const fence = /^\s*```\s*([\w+-]*)/.exec(l);

    if(fence) {
      if(this.#code === null) {
        this.#code = fence[1];
        return `${DIM}╭─${fence[1] ? ` ${fence[1]} ` : ''}${'─'.repeat(Math.max(2, 40 - fence[1].length))}${RESET}`;
      }

      this.#code = null;
      return `${DIM}╰${'─'.repeat(42)}${RESET}`;
    }

    if(this.#code !== null) return `${DIM}│${RESET} ${highlight(l)}`;

    let m;
    if((m = /^(#{1,6})\s+(.*)$/.exec(l))) return (m[1].length === 1 ? BOLD + TEAL : m[1].length === 2 ? BOLD + AMBER : BOLD) + stripAnsi(inline(m[2])) + RESET;
    if(/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) return DIM + '─'.repeat(40) + RESET;
    if((m = /^(\s*)>\s?(.*)$/.exec(l))) return `${m[1]}${TEAL}▎${RESET} ${DIM}${inline(m[2])}${RESET}`;
    if((m = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(l))) return `${m[1]}${m[2] === ' ' ? '☐' : GREEN + '☑' + RESET} ${inline(m[3])}`;
    if((m = /^(\s*)[-*+]\s+(.*)$/.exec(l))) return `${m[1]}${TEAL}•${RESET} ${inline(m[2])}`;
    if((m = /^(\s*)(\d+)([.)])\s+(.*)$/.exec(l))) return `${m[1]}${TEAL}${m[2]}${m[3]}${RESET} ${inline(m[4])}`;
    if(/^\s*\|.*\|\s*$/.test(l)) return inline(l).replace(/\|/g, DIM + '│' + RESET);

    return inline(l);
  }
}
