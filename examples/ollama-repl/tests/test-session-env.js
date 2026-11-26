/* test-session-env.js: the environment a session records: names, masking, restore, a 0600 file */
import { relevantEnv, maskValue, captureEnv, restoreEnv, readEnvRecord, writeEnvRecord, forgetEnvRecord, envPath, envText } from '../lib/session/session-env.js';
import { getenv, setenv, unsetenv, loadFile, exit } from 'std';
import { mkdir, stat } from 'os';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-session-env: ${what}`);
};

/* which variables */
check('gemini', relevantEnv({ provider: 'gemini' }).join() === 'GEMINI_API_KEY');
check('ollama needs none', relevantEnv({ provider: 'ollama' }).length === 0 && relevantEnv({ provider: 'bridge' }).length === 0);
check('plain openai', relevantEnv({ provider: 'openai' }).join() === 'OPENAI_API_KEY,OPENAI_API_URL');
check('alias', relevantEnv({ provider: 'openai', label: 'cerebras', apiKeyEnv: 'CEREBRAS_API_KEY', apiUrlEnv: 'CEREBRAS_API_URL' }).join() === 'CEREBRAS_API_KEY,CEREBRAS_API_URL');
check('freellm adds the gateway ones', relevantEnv({ provider: 'openai', label: 'freellm' }).join() === 'OPENAI_API_KEY,OPENAI_API_URL,FREELLMAPI_URL,FREELLMAPI_KEY,FREELLMAPI_DASHBOARD_TOKEN');
check('freellm with its own key', relevantEnv({ provider: 'openai', label: 'freellm', apiKeyEnv: 'FREELLMAPI_KEY' }).filter(n => n === 'FREELLMAPI_KEY').length === 1);

/* masking */
check('long secret', maskValue('CEREBRAS_API_KEY', 'csk-v9wc2vd5c4nn8c8rccyy') === 'csk-…cyy');
check('short secret', maskValue('X_TOKEN', 'abc') === '***');
check('url unchanged', maskValue('CEREBRAS_API_URL', 'https://api.cerebras.ai/v1') === 'https://api.cerebras.ai/v1');
check('url password masked', maskValue('X_URL', 'https://user:pw@host/v1') === 'https://***@host/v1');
check('secret never shown whole', !maskValue('A_KEY', 'supersecretvalue1234').includes('secretvalue'));

/* capture and restore with a fake environment */
const env = { A_KEY: 'k1', EMPTY: '' };
check('capture: set ones only', JSON.stringify(captureEnv(['A_KEY', 'EMPTY', 'MISSING'], n => env[n])) === '{"A_KEY":"k1"}');
const set = {};
const done = restoreEnv({ vars: { A_KEY: 'old', B_KEY: 'b', C_URL: 'u' } }, ['A_KEY', 'B_KEY', 'D_KEY'], n => env[n], (n, v) => (set[n] = v));
check('restore: only the unset ones the run needs', done.join() === 'B_KEY' && set.B_KEY === 'b' && !('A_KEY' in set) && !('C_URL' in set));
check('restore: nothing recorded', restoreEnv(null, ['A_KEY'], () => undefined, () => 0).length === 0);

/* the file: 0600, merged, forgotten */
const base = `${getenv('TMPDIR') || '/tmp'}/test-session-env-${Date.now()}`;
mkdir(base, 0o755);
setenv('XDG_CACHE_HOME', base);
check('empty before', Object.keys(readEnvRecord('s1').vars).length === 0 && envText(readEnvRecord('s1')) === '(nothing recorded)');
check('write', writeEnvRecord('s1', { CEREBRAS_API_KEY: 'csk-v9wc2vd5c4nn8c8rccyy', CEREBRAS_API_URL: 'https://api.cerebras.ai/v1' }) === true);
const mode = stat(envPath('s1'))[0].mode & 0o777;
check(`mode 0600 (got ${mode.toString(8)})`, mode === 0o600);
check('read back', readEnvRecord('s1').vars.CEREBRAS_API_KEY === 'csk-v9wc2vd5c4nn8c8rccyy');
writeEnvRecord('s1', { OTHER_KEY: 'x'.repeat(20) });
check('merge keeps the others', Object.keys(readEnvRecord('s1').vars).length === 3);
writeEnvRecord('s1', { CEREBRAS_API_KEY: 'csk-newnewnewnewnew1234' });
check('a name set now replaces the old value', readEnvRecord('s1').vars.CEREBRAS_API_KEY === 'csk-newnewnewnewnew1234');
check('mode stays 0600 after a rewrite', (stat(envPath('s1'))[0].mode & 0o777) === 0o600);
check('text is masked', !envText(readEnvRecord('s1')).includes('newnewnewnew') && envText(readEnvRecord('s1')).includes('CEREBRAS_API_URL=https://api.cerebras.ai/v1'));
check('forget', forgetEnvRecord('s1') === true && loadFile(envPath('s1')) === null && forgetEnvRecord('s1') === false);

console.log('test-session-env: ok');
exit(0);
