/* test-harness-error.js: errors of our own code are told from provider and gateway errors */
import { isHarnessError } from '../lib/agent/harness-error.js';
import { errorClass } from '../lib/session/usage-baseline.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-harness-error: ${what}`);
};

check('a ReferenceError', isHarnessError(new ReferenceError("'fg' is not defined")));
check('the text of one (an error stored as a string)', isHarnessError("'colorReasoning' is not defined") && isHarnessError('not a function'));
check('a bad color from the terminal module', isHarnessError(new TypeError("unknown color '\\x1b[38;2;224;122;95m'")));
check('a missing function', isHarnessError(new TypeError('tui.openPanel is not a function')));
check('a SyntaxError and a RangeError', isHarnessError(new SyntaxError('x')) && isHarnessError(new RangeError('x')));

for(const e of ['All models exhausted: 3 routes checked (2 rate-limited or on cooldown)', 'All models rate-limited after 1 attempt. Soonest cooldown reset ~77s.', 'Rate limit exceeded: more than 120 requests per minute.', 'Provider error (Nemotron 3.5 Lightning (ElectronHub): is not a function', 'OpenAI connection failed: closed before established', 'interrupted', '', null, undefined])
  check(`not ours: ${String(e).slice(0, 40)}`, !isHarnessError(e));

check('the baseline classes them the same way', errorClass("'fg' is not defined") === 'harness exception' && errorClass('All models exhausted') === 'all models exhausted/rate-limited');

console.log('test-harness-error: ok');
