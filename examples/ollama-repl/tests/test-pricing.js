/* test-pricing.js: the per-model cost estimates from lib/clients/pricing.js */
import { priceOf, estimateCost, fmtUsd } from '../lib/clients/pricing.js';
import { UsageStats, formatMeta } from '../lib/session/usage-stats.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-pricing: ${what}`);
};

const p = priceOf('cerebras', 'gpt-oss-120b');
check('known price', Array.isArray(p) && p[0] === 0.35 && p[1] === 0.75);
check('unknown provider', priceOf('nosuch', 'gpt-oss-120b') === undefined);
check('unknown model', priceOf('cerebras', 'no-such-model') === undefined);
check('prototype name', priceOf('cerebras', 'toString') === undefined);

check('unpriced model', estimateCost('cerebras', 'no-such-model', { prompt: 100, completion: 1 }) === undefined);
check('missing usage', estimateCost('cerebras', 'gpt-oss-120b') === undefined);
check('empty usage', estimateCost('cerebras', 'gpt-oss-120b', {}) === undefined);
check('prompt-only counts completion as 0', estimateCost('cerebras', 'gpt-oss-120b', { prompt: 2762 }) === estimateCost('cerebras', 'gpt-oss-120b', { prompt: 2762, completion: 0 }));

check('fmtUsd zero', fmtUsd(0) === '$0');
check('fmtUsd normal', fmtUsd(1.234) === '$1.23');
check('fmtUsd small, two significant digits starting $0.00', fmtUsd(0.00099) === '$0.00099' && fmtUsd(0.00099).startsWith('$0.00'));
check('fmtUsd NaN', fmtUsd(NaN) === '-');

const cost = estimateCost('cerebras', 'gpt-oss-120b', { prompt: 2762, completion: 32 });
check(`estimateCost within 1e-9 of 0.0009907 (got ${cost})`, Math.abs(cost - 0.0009907) < 1e-9);

/* the ledger: an estimate is shown with ~ and summed, a reported cost wins */
const rec = (usage, costEst) => ({ model: 'm', at: 0, usage, costEst });
const stats = new UsageStats();
stats.add(rec({ prompt: 10, completion: 1 }, 0.5));
stats.add(rec({ prompt: 10, completion: 1, cost: 9 }, 0.5));
check('estimate in /last', formatMeta(rec({ prompt: 1 }, 0.5)).includes('~$0.50'));
check('reported cost wins in /last', !formatMeta(rec({ prompt: 1, cost: 9 }, 0.5)).includes('~'));
check('/usage sums only the estimates', stats.summary().includes('~$0.50 estimated (1 of 2 requests priced)'));

console.log('test-pricing: ok');