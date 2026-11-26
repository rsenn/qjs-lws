/* test-poll-delay.js: how often a split pane polls ss */
import { pollDelay } from '../lib/project/resources.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-poll-delay: ${what}`);
};

check('1 s with a request in flight', pollDelay(1, 80) === 1000);
check('3 s idle', pollDelay(0, 80) === 3000);
check('a slow ss slows the polling down (5 times its duration)', pollDelay(1, 900) === 4500 && pollDelay(0, 2000) === 10000);
check('no duration yet', pollDelay(0) === 3000);
console.log('test-poll-delay: ok');
