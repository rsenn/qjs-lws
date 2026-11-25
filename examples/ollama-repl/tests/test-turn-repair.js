/* test-turn-repair.js: lib/turn-repair.js leaves a valid conversation behind a half-done turn */
import { repairTurn } from '../lib/turn-repair.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-turn-repair: ${what}`);
};
const call = n => ({ role: 'assistant', content: '', toolCalls: Array.from({ length: n }, (_, i) => ({ id: `c${i}`, name: 'read_file', args: {} })) });
const tool = () => ({ role: 'tool', name: 'read_file', content: 'x' });
const base = () => [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'old reply' }];

/* nothing happened: the whole turn goes, as before */
{
  const turn = { role: 'user', content: 'go' };
  const m = [...base(), turn, call(2), tool(), tool()];
  check('read-only turn dropped', repairTurn(m, turn, { sideEffects: false, reason: 'boom' }) === 'dropped' && m.length === 2);
}

/* files were written: finished rounds stay, a round with unanswered calls goes, a note closes the turn */
{
  const turn = { role: 'user', content: 'go' };
  const m = [...base(), turn, call(1), tool(), call(2), tool()];
  check('kept', repairTurn(m, turn, { sideEffects: true, reason: 'HTTP 502\nbody' }) === 'kept');
  check('unanswered round trimmed', m.length === 2 + 3 + 1 && m.at(-2).role === 'tool');
  check('closing note names the error', m.at(-1).role === 'assistant' && m.at(-1).content.includes('HTTP 502') && !m.at(-1).content.includes('body'));
}

/* side effects but no finished round: nothing worth keeping */
{
  const turn = { role: 'user', content: 'go' };
  const m = [...base(), turn, call(1)];
  check('only an unanswered round', repairTurn(m, turn, { sideEffects: true, reason: 'x' }) === 'dropped' && m.length === 2);
}

/* a !command: the user's own command output is the only tool message, the model's reaction failed at once */
{
  const turn = { role: 'user', content: '!make' };
  const m = [...base(), turn, { role: 'tool', name: 'run_command', toolCallId: '!-user', content: 'ok' }];
  check('user command kept', repairTurn(m, turn, { sideEffects: true, reason: 'HTTP 429' }) === 'kept' && m.length === 5 && m.at(-1).role === 'assistant');
}

/* compaction folded the turn away */
check('gone', repairTurn(base(), { role: 'user' }, { sideEffects: true, reason: 'x' }) === 'gone');
console.log('test-turn-repair: ok');
