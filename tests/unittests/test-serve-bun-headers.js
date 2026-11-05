/**
 * Default response headers of serve(), the way Bun sends them: the content
 * type of a body it can tell the type of is added at send time, Response.json
 * has no space before the charset, and any amount of headers goes out.
 */
import { exit } from 'std';
import { assertEquals } from './tinytest.js';
import { serve, Response } from '../../lib/serve.js';
import { fetch } from '../../lib/fetch.js';
import { URL } from '../../lib/lws/url.js';

const many = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`x-h-${i}`, 'v'.repeat(100)]));

const server = serve({ port: 0, hostname: '127.0.0.1' }, req => {
  const p = new URL(req.url, 'http://x').pathname;
  if(p == '/json') return Response.json({ a: 1 });
  if(p == '/bytes') return new Response(new Uint8Array([104, 105]));
  if(p == '/none') return new Response(null, { status: 204 });
  if(p == '/many') return new Response('ok', { headers: many });
  return new Response('hello');
});

const get = async path => fetch(`http://127.0.0.1:${server.port}${path}`, { h2: false });

let r = await get('/');
assertEquals('text/plain;charset=utf-8', r.headers.get('content-type'), 'string body');
assertEquals('hello', await r.text(), 'string body text');

r = await get('/bytes');
assertEquals('application/octet-stream', r.headers.get('content-type'), 'bytes body');

r = await get('/json');
assertEquals('application/json;charset=utf-8', r.headers.get('content-type'), 'Response.json');

r = await get('/none');
assertEquals(204, r.status, '204 status');
assertEquals(null, r.headers.get('content-length'), '204 has no content-length');

r = await get('/many');
assertEquals('ok', await r.text(), 'many headers body');

console.log('5 tests succeeded.');
server.stop();
exit(0);
