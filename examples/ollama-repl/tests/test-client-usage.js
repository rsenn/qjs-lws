/* test-client-usage.js: Ollama and Gemini token counts -> the usage record /usage and the status line read */
import { ollamaUsage } from '../lib/clients/ollama-client.js';
import { geminiUsage } from '../lib/clients/gemini-client.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-client-usage: ${what}`);
};

let u = ollamaUsage({ done: true, prompt_eval_count: 26, eval_count: 298 });
check('ollama counts', u.prompt === 26 && u.completion === 298 && u.total === 324);
check('ollama without counts', ollamaUsage({ done: true }) === undefined);

u = geminiUsage({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: 5, totalTokenCount: 35 } });
check('gemini counts', u.prompt === 10 && u.completion === 25 && u.total === 35 && u.reasoning === 5);
check('gemini without metadata', geminiUsage({ candidates: [] }) === undefined);
