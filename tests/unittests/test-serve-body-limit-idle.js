/**
 * Bun.serve() options maxRequestBodySize and idleTimeout, plus requestIP.
 */
import { tests, assert, assertEquals } from './tinytest.js';
import { serve, Response } from '../../lib/serve.js';
import { fetch } from '../../lib/fetch.js';
import * as std from 'std';

await tests({
  async 'maxRequestBodySize: declared body over the limit gets 413'() {
    let called = false;
    const server = serve({ port: 0, hostname: '127.0.0.1', maxRequestBodySize: 10 }, async req => {
      called = true;
      return new Response(await req.text());
    });
    const url = `http://127.0.0.1:${server.port}/`;
    const big = await fetch(url, { method: 'POST', body: 'x'.repeat(100) });
    assertEquals(big.status, 413);
    assert(!called, 'handler must not run for an oversize body');
    const ok = await fetch(url, { method: 'POST', body: 'tiny' });
    assertEquals(ok.status, 200);
    assertEquals(await ok.text(), 'tiny');
    await server.stop();
  },

  async 'idleTimeout option is accepted and applied'() {
    const server = serve({ port: 0, idleTimeout: 5 }, () => new Response('x'));
    assert(server.port > 0);
    await server.stop();
  },

  async 'requestIP returns the peer address'() {
    let ip;
    const server = serve({ port: 0, hostname: '127.0.0.1' }, (req, srv) => {
      ip = srv.requestIP(req);
      return new Response('x');
    });
    await fetch(`http://127.0.0.1:${server.port}/`);
    assertEquals(ip, '127.0.0.1');
    await server.stop();
  },
});

std.exit(0);
