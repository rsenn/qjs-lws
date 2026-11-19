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

await check('/v1/models carries the gateway metadata', async () => {
  const m = (await (await fetch(`${base}/models`)).json()).data.find(m => m.id == 'fake');
  expect(m.name == 'Fake' && m.context_window == 8000 && m.context_length == 8000, JSON.stringify(m));
  expect(m.execution_status == 'ready' && m.available === true, 'status ' + m.execution_status);
  expect(m.supported_parameters.includes('tools') && m.supported_parameters.includes('stream'), m.supported_parameters.join());
  expect(m.capabilities.tools === true, JSON.stringify(m.capabilities));
});

await check('a reply has an estimated usage and routing headers', async () => {
  const res = await say('[[pong]]');
  const j = await res.json();
  const u = j.usage;
  expect(u.estimated === true && u.prompt_tokens > 0 && u.completion_tokens > 0, JSON.stringify(u));
  expect(u.total_tokens == u.prompt_tokens + u.completion_tokens, 'sum ' + JSON.stringify(u));
  expect(res.headers.get('x-routed-via') == 'fake/default', 'x-routed-via ' + res.headers.get('x-routed-via'));
  expect(res.headers.get('x-request-id') == j.id, `x-request-id ${res.headers.get('x-request-id')} vs ${j.id}`);
  expect(+res.headers.get('x-response-ms') >= 0, 'x-response-ms ' + res.headers.get('x-response-ms'));
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
  const text = chunks.map(l => JSON.parse(l.slice(6)).choices[0]?.delta?.content ?? '').join('');
  expect(text.includes('until the text is complete'), 'text: ' + text);
  const last = JSON.parse(raw.split('\n').filter(l => l.startsWith('data: ') && !l.includes('[DONE]')).pop().slice(6));
  expect(last.usage?.estimated === true && last.usage.completion_tokens > 0, 'usage chunk ' + JSON.stringify(last));
  expect(res.headers.get('x-routed-via') == 'fake/default' && res.headers.get('x-request-id') == last.id, 'headers ' + res.headers.get('x-request-id'));
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

/* auto routing: alpha (rank 1) and omega (rank 2) are two working pages; alpha's port is the third argument */
const portA = scriptArgs[2];
const route = (body, headers) => call({ model: 'auto', ...body }, headers);
const via = res => res.headers.get('x-routed-via');

await check('auto is a model, with its axes', async () => {
  const ids = (await (await fetch(`${base}/models`)).json()).data.map(m => m.id);
  for(const id of ['auto', 'auto:smart', 'auto:fast', 'auto:reliable', 'auto:cheap', 'auto:balanced']) expect(ids.includes(id), `no ${id} in ${ids}`);
});

await check('auto picks the best ranked ready site', async () => {
  const res = await route({ messages: [{ role: 'user', content: '[[pong]]' }] }, { 'x-session-id': 's1' });
  expect(res.status == 200 && via(res) == 'alpha/default', `${res.status} ${via(res)}`);
});

await check('a conversation stays on its site while auto:cheap would prefer another', async () => {
  const res = await route({ model: 'auto:cheap', messages: [{ role: 'user', content: '[[pong]]' }] }, { 'x-session-id': 's1' });
  expect(via(res) == 'alpha/default', 'routed via ' + via(res));
  const other = await route({ model: 'auto:cheap', messages: [{ role: 'user', content: '[[pong]]' }] });
  expect(via(other) == 'omega/default', 'without a session: ' + via(other));
});

await check('auto tries the next site when the first refuses, and says so in the headers', async () => {
  const res = await route({ messages: [{ role: 'user', content: `[[pong]] [[limit@${portA}]]` }] });
  expect(res.status == 200 && via(res) == 'omega/default', `${res.status} via ${via(res)}`);
  expect(res.headers.get('x-fallback-attempts') == '1' && res.headers.get('x-fallback-trail') == 'alpha/default key1: rate_limit', 'trail ' + res.headers.get('x-fallback-trail'));
  expect((await res.json()).choices[0].message.content == 'pong', 'the reply');
});

await check('when every site refuses it is the gateway\'s all-models error with the trail', async () => {
  const res = await route({ messages: [{ role: 'user', content: '[[limit]]' }] });
  const j = await res.json();
  expect(res.status == 429 && j.error.code == 'routing_exhausted' && /All models rate-limited after 1 attempt/.test(j.error.message) && /omega\/default key1: rate_limit/.test(j.error.message), `${res.status} ${JSON.stringify(j)}`);
  expect(+res.headers.get('retry-after') > 0 && res.headers.get('x-fallback-trail') == 'omega/default key1: rate_limit', 'headers');
  const again = await (await route({ messages: [{ role: 'user', content: '[[pong]]' }] })).json();
  expect(/All models exhausted/.test(again.error.message), again.error.message);
});

/* last: a rate-limited site cools down, later requests fail at once */
await check('a limit notice is a 429 rate_limit_exceeded with Retry-After', async () => {
  const res = await say('[[limit]]');
  const j = await res.json();
  expect(res.status == 429 && j.error?.code == 'rate_limit_exceeded', `${res.status} ${JSON.stringify(j)}`);
  expect(+res.headers.get('retry-after') == 10800, 'retry-after ' + res.headers.get('retry-after'));
});

await check('the counters, the health and the learned quota show the refusal', async () => {
  const get = async path => (await fetch(`${base}/${path}`)).json();
  const u = await get('usage');
  const fake = u.byPlatform.find(p => p.platform == 'fake');
  expect(u.object == 'usage' && u.source == 'chat-bridge' && fake?.requests >= 5 && fake.tokens > 0, JSON.stringify(u));

  const p = (await get('providers')).providers.find(p => p.platform == 'fake');
  expect(p.status == 'rate_limited' && p.resume_at && /limit/.test(p.last_error), JSON.stringify(p));
  expect(p.success_rate > 0 && p.success_rate < 1 && p.median_ms >= 0, `success ${p.success_rate} median ${p.median_ms}`);

  /* what the fake site took before it refused is its learned budget */
  const pool = (await get('quota-forecast')).pools.find(q => q.pool == 'fake');
  expect(pool?.limit >= 3 && pool.remaining == pool.limit && pool.reset_at, JSON.stringify(pool));
});

await check('a cooling site is execution_status exhausted with a reset time', async () => {
  const m = (await (await fetch(`${base}/models`)).json()).data.find(m => m.id == 'fake');
  expect(m.execution_status == 'exhausted' && m.available === false && m.resets_at, JSON.stringify(m));
});

console.log(failed ? `${failed} failed` : 'all passed');
exit(failed ? 1 : 0);
