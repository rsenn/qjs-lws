/* Probes a running chat-bridge (started by run.sh against the fake site).
   Usage: qjsm probe.js http://127.0.0.1:8089/v1 */
import { fetch } from '../../../lib/fetch.js';
import { exit } from 'std';

const base = scriptArgs[1];
let failed = 0, skipped = 0;

const call = async (body, headers) => {
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'fake', ...body }),
  });
  return res;
};
const say = (content, extra) => call({ messages: [{ role: 'user', content }], ...extra });

const tools = [
  { type: 'function', function: { name: 'get_weather', description: 'weather of a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } },
];

async function check(name, fn) {
  try {
    await fn();
    console.log('✅', name);
  } catch(e) {
    failed++;
    console.log('❌', name, '-', e.message);
  }
}

const expect = (cond, msg) => {
  if(!cond) throw new Error(msg);
};

await check('/v1/models lists the fake site', async () => {
  const j = await (await fetch(`${base}/models`)).json();
  expect(j.data.some(m => m.id == 'fake'), 'fake not in ' + j.data.map(m => m.id));
});

await check('plain reply', async () => {
  const res = await say('[[pong]]');
  expect(res.status == 200, 'status ' + res.status);
  const j = await res.json();
  expect(j.choices[0].message.content == 'pong', JSON.stringify(j.choices[0].message));
});

await check('streamed reply arrives in several chunks', async () => {
  const res = await say('[[stream]]', { stream: true });
  expect(res.status == 200, 'status ' + res.status);
  const raw = await res.text();
  const chunks = raw.split('\n').filter(l => l.startsWith('data: ') && !l.includes('[DONE]'));
  expect(chunks.length >= 3, `${chunks.length} chunks`);
  const text = chunks.map(l => JSON.parse(l.slice(6)).choices[0].delta?.content ?? '').join('');
  expect(text.includes('until the text is complete'), 'text: ' + text);
});

for(const [label, marker] of [['nested arguments', '[[tool]]'], ['flat arguments with copy-button text', '[[flat]]']])
  await check(`tool call, ${label}`, async () => {
    const res = await say(marker, { tools });
    expect(res.status == 200, 'status ' + res.status);
    const c = (await res.json()).choices[0];
    expect(c.finish_reason == 'tool_calls', 'finish_reason ' + c.finish_reason);
    const call = c.message.tool_calls?.[0];
    expect(call?.function.name == 'get_weather', JSON.stringify(c.message));
    expect(JSON.parse(call.function.arguments).city == 'Berlin', call.function.arguments);
  });

await check('a prompt the page does not take is a 502 prompt_not_accepted', async () => {
  const res = await say('[[ignore]]');
  const j = await res.json();
  expect(res.status == 502 && j.error?.code == 'prompt_not_accepted', `${res.status} ${JSON.stringify(j)}`);
});

await check('a changed layout (reply selector matches nothing) is an error', async () => {
  const res = await call({ model: 'rotted', messages: [{ role: 'user', content: '[[pong]]' }] });
  expect(res.status >= 400, `status ${res.status}: ${(await res.text()).slice(0, 200)}`);
});

/* last: a rate-limited site cools down, later requests fail at once */
await check('a limit notice is a 429 rate_limit_exceeded with Retry-After', async () => {
  const res = await say('[[limit]]');
  const j = await res.json();
  expect(res.status == 429 && j.error?.code == 'rate_limit_exceeded', `${res.status} ${JSON.stringify(j)}`);
  expect(+res.headers.get('retry-after') == 10800, 'retry-after ' + res.headers.get('retry-after'));
});

console.log(failed ? `${failed} failed` : 'all passed');
exit(failed ? 1 : 0);
