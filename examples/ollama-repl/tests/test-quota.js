/* test-quota.js: the /quota text built from x-ratelimit-* headers */
import { quotaWindows, quotaText } from '../lib/session/usage-stats.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-quota: ${what}`);
};

const cerebras = {
  'x-ratelimit-remaining-requests-minute': '999',
  'x-ratelimit-remaining-requests-hour': '59999',
  'x-ratelimit-remaining-tokens-minute': '482052',
  'x-ratelimit-remaining-tokens-hour': '89982052',
  'x-ratelimit-limit-requests-minute': '1000',
  'x-ratelimit-limit-requests-hour': '60000',
  'x-ratelimit-limit-tokens-minute': '500000',
  'x-ratelimit-limit-tokens-hour': '30000000'
};

const wins = quotaWindows(cerebras);
check('two windows', wins.map(w => w.window).join() === 'minute,hour');
check('values', wins[0].requests.remaining === '999' && wins[0].tokens.limit === '500000');

const text = quotaText([{ model: 'm', at: 0, headers: cerebras }]);
check('exact figures', text.includes('999 / 1,000') && text.includes('482,052 / 500,000'));
check('remaining above limit is flagged', /\?/.test(text.split('\n').find(l => l.startsWith('hour'))));

const openai = quotaWindows({ 'x-ratelimit-remaining-requests': '5', 'x-ratelimit-limit-requests': '10', 'x-ratelimit-reset-requests': '1s' });
check('unnamed window', openai.length === 1 && openai[0].window === '' && openai[0].requests.reset === '1s');
check('reset shown', quotaText([{ model: 'm', at: 0, headers: { 'x-ratelimit-remaining-requests': '5', 'x-ratelimit-limit-requests': '10', 'x-ratelimit-reset-requests': '1s' } }]).includes('resets in 1s'));

check('newest record with headers wins', quotaText([{ model: 'a', at: 0, headers: cerebras }, { model: 'b', at: 1, headers: {} }]).includes('999'));
check('none yet', /no x-ratelimit/.test(quotaText([{ model: 'a', at: 0, headers: {} }])));

console.log('test-quota: ok');
