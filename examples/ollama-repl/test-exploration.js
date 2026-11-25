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
  'http://g|good': { ok: true, ms: 3000, latencyMs: 900, toolOk: true, at: now - 40 * 86400e3 },
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

import { isTransientProbe, probeBrief } from './lib/exploration.js';
{
  const chk = (w, ok) => { if(!ok) throw new Error(`test-exploration: ${w}`); };
  chk('rate limited is transient', isTransientProbe({ ok: false, error: 'All models rate-limited after 2 attempts' }));
  chk('an upstream failure is transient', isTransientProbe({ ok: false, error: 'All 1 routed attempt(s) failed with upstream provider errors (upstream_error ×1)' }));
  chk('ignoring the system prompt is not', !isTransientProbe({ ok: false, error: 'ignores the system prompt (says "hi")' }));
  chk('a passed probe is not a failure', !isTransientProbe({ ok: true }));
  const ex = { pending: new Set(), get: () => undefined, find: () => ({ ok: false, error: 'HTTP 503 upstream_error' }) };
  chk('busy is shown as a warning, not a cross', /busy/.test(probeBrief(ex, 'm')) && !/✗/.test(probeBrief(ex, 'm')));
}

import { probeCells } from './lib/exploration.js';
{
  const chk = (w, ok) => { if(!ok) throw new Error(`test-exploration: ${w}`); };
  const plain = s => s.replace(/\x1b\[[0-9;]*m/g, '');
  const mk = e => ({ pending: new Set(), get: () => e });
  const busy = probeCells(mk({ ok: false, at: Date.now() - 60000, error: 'All 2 routed attempt(s) failed with upstream provider errors' }), 'm');
  chk('a busy probe: short marker, the reason in Says', plain(busy[0]).startsWith('⚠ busy') && plain(busy[0]).length < 16 && plain(busy[1]).startsWith('All 2 routed'));
  const bad = probeCells(mk({ ok: false, at: Date.now(), error: 'ignores the system prompt (says "hi")' }), 'm');
  chk('a real failure: short marker, the reason in Says', plain(bad[0]) === '✗ failed' && plain(bad[1]).startsWith('ignores the system prompt'));
}

/* the worker: a failed probe is diagnosed, a hiccup is probed again, the verdict is stored */
{
  const { Exploration } = await import('./lib/exploration.js');
  const { setenv } = await import('std');
  setenv('XDG_CACHE_HOME', `/tmp/ollama-repl-test-explore-${Date.now()}`);
  const chk = (w, ok) => { if(!ok) throw new Error(`test-exploration: ${w}`); };

  const calls = { flaky: 0 };
  const makeClient = id => ({
    destroy() {},
    abort() {},
    async chat(messages) {
      const sys = messages.some(m => m.role === 'system');
      if(id === 'good') return { content: sys ? 'PINEAPPLE' : 'I am Good, by Test', meta: {} };
      if(id === 'flaky') {
        if(calls.flaky++ < 1) throw Object.assign(new Error('HTTP 503 upstream_error'), { detail: 'HTTP 503 upstream_error' });
        return { content: sys ? 'PINEAPPLE' : 'I am Flaky', meta: {} };
      }
      if(id === 'gone') throw Object.assign(new Error('model_not_found'), { detail: 'model_not_found' });
      return { content: 'x', meta: {} };
    },
  });

  const ex = new Exploration('http://test');
  const seen = [];
  const results = {};
  await new Promise(resolve => {
    ex.run(['good', 'flaky', 'gone'], makeClient, {
      tools: { good: true, flaky: true, gone: true },
      diagnose: async (id, r) => (id === 'gone' ? { cause: 'model-gone', detail: 'the provider no longer serves this model id', transient: false, retryInMs: 86400e3, steps: ['error says: model-gone'] } : { cause: 'flaky', detail: 'it answered on a second try', transient: true, retryInMs: 0, steps: ['asking again'] }),
      onEvent: (n, id, ev) => seen.push(`${id}:${ev.type}${ev.step ? `/${ev.step}` : ''}`),
      onResult: (id, r) => (results[id] = r),
      onDone: resolve,
    });
  });

  chk('a good model passes without a diagnosis', results.good.ok && !results.good.diagnosis);
  chk('a hiccup: diagnosed, probed again, usable', results.flaky.ok && results.flaky.recovered === true);
  chk('a model that is gone: diagnosed and stored', !results.gone.ok && results.gone.diagnosis.cause === 'model-gone' && results.gone.transient === false);
  chk('the worker reported the diagnosis steps', seen.some(s => s === 'gone:step/diagnosis'));
  chk('a gone model is not asked again for a day', ex.fresh('gone') && ex.get('gone').retryAt > Date.now() + 80000e3);
  chk('probeBrief shows the cause', /gone/.test(probeBrief(ex, 'gone').replace(/\x1b\[[0-9;]*m/g, '')));
}

/* tier 1: a synthetic compacted context, graded on three recalled facts */
{
  const { Exploration, deepText } = await import('./lib/exploration.js');
  const { NEEDLES } = await import('./lib/probe-context.js');
  const chk = (w, ok) => { if(!ok) throw new Error(`test-exploration: ${w}`); };
  let sent = 0;
  const calls = [];
  const makeClient = id => ({
    destroy() {},
    abort() {},
    async chat(messages, o = {}) {
      const big = JSON.stringify(messages).length > 3000;
      if(big) { sent = JSON.stringify(messages).length; calls.push(id); }
      if(id === 'toobig' && big) throw Object.assign(new Error('HTTP 413 request too large'), { detail: 'HTTP 413 request too large' });
      if(!big) return { content: 'OK', toolCalls: o.tools ? [{ name: 'ping', args: { value: 7 } }] : undefined, meta: {} };
      if(id === 'forgetful') return { content: '', toolCalls: [{ name: 'report_findings', args: { codename: 'HERON-417', port: 1, owner: 'nobody' } }], meta: { finish: 'tool_calls' } };
      return { content: '', toolCalls: [{ name: 'report_findings', args: { ...NEEDLES } }], meta: { finish: 'tool_calls', usage: { completionTokens: 40 } } };
    },
  });

  const ex = new Exploration('http://deep');
  const res = {};
  const deep = id => (id === 'unlisted' ? 0 : 3000);
  await new Promise(resolve => ex.run(['sharp', 'forgetful', 'toobig', 'unlisted'], makeClient, { deep, onResult: (id, r) => (res[id] = r), onDone: resolve }));

  chk('a model that recalls all three facts passes tier 1', res.sharp.ok && res.sharp.deep.ok && res.sharp.deep.recall === 3 && res.sharp.deep.toolCall);
  chk('the request was about the size asked for', sent > 9000 && sent < 15000);
  chk('lost facts fail tier 1 but not tier 0', res.forgetful.ok && !res.forgetful.deep.ok && res.forgetful.deep.recall === 1);
  chk('a refused prompt fails tier 1 as the model\'s fault', res.toobig.ok && !res.toobig.deep.ok && !res.toobig.deep.transient && /413/.test(res.toobig.deep.error));
  chk('a model outside the top gets tier 0 only', res.unlisted.ok && !res.unlisted.deep && !calls.includes('unlisted'));
  chk('tier 1 is not repeated', !ex.needsDeep('sharp') && !ex.needsDeep('forgetful'));
  chk('a model that passed tier 0 only needs tier 1 when it is wanted', ex.run(['unlisted'], makeClient, { deep }) === 0 && ex.run(['unlisted'], makeClient, { deep: () => 3000, onResult() {}, onDone() {} }) === 1);
  chk('says column shows the context result', /3k ctx: 3\/3 facts/.test(strip(deepText(ex.get('sharp')))) && /413/.test(strip(deepText(ex.get('toobig')))));
}
