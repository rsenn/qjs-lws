/* test-key-models.js: the models of a selection of gateway keys */
import { parseKeyScope, modelsOfKeys } from './lib/key-models.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-key-models: ${what}`);
};

check('ids', JSON.stringify(parseKeyScope('key:3,key:7')) === '{"ids":[3,7]}');
check('spaces and duplicates', JSON.stringify(parseKeyScope('key:3 key:3 key:9')) === '{"ids":[3,9]}');
check('off', parseKeyScope('key:off').off && parseKeyScope('key:').off && parseKeyScope('key:none').off);
check('not a scope', parseKeyScope('qwen3') === null && parseKeyScope('key:3,qwen') === null && parseKeyScope('') === null);
check('bad id is an error', !!parseKeyScope('key:abc').error);

const data = {
  keys: [
    { id: 1, platform: 'google', enabled: true, modelScope: null },
    { id: 2, platform: 'google', enabled: true, modelScope: null },
    { id: 3, platform: 'mistral', enabled: true, modelScope: ['codestral-2508'] },
    { id: 4, platform: 'kilo', enabled: false, modelScope: null },
  ],
  chain: [
    { platform: 'google', modelId: 'gemini-3.5-flash', displayName: 'Gemini 3.5 Flash (Google)', enabled: true },
    { platform: 'google', modelId: 'gemini-3.6-flash', displayName: 'Gemini 3.6 Flash', enabled: true },
    { platform: 'mistral', modelId: 'codestral-2508', displayName: 'Codestral', enabled: true },
    { platform: 'mistral', modelId: 'mistral-large-2512', displayName: 'Mistral Large', enabled: true },
    { platform: 'kilo', modelId: 'kilo-auto/free', displayName: 'Kilo Auto', enabled: true },
    { platform: 'google', modelId: 'old', displayName: 'Old', enabled: false },
  ],
  catalog: [{ id: 'gemini-3.5-flash' }, { id: 'gemini-3.6-flash' }, { id: 'codestral-2508' }, { id: 'mistral-large-2512' }, { id: 'kilo-auto/free' }, { id: 'old' }],
};

const g = modelsOfKeys(data, [1]);
check('a google key reaches its platform rows', [...g.ids].sort().join() === 'gemini-3.5-flash,gemini-3.6-flash');
check('the disabled row is left out', !g.ids.has('old'));
check('the other google key shares the platform', g.shared.length === 1 && g.shared[0].platform === 'google' && g.shared[0].others === 1);

const both = modelsOfKeys(data, [1, 2]);
check('two keys of a platform: no one else, rows list both keys', both.shared.length === 0 && both.models.get('gemini-3.5-flash')[0].keyIds.join() === '1,2');

const m = modelsOfKeys(data, [3]);
check('the model scope of a key holds', [...m.ids].join() === 'codestral-2508');

check('a disabled key reaches nothing', modelsOfKeys(data, [4]).ids.size === 0);
check('an unknown key is reported', modelsOfKeys(data, [99]).missing.join() === '99');
check('keys of several platforms add up', modelsOfKeys(data, [1, 3]).ids.size === 3);
