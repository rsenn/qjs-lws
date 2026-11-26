/**
 * probe-context: the fixed, synthetic "compacted conversation" the exploration's deep probe sends to a model.
 *
 * It is shaped like the handoff of a real takeover (a system prompt, a summary of earlier work with tool results, the
 * tool schemas of the harness) but holds nothing of the user's: it is the same text for every model and every run, so
 * a result can be cached and no project content reaches a free provider. Three facts (needles) sit at about 10%, 50%
 * and 90% of the summary; the last message asks the model to report them with one tool call.
 *
 * ```js
 * const p = buildProbe(8000);              // { messages, tools, needles, approxTokens }
 * const g = grade(reply, p.needles);       // { recall: 0..3, toolCall: true, args }
 * deepBudget(ctx);                         // tokens to send to a model with that context window
 * ```
 */

export const NEEDLES = { codename: 'HERON-417', port: 8472, owner: 'Ingrid Halvorsen' };

const BIRDS = ['HERON', 'FALCON', 'OSPREY', 'KESTREL', 'PLOVER', 'CURLEW', 'TERN', 'WIGEON'];
const NAMES = ['Ingrid Halvorsen', 'Tomas Brandt', 'Mirela Costa', 'Kaito Ferreira', 'Odile Santoro', 'Henrik Valdes', 'Nadia Okonkwo', 'Per Lindqvist'];

/**
 * the three facts of a probe: the fixed NEEDLES without a seed, else other values worked out from the seed, so a provider
 * that caches prompts cannot answer from an earlier probe (the same seed gives the same facts)
 *
 *   needlesFor()       // { codename: 'HERON-417', port: 8472, owner: 'Ingrid Halvorsen' }
 *   needlesFor(12345)  // other facts, always the same for 12345
 */
export function needlesFor(seed) {
  if(seed === undefined || seed === null) return NEEDLES;
  const n = Math.abs(Math.floor(+seed)) || 1;
  return { codename: `${BIRDS[n % BIRDS.length]}-${100 + (n * 7919) % 900}`, port: 1024 + ((n * 104729) % 60000), owner: NAMES[Math.floor(n / 7) % NAMES.length] };
}

const CHARS_PER_TOKEN = 4;
export const DEEP_MAX = 12000;
export const DEEP_MIN = 1500;

/** how many tokens to send to a model with this context window: a quarter of it, within [DEEP_MIN, DEEP_MAX]; unknown windows get 4000 */
export const deepBudget = ctx => (ctx > 0 ? Math.max(DEEP_MIN, Math.min(DEEP_MAX, Math.floor(ctx * 0.25))) : 4000);

const TOOLS = [
  { name: 'report_findings', description: 'Reports the facts the summary states.', parameters: { type: 'object', properties: { codename: { type: 'string', description: 'the build codename' }, port: { type: 'integer', description: 'the deploy port' }, owner: { type: 'string', description: 'the module owner' } }, required: ['codename', 'port', 'owner'] } },
  { name: 'read_file', description: 'Reads a file of the project and returns its text.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'path relative to the project root' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, required: ['path'] } },
  { name: 'run_command', description: 'Runs a shell command in the project directory and returns its output.', parameters: { type: 'object', properties: { command: { type: 'string' }, timeout_ms: { type: 'integer' } }, required: ['command'] } },
  { name: 'edit_file', description: 'Replaces one exact string of a file with another.', parameters: { type: 'object', properties: { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } }, required: ['path', 'old', 'new'] } },
];

const FILES = ['src/parser.c', 'src/lexer.c', 'lib/stream.js', 'lib/headers.js', 'tests/test-fetch.js', 'src/alloc.c', 'lib/url.js', 'src/queue.c', 'doc/building.md', 'lib/body.js'];
const VERBS = ['reads', 'writes', 'checks', 'rebuilds', 'compares', 'rewrites', 'traces', 'lists'];
const NOTES = ['the cache key ignores the scheme', 'a trailing slash is dropped twice', 'the queue is drained before the close', 'the header table is sorted on insert', 'the timeout is counted in ticks, not ms', 'the buffer grows by a half, not a double'];

/** filler line number n: tool-result-like text, deterministic */
function filler(n) {
  const f = FILES[n % FILES.length];
  return `[tool ${n}] ${f}:${100 + ((n * 37) % 900)} ${VERBS[n % VERBS.length]} ${NOTES[(n * 5) % NOTES.length]}; exit ${n % 7 === 0 ? 1 : 0}; ${20 + ((n * 13) % 80)} lines`;
}

/**
 * @param {number} tokens  about how many tokens the whole request should have (tool schemas included)
 * @returns {{messages: object[], tools: object[], needles: object, approxTokens: number}}
 */
export function buildProbe(tokens, seed) {
  const NEEDLES = needlesFor(seed);
  const system = 'You are a coding assistant continuing the work of an earlier session. Use the summary below as your memory. When the user asks for facts from it, call the matching tool with exact values.';
  const toolChars = JSON.stringify(TOOLS).length;
  const budget = Math.max(400, tokens * CHARS_PER_TOKEN - toolChars - system.length - 300);

  const facts = [
    [0.1, `Decision: the build is codenamed ${NEEDLES.codename}.`],
    [0.5, `Decision: the service is deployed on port ${NEEDLES.port}.`],
    [0.9, `Decision: the owner of the stream module is ${NEEDLES.owner}.`],
  ];

  const lines = [];
  let chars = 0;
  let next = 0;
  for(let n = 1; chars < budget; n++) {
    while(next < facts.length && chars >= facts[next][0] * budget) {
      lines.push(facts[next][1]);
      chars += facts[next][1].length + 1;
      next++;
    }
    const l = filler(n);
    lines.push(l);
    chars += l.length + 1;
  }
  while(next < facts.length) lines.push(facts[next++][1]);

  const summary = `Summary of the earlier session (compacted):\n${lines.join('\n')}`;
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: summary },
    { role: 'assistant', content: 'Understood. I have the summary.' },
    { role: 'user', content: 'Report the build codename, the deploy port and the owner of the stream module with the report_findings tool.' },
  ];

  return { messages, tools: TOOLS, needles: NEEDLES, approxTokens: Math.round((JSON.stringify(messages).length + toolChars) / CHARS_PER_TOKEN) };
}

/** the same question without tools, for a model that takes none */
export const plainQuestion = p => [...p.messages.slice(0, -1), { role: 'user', content: 'State the build codename, the deploy port and the owner of the stream module, in one line.' }];

/**
 * @param {{content?: string, toolCalls?: object[]}} reply
 * @returns {{recall: number, toolCall: boolean, args?: object}}  recall: how many of the three facts came back right
 */
export function grade(reply, needles = NEEDLES) {
  const call = reply.toolCalls?.find(c => c.name === 'report_findings');
  let args = call?.arguments ?? call?.args ?? null;
  if(typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch(e) {
      args = null;
    }
  }

  const hay = args ? JSON.stringify(args) : String(reply.content ?? '');
  const recall = [needles.codename, String(needles.port), needles.owner].filter(x => hay.toLowerCase().includes(x.toLowerCase())).length;

  return { recall, toolCall: !!call, ...(args ? { args } : {}) };
}
