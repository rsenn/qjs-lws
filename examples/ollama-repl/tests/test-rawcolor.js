/**
 * test-rawcolor.js: lib/tui/rawcolor.js must never change the visible text,
 * only add colors. Run by smoke.sh (qjsm test-rawcolor.js), exit status 1 on
 * a failure.
 */
import { stripAnsi } from 'terminal';
import { GREEN, RED, TEAL } from '../lib/palette.js';

/* the escape of a palette color, so a palette change does not break the checks */
const rgb = hex => [1, 3, 5].map(k => parseInt(hex.slice(k, k + 2), 16)).join(';');
import { exit } from 'std';
import { colorArgs, colorContent, colorJson, colorMeta, lastLines } from '../lib/tui/rawcolor.js';

let failed = 0;
const check = (name, ok) => {
  if(!ok) {
    failed++;
    console.log(`FAIL ${name}`);
  }
};

const samples = {
  json: '{"path": "lib/a.js", "n": 3, "ok": true, "x": null, "list": [1, 2.5, -4e3], "s": "a \\"q\\" b"}',
  jsonPretty: JSON.stringify({ a: { b: [1, 'two', false] }, c: 'x:y' }, null, 2),
  diff: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n context',
  grep: 'lib/a.js:12:  const x = 1;\nrepl.js:3:import y',
  fenced: 'text\n```js\nconst a = "s"; // c\n```\nafter',
  file: 'File: lib/a.js\nbody',
  error: 'error: no such file\nFAIL here\n(declined by the user)',
  notes: '[compacted] The conversation outgrew\n[handoff] x',
  empty: '',
  plain: 'just some words, no structure at all',
};

for(const [name, text] of Object.entries(samples)) {
  check(`colorContent keeps the text of ${name}`, stripAnsi(colorContent(text)) === text);
  check(`colorContent code keeps the text of ${name}`, stripAnsi(colorContent(text, { code: true })) === text);
  check(`colorJson keeps the text of ${name}`, stripAnsi(colorJson(text)) === text);
}

const meta = 'requested   auto:fast\nmodel       kilo/x\nstatus      200\ntime        3.2s total, 80ms to headers\nheaders\n  x-routed-via: kilo/x\n  retry-after: 3';
check('colorMeta keeps the text', stripAnsi(colorMeta(meta)) === meta);
check('colorMeta colors the status green', new RegExp(`\\x1b\\[38;2;${rgb(GREEN)}m200`).test(colorMeta(meta)));
check('colorMeta colors a 503 red', new RegExp(`\\x1b\\[38;2;${rgb(RED)}m503`).test(colorMeta('status      503')));

check('colorJson colors a key teal', new RegExp(`\\x1b\\[38;2;${rgb(TEAL)}m"path"`).test(colorJson(samples.json)));
check('colorContent colors a + line green', new RegExp(`\\x1b\\[38;2;${rgb(GREEN)}m\\+new`).test(colorContent(samples.diff)));

const args = stripAnsi(colorArgs({ path: 'a.js', old_string: 'one\ntwo', n: 2 }));
check('colorArgs shows keys', args.includes('path:') && args.includes('old_string:') && args.includes('n: 2'));
check('colorArgs shows a multi-line string as lines', args.includes('│ one') && args.includes('│ two'));
check('colorArgs on nothing', stripAnsi(colorArgs({})) === '(no arguments)');

/* the live reasoning panel colours only the tail of a growing text */
const long = Array.from({ length: 20000 }, (_, i) => `thought ${i}: weigh "option ${i}" with 42 steps`).join('\n');
const tail = lastLines(long);
check('lastLines: short text whole', lastLines('a\nb', 100) === 'a\nb');
check('lastLines: bounded', tail.length <= 6000 && tail.length > 5000);
check('lastLines: starts at a line, ends where the text ends', long.endsWith(tail) && long[long.length - tail.length - 1] === '\n');
check('lastLines: no newline in range cuts the characters', lastLines('x'.repeat(50), 10) === 'x'.repeat(10));

console.log(failed ? `${failed} failed` : 'rawcolor ok');
exit(failed ? 1 : 0);
