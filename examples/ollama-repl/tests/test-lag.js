/* test-lag.js: a blocked loop and a slow section are reported, with the section named */
import * as os from 'os';

const dir = `/tmp/ollama-repl-test-lag-${Date.now()}`;
os.mkdir(dir, 0o700);
os.mkdir(`${dir}/ollama-repl`, 0o700);
const { setenv } = await import('std');
setenv('XDG_CACHE_HOME', dir);

const { timed, startLagWatch } = await import('../lib/lag.js');
const { recent } = await import('../lib/events.js');

const check = (what, ok) => {
  if(!ok) throw new Error(`test-lag: ${what}`);
};
const spin = ms => {
  const t = Date.now();
  while(Date.now() - t < ms);
};

check('a fast section is silent and returns its value', timed('fast', () => 42) === 42 && !recent().some(e => e.kind === 'lag'));

const stop = startLagWatch({ describe: () => 'testing' });
os.setTimeout(() => timed('heavy-part', () => spin(400)), 150);
await new Promise(r => os.setTimeout(r, 1000));
stop();

const lag = recent().filter(e => e.kind === 'lag');
check('the slow section is an event', lag.some(e => /heavy-part ran for/.test(e.text)));
check('the stall is an event naming the section and the phase', lag.some(e => /blocked for/.test(e.text) && /heavy-part/.test(e.text) && /testing/.test(e.text)));
const { loadFile } = await import('std');
const rows = loadFile(`${dir}/ollama-repl/lag.jsonl`).split('\n').filter(Boolean).map(l => JSON.parse(l));
check('a slow row says where it was asked for', rows.some(r => r.kind === 'slow' && r.name === 'heavy-part' && typeof r.where === 'string' && r.where.length > 0));
/* slicer: a long loop gives the event loop a turn, so a timer is never kept waiting much longer than a slice */
{
  const { slicer } = await import('../lib/lag.js');
  const turn = slicer(10);
  let ticks = 0;
  let worst = 0;
  let last = Date.now();
  let going = true;
  os.setTimeout(function tick() {
    if(!going) return;
    ticks++;
    worst = Math.max(worst, Date.now() - last);
    last = Date.now();
    os.setTimeout(tick, 5);
  }, 5);
  const t0 = Date.now();
  while(Date.now() - t0 < 300) {
    await turn();
    spin(3);
  }
  going = false;
  check('slicer: the timer ran during a 300 ms loop', ticks >= 10);
  check(`slicer: no gap much longer than a slice (worst ${worst} ms)`, worst < 60);
}

console.log('test-lag: ok');
