/* test-events.js: the event ring buffer, its filter and the sink */
import { emit, recent, eventsText, eventLine, setSink, eventCount } from '../lib/events.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-events: ${what}`);
};
const plain = s => s.replace(/\x1b\[[0-9;]*m/g, '');

const seen = [];
setSink(ev => seen.push(ev));
emit('gateway', 'kilo-auto limited:   daily window', 'warn');
emit('explore', 'glm-5.3 is usable', 'good');
emit('explore', 'qwen failed: boom', 'warn');
emit('failover', 'switching to glm-5.3', 'good');

check('the sink gets every event', seen.length === 4 && seen[0].kind === 'gateway');
check('whitespace is squeezed', seen[0].text === 'kilo-auto limited: daily window');
check('filter by kind', recent({ filter: 'explore' }).length === 2);
check('filter by word', recent({ filter: 'boom' }).length === 1);
check('n keeps the newest', recent({ n: 1 })[0].kind === 'failover');
check('a line has time, kind and text', /^\d\d:\d\d:\d\d .+ gateway kilo-auto/.test(plain(eventLine(seen[0]))));
check('text has counts per kind', plain(eventsText({})).includes('explore 2'));
check('nothing matching', eventsText({ filter: 'zzz' }).includes('no event matches'));
setSink(() => { throw new Error('a broken sink'); });
emit('gateway', 'still recorded');
check('a broken sink does not break emit', eventCount() === 5);
for(let i = 0; i < 1100; i++) emit('gateway', `e${i}`);
check('the buffer is bounded', eventCount() === 1000);
console.log('test-events: ok');

/* the exploration's lines get emoji and colour per part */
{
  const strip = x => x.replace(/\x1b\[[0-9;]*m/g, '');
  const { eventLine: line } = await import('../lib/events.js');
  const mk = (text, level = 'info') => line({ at: Date.now(), kind: 'explore', level, text });
  const ok = mk('deepseek-v4-flash is usable: 4.5s, calls tools, 12k context ok', 'good');
  if(!/✅ deepseek-v4-flash is usable: 4.5s, ✔ calls tools, 🧬 12k context holds/.test(strip(ok))) throw new Error(`test-events: usable line: ${strip(ok)}`);
  if(!ok.includes('\x1b[1;97mdeepseek-v4-flash')) throw new Error('test-events: model id is highlighted');
  const bad = strip(mk('glm-5.2 failed, diagnosed: upstream - blaze is rate_limited, resumes in 62s; router9 is rate_limited, resumes in 74 min', 'warn'));
  if(!/❌ glm-5.2 failed, 🩺 diagnosed: 🔥 upstream - blaze is rate_limited, resumes in ⏱ 62s; router9 is rate_limited, resumes in ⏱ 74 min/.test(bad)) throw new Error(`test-events: failed line: ${bad}`);
  if(!/🔎 worker 2 asks glm-5.2 \(0 more queued\)/.test(strip(mk('worker 2 asks glm-5.2 (0 more queued)')))) throw new Error('test-events: worker line');
  if(!/🏁 startup exploration finished: 2 of 5 models usable/.test(strip(mk('startup exploration finished: 2 of 5 models usable', 'good')))) throw new Error('test-events: finished line');
}

/* model names take their colour from the namer, tools and context have their own marks */
{
  const { eventLine: line, setNamer } = await import('../lib/events.js');
  setNamer(id => (id === 'qwen-x' ? '#8b5cf6' : null));
  const l = line({ at: Date.now(), kind: 'explore', level: 'info', text: 'qwen-x is usable: 1s, no tool calls, 12k context failed' });
  const strip = x => x.replace(/\x1b\[[0-9;]*m/g, '');
  if(!l.includes('38;2;139;92;246mqwen-x')) throw new Error('test-events: strength colour of the name');
  if(!/✅ qwen-x is usable: 1s, ✘ no tool calls, 💥 12k context lost/.test(strip(l))) throw new Error(`test-events: marks: ${strip(l)}`);
  if(!l.includes('\x1b[91m✘ no tool calls')) throw new Error('test-events: red cross');
  const busy = line({ at: Date.now(), kind: 'explore', level: 'info', text: 'qwen-x is usable: 1s, calls tools, 12k context not tested (provider busy)' });
  if(!/12k context not tested \(provider busy\)/.test(strip(busy)) || /context lost/.test(strip(busy))) throw new Error(`test-events: a busy deep probe is not a lost context: ${strip(busy)}`);
  setNamer(() => null);
}
