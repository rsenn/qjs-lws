/* test-persist.js: usage rows, quota snapshots and cooldowns survive in the cache directory */
import { setenv } from 'std';
import { usageRow, appendUsage, readUsage, saveQuota, loadQuota, flushPersist, trimLogs, usagePath, appendEvent, readEvents } from '../lib/session/persist.js';
import { recordCooldownEvent, getLearnedCooldown, recordLocalFailure, saveCooldowns, loadCooldowns } from '../lib/gateway/availability.js';
import { UsageStats } from '../lib/session/usage-stats.js';
import { remove } from 'os';

const dir = `/tmp/ollama-repl-test-persist-${Date.now()}`;
setenv('XDG_CACHE_HOME', dir);
const check = (what, ok) => {
  if(!ok) throw new Error(`test-persist: ${what}`);
};

const now = Date.now();
const rec = (o = {}) => ({ at: now, model: 'kimi', routedVia: 'kilo/kimi', platform: 'kilo', usage: { prompt: 10, completion: 5, total: 15 }, ms: 1200, messages: ['SECRET'], ...o });

check('row keeps no messages', !('messages' in usageRow('o', 's', rec())) && usageRow('o', 's', rec()).usage.total === 15);
check('proxied: kept as true and as false, absent when unknown', usageRow('o', 's', rec({ proxied: true })).proxied === true && usageRow('o', 's', rec({ proxied: false })).proxied === false && !('proxied' in JSON.parse(JSON.stringify(usageRow('o', 's', rec({}))))));
check('attempt: the first try is not written, a retry is', !('attempt' in JSON.parse(JSON.stringify(usageRow('o', 's', rec({ attempt: 0 }))))) && usageRow('o', 's', rec({ attempt: 2 })).attempt === 2);
check('error is one short line', usageRow('o', 's', rec({ error: new Error('boom\nsecond line') })).error === 'boom');

appendUsage('http://a', 'sess', rec());
appendUsage('http://a', 'sess', rec({ at: now - 10 * 86400e3 }));
appendUsage('http://b', 'sess', rec());
check('rows are read back by origin', readUsage({ origin: 'http://a' }).length === 2);
check('and by age', readUsage({ origin: 'http://a', sinceMs: now - 86400e3 }).length === 1);

const past = new UsageStats();
past.records = readUsage({ origin: 'http://a' });
check('they feed the /usage summary', past.summary('last 7 days').startsWith('last 7 days: 2 requests'));

appendUsage('http://a', 'sess', rec({ at: now - 200 * 86400e3 }));
trimLogs(now);
check('old rows are trimmed', readUsage({}).every(r => r.at > now - 91 * 86400e3));

check('no snapshot yet', loadQuota('http://a') === null);
saveQuota('http://a', { usage: { tokens: 5, month: '2026-11' }, budget: { totalUsed: 1, totalBudget: 2 } });
flushPersist();
const q = loadQuota('http://a');
check('snapshot written at flush', q?.usage.tokens === 5 && q.budget.totalBudget === 2 && q.at >= now);

recordCooldownEvent('kilo/x', 'failure', now - 60000);
recordCooldownEvent('kilo/x', 'success', now);
recordLocalFailure('some-model', { status: 429 }, now);
saveCooldowns();
check('learned cooldown kept', getLearnedCooldown('kilo/x') === 60000);
loadCooldowns();
check('cooldowns load without error and keep the value', getLearnedCooldown('kilo/x') === 60000);

remove(usagePath());
/* events of the kept kinds outlive the session */
{
  const at = Date.now();
  check('a failover event is kept', appendEvent({ at, kind: 'failover', level: 'warn', text: 'a -> b' }) === true);
  check('a quota event is kept', appendEvent({ at, kind: 'quota', level: 'warn', text: 'budget 80%' }) === true);
  check('an exploration event is not', appendEvent({ at, kind: 'explore', level: 'info', text: 'x is usable' }) === false);
  const rows = readEvents({ sinceMs: at - 1000 });
  check('read back in order', rows.length === 2 && rows[0].kind === 'failover' && rows[1].text === 'budget 80%');
  check('an old event is trimmed at startup', appendEvent({ at: at - 40 * 86400e3, kind: 'proxy', level: 'info', text: 'old' }) && (trimLogs(at), readEvents().every(r => r.text !== 'old')));
}

console.log('test-persist: ok');
