/**
 * Sequential fetch() calls to a server that answers "connection: close"
 * (serve() does) must not fail with "server closed before responding": the
 * request queued onto the dead shared connection is retried on a fresh one.
 */
import { exit } from 'std';
import { setTimeout } from 'os';
import { assertEquals } from './tinytest.js';
import { serve, Response } from '../../lib/serve.js';
import { fetch } from '../../lib/fetch.js';

const server = serve({ port: 0, hostname: '127.0.0.1' }, () => new Response('ok'));
const url = `http://127.0.0.1:${server.port}/`;

for(const [method, body] of [['GET'], ['POST', 'x'], ['GET'], ['POST', 'y']]) {
  const res = await fetch(url, { method, body, h2: false });
  assertEquals('ok', await res.text(), `${method} after earlier requests`);
}

console.log('4 sequential keep-alive fetches succeeded.');
server.stop();
setTimeout(() => exit(0), 0);
