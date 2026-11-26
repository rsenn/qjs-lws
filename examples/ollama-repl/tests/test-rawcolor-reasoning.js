/* test-rawcolor-reasoning.js: colorReasoning (lib/rawcolor.js) only adds colour, in the palette's colours */
import { colorReasoning } from '../lib/rawcolor.js';
import { PROSE, INLINE_CODE, CODE_STRING, HEADER, CODE_FENCE } from '../lib/palette.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-rawcolor-reasoning: ${what}`);
};
const rgb = hex => `\x1b[38;2;${[1, 3, 5].map(k => parseInt(hex.slice(k, k + 2), 16)).join(';')}m`;
const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');

const basic = colorReasoning('Hello world');
check('prose colour and a reset', basic.startsWith(rgb(PROSE)) && basic.endsWith('\x1b[0m'));

check('inline code in its colour, prose restored after', colorReasoning('Hello `code` world').includes(`${rgb(INLINE_CODE)}\`code\`${rgb(PROSE)} world`));
check('quoted string in the code colour', colorReasoning('He said "hello"').includes(`${rgb(INLINE_CODE)}"hello"`));
check('bold', colorReasoning('Hello **bold** world').includes('\x1b[1m**bold**'));
check('numbers', colorReasoning('The value is 42 and 3.14').includes(`${rgb(CODE_STRING)}42`) && colorReasoning('x 3.14').includes(`${rgb(CODE_STRING)}3.14`));
check('heading marker in the header colour', colorReasoning('# Title\n## Sub').includes(`${rgb(HEADER)}#`));
check('a fence line in the fence colour', colorReasoning('```\nx = 1\n```').split('\n')[0].includes(rgb(CODE_FENCE)));

/* every line ends with a reset, so the frame around the panel does not inherit a colour */
for(const [i, line] of colorReasoning('line1\nline2\nline3').split('\n').entries()) check(`line ${i} ends with a reset`, line.endsWith('\x1b[0m'));

/* the one rule: with the escapes removed the text is exactly what came in (markers and spacing included) */
for(const t of ['Hello `test` 42 world', '- item 1\n* item 2\n1. item 3', '  - indented', '# Title\n## Subtitle', 'He said "hello"', '```js\nlet a = "x";\n```\nafter', 'a **b** `c` 3.5 "d"', '', 'plain'])
  check(`text kept: ${JSON.stringify(t)}`, strip(colorReasoning(t)) === t);

console.log('test-rawcolor-reasoning: ok');
