/* test-provider-alias.js: --provider aliases of the OpenAI family (resolveProvider) */
import { PROVIDERS, resolveProvider, toolFields } from '../lib/clients/openai-client.js';
import { exit, getenv, setenv, unsetenv } from 'std';
import { OpenAIClient } from '../lib/clients/openai-client.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-provider-alias: ${what}`);
};

const openai = resolveProvider('openai');
check('openai env names', openai.apiKeyEnv === 'OPENAI_API_KEY' && openai.apiUrlEnv === 'OPENAI_API_URL');
check('openai default url', openai.defaultBaseUrl === PROVIDERS.openai);

const bare = resolveProvider('cerebras');
check('bare curated alias', bare.name === 'cerebras' && bare.apiKeyEnv === 'CEREBRAS_API_KEY' && bare.apiUrlEnv === 'CEREBRAS_API_URL');
check('curated default url', bare.defaultBaseUrl === 'https://api.cerebras.ai/v1');
check('openai:NAME equals bare', JSON.stringify(resolveProvider('openai:cerebras')) === JSON.stringify(bare));

const odd = resolveProvider('openai:My-Co');
check('uncurated name is lowercased', odd.name === 'my-co');
check('hyphen becomes underscore', odd.apiKeyEnv === 'MY_CO_API_KEY' && odd.apiUrlEnv === 'MY_CO_API_URL');
check('uncurated has no default url', odd.defaultBaseUrl === null);

check('bare uncurated name is refused', resolveProvider('foo') === null);
check('bad characters are refused', resolveProvider('openai:a b') === null && resolveProvider('openai:') === null);
check('undefined is refused', resolveProvider(undefined) === null);

/* the client honours the resolved names */
const was = [getenv('CEREBRAS_API_KEY'), getenv('CEREBRAS_API_URL'), getenv('MY_CO_API_KEY'), getenv('MY_CO_API_URL')];
unsetenv('CEREBRAS_API_URL');
unsetenv('MY_CO_API_URL');
setenv('CEREBRAS_API_KEY', 'k');
setenv('MY_CO_API_KEY', 'k');
check('default url used', new OpenAIClient({ ...bare, model: 'm' }).baseUrl === 'https://api.cerebras.ai/v1');
setenv('CEREBRAS_API_URL', 'http://localhost:1/v1/');
check('url variable wins, slash trimmed', new OpenAIClient({ ...bare, model: 'm' }).baseUrl === 'http://localhost:1/v1');
let err;
try {
  new OpenAIClient({ ...odd, model: 'm' });
} catch(e) {
  err = e;
}
check('uncurated without url throws', /MY_CO_API_URL/.test(err?.message));
setenv('MY_CO_API_URL', 'http://x/v1');
check('uncurated with url works', new OpenAIClient({ ...odd, model: 'm' }).baseUrl === 'http://x/v1');
[['CEREBRAS_API_KEY'], ['CEREBRAS_API_URL'], ['MY_CO_API_KEY'], ['MY_CO_API_URL']].forEach(([n], i) => (was[i] === undefined ? unsetenv(n) : setenv(n, was[i])));

/* tool_choice goes with tools only (Cerebras answers 400 otherwise) */
const tf = toolFields([{ name: 'a' }], 'auto', t => t.map(x => ({ type: 'function', function: x })));
check('tools and choice together', tf.tools[0].type === 'function' && tf.tool_choice === 'auto');
check('tools without a choice', !('tool_choice' in toolFields([{ name: 'a' }], undefined)));
check('choice without tools is dropped', Object.keys(toolFields(undefined, 'none')).length === 0 && Object.keys(toolFields([], 'none')).length === 0);

console.log('test-provider-alias: ok');
exit(0); // the clients' lws contexts keep the loop alive
