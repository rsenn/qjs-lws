/* test-key-events.js: a key that went unhealthy or healthy again is an event, once, whichever look saw it */
import { reportKeys, resetKeys } from '../lib/key-events.js';
import { recent } from '../lib/events.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-key-events: ${what}`);
};
const keys = status => [{ id: 7, platform: 'kilo', label: 'main', status }, { id: 8, platform: 'groq', status: 'healthy' }];
const events = () => recent({ filter: 'key' }).map(e => e.text);

resetKeys();
check('the first look says nothing', reportKeys(keys('healthy')) === 0 && !events().length);
check('no change, no event', reportKeys(keys('healthy')) === 0);
check('a key that went unhealthy', reportKeys(keys('error'), p => p.toUpperCase()) === 1 && events().at(-1) === 'KILO (main) key 7: healthy -> error');
check('the same look again says nothing', reportKeys(keys('error')) === 0 && events().length === 1);
check('healthy again', reportKeys(keys('healthy')) === 1 && /key 7 is healthy again/.test(events().at(-1)));
check('a disabled key is its own state', reportKeys([{ id: 7, platform: 'kilo', enabled: false, status: 'healthy' }]) === 1 && /healthy -> disabled/.test(events().at(-1)));
console.log('test-key-events: ok');
