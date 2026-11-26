/* test-run-command.js: runCommand never blocks on a leftover process that holds the output, and reads big output */
import { runCommand } from '../lib/run-command.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-run-command: ${what}`);
};

const timed = async (cmd, opts) => {
  const t = Date.now();
  const r = await runCommand(cmd, opts);
  return { ...r, ms: Date.now() - t };
};

let r = await timed('echo hi; echo err >&2');
check('output of both streams', r.output === 'hi\nerr\n' && r.status === 0);

r = await timed('exit 3');
check('exit status', r.status !== 0 && r.output === '');

/* a descendant keeps running after the shell exited: the old pipe read waited for it */
r = await timed('sleep 5 & echo done');
check(`a background process does not hold the call (${r.ms} ms)`, r.output.includes('done') && r.ms < 2000);

/* the shell is killed on the timeout, its pipeline child lives on */
r = await timed('sleep 5 | cat', { timeoutMs: 300 });
check(`a timeout returns at once (${r.ms} ms)`, r.timedOut && r.ms < 2000);

/* more than the 64 KB of a pipe buffer, then cut at 32 KB */
r = await timed('head -c 200000 /dev/zero | tr "\\0" x');
check('big output is cut', r.output.length > 32768 && r.output.length < 33000 && r.output.endsWith('(truncated)'));

/* a runaway writer is killed */
r = await timed('yes', { timeoutMs: 20000 });
check(`a runaway writer is killed (${r.ms} ms)`, r.ms < 10000 && !r.timedOut && r.output.length < 33000);

console.log('test-run-command: ok');
