/* test-handoff.js: buildHandoff() with one long turn (no older turn to summarize) */
import { buildHandoff } from '../lib/handoff.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-handoff: ${what}`);
};
const big = 'x'.repeat(5000);
const calls = n => ({ role: 'assistant', content: '', toolCalls: [{ id: `c${n}`, name: 'read_file', args: {} }] });
const msgs = [
  { role: 'system', content: 's' },
  { role: 'user', content: 'go' },
];
for(let i = 0; i < 11; i++) msgs.push(calls(i), { role: 'tool', name: 'read_file', content: big });

/* compaction: nothing older than the kept tail, so nothing to do and the tool results stay whole */
check('compact leaves a single turn alone', (await buildHandoff(msgs, 1, { reason: 'compact', clipAlone: false })) === null);
check(
  'input untouched',
  msgs.filter(m => m.role === 'tool').every(m => m.content.length === 5000),
);

/* failover to a smaller window still clips */
const h = await buildHandoff(msgs, 1, { reason: 'failover' });
check('failover clips', h && h.cut === 0 && h.messages.filter(m => m.role === 'tool').every(m => m.content.length < 700));
