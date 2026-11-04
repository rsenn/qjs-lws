/**
 * A client that hangs up while the handler is still working must not take
 * the server down. Used to segfault: lwsjs_socket_destroy() zeroes the
 * socket's wsi when the connection closes, and the native respond() then
 * wrote through the NULL pointer (lws_add_http_header_status). Written as
 * plain top-level code, not tests(): a failed assertion must fail the
 * process (tinytest only prints it), and a crash does anyway.
 */
import * as std from 'std';
import { assertEquals } from './tinytest.js';
import { serve, Response } from '../../lib/serve.js';
import { fetch } from '../../lib/fetch.js';
import { AbortController } from '../../lib/lws/abort.js';
import { setTimeout } from 'os';

const sleep = ms => new Promise(r => setTimeout(r, ms));

let slow = 0;
const server = serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    if(req.url.includes('/slow')) {
      slow++;
      await sleep(800);
    }
    return new Response('ok');
  },
});
const base = `http://127.0.0.1:${server.port}`;

const ac = new AbortController();
const gone = fetch(`${base}/slow`, { signal: ac.signal }).then(
  () => 'answered',
  () => 'aborted',
);
await sleep(200);
ac.abort();
assertEquals('aborted', await gone);
assertEquals(1, slow);

/* the handler answers the closed connection about now; a crash would end the process here */
await sleep(1200);

const res = await fetch(`${base}/fast`);
assertEquals('ok', await res.text());
await server.stop();
console.log('server survived a client that hung up before the handler answered');

/* fetch() keeps a lazily-created context alive for the life of the process (see test-fetch.js) */
std.exit(0);
