/* test-probe-deep.js: the tier 1 probe asks once more when a reasoning model's reply is cut off at the token limit */
import { probeUsable, probeBrief } from '../lib/gateway/exploration.js';
import { stripAnsi } from 'terminal';
import { NEEDLES } from '../lib/gateway/probe-context.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-probe-deep: ${what}`);
};

const facts = { codename: NEEDLES.codename, port: NEEDLES.port, owner: NEEDLES.owner };
const call = { name: 'report_findings', arguments: facts };

/* a client that answers from a list and remembers the token budget of each request */
const fake = answers => {
  const budgets = [];
  return { budgets, abort() {}, async chat(_m, o) { budgets.push(o.max_tokens); const a = answers.shift(); if(a instanceof Error) throw a; return a; } };
};
const run = c => probeUsable(c, 'm', { toolsKnown: true, deep: 1500, base: { ok: true, toolOk: true, ms: 1, v: 3 } });

{
  const c = fake([{ content: `${NEEDLES.codename} ${NEEDLES.port} ${NEEDLES.owner}`, meta: { finish: 'length' } }, { content: '', toolCalls: [call], meta: { finish: 'tool_calls' } }]);
  const r = await run(c);
  check('cut off after the facts: asked again with a larger budget', c.budgets.join() === '1500,3000');
  check('and then it passes, marked as retried', r.deep.ok && r.deep.recall === 3 && r.deep.toolCall && r.deep.retried === true);
}

{
  const c = fake([{ content: '', toolCalls: [call], meta: { finish: 'tool_calls' } }]);
  const r = await run(c);
  check('a good first answer is the only request', c.budgets.join() === '1500' && r.deep.ok && !r.deep.retried);
}

{
  const c = fake([{ content: 'thinking about it', meta: { finish: 'length' } }]);
  const r = await run(c);
  check('cut off without the facts: no retry, it fails', c.budgets.join() === '1500' && !r.deep.ok && r.deep.recall === 0);
}

{
  const c = fake([{ content: `${NEEDLES.codename} ${NEEDLES.port} ${NEEDLES.owner}`, meta: { finish: 'length' } }, { content: 'still no call', meta: { finish: 'length' } }]);
  const r = await run(c);
  check('the retry runs once only', c.budgets.length === 2 && !r.deep.ok && r.deep.retried === true);
}

{
  const c = fake([new Error('All models rate-limited after 1 attempt. Soonest cooldown reset ~77s.')]);
  const r = await run(c);
  check('a rate limit is a transient failure of the probe, not of the context', !r.deep.ok && r.deep.transient === true && /rate-limited/.test(r.deep.error));
}

{
  /* the Probe cell: a rate limited tier 1 is a question mark, a real failure a cross */
  const cell = deep => {
    const e = { ok: true, toolOk: true, ms: 1000, latencyMs: 1000, deep };
    return stripAnsi(probeBrief({ pending: new Set(), get: () => e, find: () => e }, 'm'));
  };
  check('a rate limited deep probe shows 12k?', /12k\?/.test(cell({ ok: false, tokens: 12146, recall: 0, transient: true, error: 'rate-limited' })));
  check('a failed one shows 12k with a cross', /12k✗/.test(cell({ ok: false, tokens: 12146, recall: 1, toolCall: false })));
  check('a passed one shows 12k', /12k$/.test(cell({ ok: true, tokens: 12146, recall: 3, toolCall: true })));
}

console.log('test-probe-deep: ok');
