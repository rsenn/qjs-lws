/* test-exploration.js: a model that passed its prompts is never prompted again; live state comes from other means */
import { setenv, getenv } from 'std';
import { writeConfigFile } from './lib/config.js';

setenv('XDG_CACHE_HOME', `${getenv('TMPDIR') || '/tmp'}/test-exploration-${Date.now()}`);
const { Exploration, explorationPath, probeCells, probeBrief } = await import('./lib/exploration.js');

const check = (what, ok) => {
  if(!ok) throw new Error(`test-exploration: ${what}`);
};
const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const now = Date.now();

writeConfigFile(explorationPath(), JSON.stringify({
  'http://g|good': { ok: true, ms: 3000, latencyMs: 900, toolOk: true, identity: 'I am Good', at: now - 40 * 86400e3 },
  'http://g|oldfail': { ok: false, error: 'boom', at: now - 2 * 3600e3 },
  'http://g|newfail': { ok: false, error: 'boom', at: now - 60e3 },
  'http://other|good': { ok: true, ms: 1, at: now },
}));

const ex = new Exploration('http://g');
check('a verified model needs no prompt, however old', ex.fresh('good') && ex.verified('good'));
check('a failure older than an hour is asked again', !ex.fresh('oldfail'));
check('a recent failure waits', ex.fresh('newfail') && !ex.verified('newfail'));
check('an unknown model is asked', !ex.fresh('nothing'));
check('run queues nothing for known models', ex.run(['good', 'newfail'], {}) === 0);

ex.setLive({ good: { at: now, reachable: true, blocked: false }, newfail: { at: now, reachable: true } });
check('live state only for verified models', ex.get('good').live && !ex.get('newfail').live);
check('usable cell shows the probe time', /usable 900ms tools/.test(strip(probeCells(ex, 'good')[0])));

ex.setLive({ good: { at: now, reachable: true, blocked: true, kinds: ['rpm'] } });
check('limited shows as such', /limited \(rpm\)/.test(strip(probeCells(ex, 'good')[0])) && strip(probeBrief(ex, 'good')) === '⏸');

ex.setLive({ good: { at: now, reachable: false } });
check('gateway down shows as such', /gateway down/.test(strip(probeCells(ex, 'good')[0])) && /down/.test(strip(probeBrief(ex, 'good'))));
check('one file for every gateway', new Exploration('http://other').verified('good'));
