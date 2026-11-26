/* test-shared-spinner.js: concurrent requests share one spinner */
import { shareSpinner } from '../lib/tui/shared-spinner.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-shared-spinner: ${what}`);
};

let made = 0;
let stopped = 0;
const start = shareSpinner(() => {
  made++;
  return () => stopped++;
});

const a = start();
check('first starts one', made === 1 && stopped === 0);
const b = start();
const c = start();
check('later ones do not start another', made === 1);
a();
check('still running while one is left', stopped === 0);
a();
check('stopping twice counts once', stopped === 0);
b();
check('two of three stopped: still running', stopped === 0);
c();
check('the last stop stops it', stopped === 1);
c();
check('and only once', stopped === 1);

const d = start();
check('a new one after that starts again', made === 2);
d();
check('and stops', stopped === 2);

/* the first label is the one the spinner is made with */
const labels = [];
const s2 = shareSpinner(l => (labels.push(l), () => {}));
const x = s2('one');
const y = s2('two');
check('first label wins', labels.join() === 'one');
x();
y();

console.log('test-shared-spinner: ok');
