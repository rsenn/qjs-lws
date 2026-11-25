/* test-markdown.js: the plain text of a reply has the reply color, never bold or the terminal's foreground */
import { MarkdownStream } from './lib/markdown.js';
import { REPLY } from './lib/palette.js';
import { stripAnsi } from 'terminal';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-markdown: ${what}`);
};

const base = `\x1b[38;2;${[1, 3, 5].map(k => parseInt(REPLY.slice(k, k + 2), 16)).join(';')}m`;
const md = new MarkdownStream();
const out = md.push('Plain text with `code` and **bold** words.\n- item with `x`\n1. first\n\n') + md.end();
const lines = out.split('\n');

check('the text is the same without the escapes', stripAnsi(out) === 'Plain text with code and bold words.\n• item with x\n1. first\n\n');
check('a paragraph starts in the reply color', lines[0].startsWith(base));
check('the color starts again after inline code and bold (every reset)', (lines[0].match(/\x1b\[0m\x1b\[38;2;192;192;192m/g) ?? []).length === 2);
check('a paragraph is never bold on its own', !lines[0].startsWith('\x1b[1m') && !/^\x1b\[1;/.test(lines[0]));
check('list text is in the reply color', lines[1].includes(`${base}item`) && lines[2].includes(`${base}first`));
check('an empty line stays empty', lines[3] === '');
check('a heading keeps its own style', /^\x1b\[1m\x1b\[38;2;45;212;191mTitle/.test(new MarkdownStream().line('# Title')));
check('code in a frame is not recolored', !new MarkdownStream().line('```js').includes(base));

console.log('test-markdown: ok');
