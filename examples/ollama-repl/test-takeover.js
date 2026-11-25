/* test-takeover.js: when a discovered model is better, and how its first step is read */
import { betterReason, stepText } from './lib/takeover.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-takeover: ${what}`);
};

check('stronger tier wins', /stronger/.test(betterReason({ strength: { cand: 2, cur: 5 }, probeMs: 5000, currentMs: 1000 })));
check('weaker tier never', betterReason({ strength: { cand: 6, cur: 5 }, probeMs: 100, currentMs: 9000 }) === null);
check('same tier, twice as fast', /faster/.test(betterReason({ strength: { cand: 5, cur: 5 }, probeMs: 2000, currentMs: 6000 })));
check('same tier, not fast enough', betterReason({ strength: { cand: 5, cur: 5 }, probeMs: 2000, currentMs: 3500 }) === null);
check('same tier, current already quick', betterReason({ strength: { cand: 5, cur: 5 }, probeMs: 100, currentMs: 3000 }) === null);
check('unknown both, speed counts', /faster/.test(betterReason({ strength: { cand: 9, cur: 9 }, probeMs: 1000, currentMs: 8000 })));
check('tool call is a step', stepText({ toolCalls: [{ name: 'read_file', args: { path: 'a.js' } }] }) === 'read_file({"path":"a.js"})');
check('text is a step', stepText({ content: 'I will read lib/tui.js and then change the kind tags.' }).startsWith('I will read'));
check('short text is no step', stepText({ content: 'ok' }) === null);
check('nothing is no step', stepText({}) === null);
