// QuickJS unit test for colorReasoning from examples/ollama-repl/lib/tui/rawcolor.js:
// the colouring only adds colour, whatever the text holds.
import { tests, assert } from './tinytest.js';
import { colorReasoning } from '../../examples/ollama-repl/lib/tui/rawcolor.js';

const BASE = '\x1b[38;2;153;153;153m';
const RESET = '\x1b[0m';
const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');

await tests({
  'plain text gets the base colour and a reset'() {
    const out = colorReasoning('Hello world');
    assert(out.startsWith(BASE), 'starts with the base colour');
    assert(out.endsWith(RESET), 'ends with a reset');
    assert(strip(out) === 'Hello world', 'text preserved');
  },

  'inline code, numbers and quotes get their own colour'() {
    assert(colorReasoning('use `x` here').includes('\x1b[38;2;80;128;255m`x`'), 'inline code is coloured');
    assert(colorReasoning('got 12 items').includes('\x1b[38;2;242;204;143m12'), 'a number is coloured');
    assert(colorReasoning('say "hi"').includes('\x1b[38;2;80;128;255m"hi"'), 'a quoted string is coloured');
  },

  'list markers and headings are coloured, the rest stays base'() {
    assert(colorReasoning('- item').includes('\x1b[38;2;80;128;255m-'), 'a list marker is coloured');
    assert(colorReasoning('# Head').includes('\x1b[38;2;255;204;0m#'), 'a heading marker is coloured');
  },

  'every line ends with a reset and the text is untouched'() {
    const text = '# Title\n- one `two` 3\n"four" and **five**\n\nlast';
    const out = colorReasoning(text);
    assert(strip(out) === text, 'stripping the colour gives the text back');
    out.split('\n').forEach((line, i) => line === '' || assert(line.endsWith(RESET), `line ${i} ends with a reset`));
  },
});
