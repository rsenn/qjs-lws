/* hopLine: the one-line text of an automatic model switch (plain and coloured) */
import { hopLine } from '../lib/hop-line.js';

function eq(a, b) {
  if(a !== b) throw new Error(`expected\n  ${b}\ngot\n  ${a}`);
}

eq(hopLine({ from: 'gemini-3.5-flash-lite', why: 'every route failed upstream, skipped 10m', next: 'qwen3.8-27b', rating: 90 }),
  '⇄ gemini-3.5-flash-lite every route failed upstream, skipped 10m → qwen3.8-27b rating 90');

eq(hopLine({ from: 'a', why: 'rate limited', providers: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'], count: 129, back: 'back in 3h 42m', next: 'b', rating: 85 }),
  '⇄ a rate limited: 129 models of p1, p2, p3, p4 +2 more, back in 3h 42m → b rating 85');

eq(hopLine({ from: 'a', why: 'quota used up' }), '⇄ a quota used up → no other model available');

const tags = hopLine({ from: 'a', why: 'rate limited', providers: ['p'], next: 'b' }, { model: id => `<${id}>`, paint: (k, t) => `[${k}:${t}]` });
eq(tags, '[arrow:⇄] <a> [warn:rate limited]: [provider:p] [arrow:→] <b>');

console.log('test-hop-line: ok');
