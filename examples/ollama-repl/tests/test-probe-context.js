/* test-probe-context.js: the synthetic compacted context of the deep probe */
import { buildProbe, grade, deepBudget, plainQuestion, needlesFor, NEEDLES } from '../lib/probe-context.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-probe-context: ${what}`);
};

check('budget: a quarter of the window within 1.5k..12k', deepBudget(32768) === 8192 && deepBudget(800000) === 12000 && deepBudget(2000) === 1500 && deepBudget(0) === 4000);

for(const t of [1500, 4000, 12000]) {
  const p = buildProbe(t);
  check(`size ${t}: within 15% of the target`, Math.abs(p.approxTokens - t) / t < 0.15);
}

const p = buildProbe(8000);
const text = p.messages[1].content;
check('three needles, in order, at depths about 10/50/90%', [NEEDLES.codename, String(NEEDLES.port), NEEDLES.owner].every(n => text.includes(n)) && text.indexOf(NEEDLES.codename) < text.indexOf(String(NEEDLES.port)) && text.indexOf(String(NEEDLES.port)) < text.indexOf(NEEDLES.owner));
const at = n => text.indexOf(n) / text.length;
check('needle depths', at(NEEDLES.codename) < 0.25 && Math.abs(at(String(NEEDLES.port)) - 0.5) < 0.15 && at(NEEDLES.owner) > 0.75);
check('deterministic', JSON.stringify(buildProbe(8000)) === JSON.stringify(p));
check('ends with the question, tools offered', p.messages.at(-1).role === 'user' && p.tools.some(t => t.name === 'report_findings') && p.tools.length > 1);
check('plain variant has no tool request', !/report_findings/.test(plainQuestion(p).at(-1).content));
check('holds nothing of the user', !/home\/|roman|password|token/i.test(JSON.stringify(p.messages)));

check('grade: tool call with all facts', grade({ toolCalls: [{ name: 'report_findings', args: { ...NEEDLES } }] }).recall === 3);
check('grade: arguments as a JSON string', grade({ toolCalls: [{ name: 'report_findings', arguments: JSON.stringify(NEEDLES) }] }).recall === 3);
check('grade: wrong values count', grade({ toolCalls: [{ name: 'report_findings', args: { codename: 'HERON-417', port: 80, owner: 'x' } }] }).recall === 1);
check('grade: text answer', grade({ content: 'heron-417, port 8472, Ingrid Halvorsen' }).recall === 3 && !grade({ content: 'x' }).toolCall);
/* a seed gives other facts, the same each time; grade takes the needles of the probe */
{
  const a = needlesFor(1), b = needlesFor(2);
  check('no seed: the fixed needles', needlesFor() === NEEDLES);
  check('a seed changes the facts', a.codename !== NEEDLES.codename && a.codename !== b.codename && a.port !== b.port);
  check('same seed, same facts', JSON.stringify(needlesFor(1)) === JSON.stringify(a));
  const p1 = buildProbe(8000, 1);
  check('the probe holds the seeded facts', JSON.stringify(p1.messages).includes(a.codename) && !JSON.stringify(p1.messages).includes(NEEDLES.codename) && p1.needles.codename === a.codename);
  check('grade with those needles', grade({ content: `${a.codename} ${a.port} ${a.owner}` }, p1.needles).recall === 3 && grade({ content: `${NEEDLES.codename}` }, p1.needles).recall === 0);
}
console.log('test-probe-context: ok');
