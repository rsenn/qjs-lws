/* context-view: the pure parts of /context and /log */
import { messageText, messageSelection, summarizeMessages, parseContextArgs } from '../lib/context-view.js';

const same = (a, b, what) => {
  if(JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`test-context-view: ${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

same(messageSelection('all', 3), [0, 1, 2], 'all');
same(messageSelection('#2', 3), [2], '#2');
same(messageSelection('1-2', 3), [1, 2], 'range');
same(messageSelection('0,2,2', 3), [0, 2], 'list without duplicates');
same(messageSelection('3', 3), null, 'past the end');
same(messageSelection('2-1', 3), null, 'backwards range');
same(messageSelection('x', 3), null, 'not a number');

same(messageText({ role: 'user', content: 'hi' }, 0), '[0] user (2 chars)\nhi', 'plain message');
same(messageText({ role: 'tool', name: 'ls', content: 'x', toolCalls: [{ name: 'ls', args: { a: 1 } }] }, 4), '[4] tool ls (1 chars)\nx\n[called ls {"a":1}]', 'tool message with call');
same(messageText({ role: 'assistant', content: [{ a: 1 }] }, 1), '[1] assistant (9 chars)\n[{"a":1}]', 'structured content');

const long = 'a'.repeat(100);
same(summarizeMessages([{ role: 'user', content: 'a\nb' }, { role: 'assistant', content: long }]),
  `[0] user (3 chars): a b\n[1] assistant (100 chars): ${'a'.repeat(80)}...`, 'summary');

same(parseContextArgs('/context show 1-3'), { verb: 'show', sel: '1-3', rest: [] }, 'show');
same(parseContextArgs('/context 2'), { verb: 'show', sel: '2', rest: [] }, 'bare selection is show');
same(parseContextArgs('/context all'), { verb: 'show', sel: 'all', rest: [] }, 'bare all');
same(parseContextArgs('/context show'), { verb: 'show', sel: null, rest: [] }, 'show without selection');
same(parseContextArgs('/context save'), { verb: 'save', sel: 'all', rest: [] }, 'save defaults to all');
same(parseContextArgs('/context save 1,4 out.txt'), { verb: 'save', sel: '1,4', rest: ['out.txt'] }, 'save with file');
same(parseContextArgs('/context save out.txt'), { verb: 'save', sel: 'all', rest: ['out.txt'] }, 'save file only');
same(parseContextArgs('/context copy #1'), { verb: 'copy', sel: '#1', rest: [] }, 'copy');
same(parseContextArgs('/context bogus'), { verb: null, sel: null, rest: [] }, 'unknown verb');
