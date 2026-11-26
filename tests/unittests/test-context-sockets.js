/*
 * LWSContext.contexts, LWSContext.sockets() and ctx.sockets(): the per-context
 * socket registry (doc/DESIGN.md "Socket and context registries"). The
 * Bun-style TCPSocket wrapper owns its context, so these checks use the
 * statics exactly as code without a context reference has to.
 */
import { tests, eq, assert, assertStrictEquals } from './tinytest.js';
import { LWSContext, LWSSocket, createServer } from 'lws.so';
import * as std from 'std';
import { TCPSocket } from '../../lib/tcpsocket.js';
import { freePort } from './subprocess-utils.js';

await tests({
  'LWSContext.contexts lists a live context'() {
    const ctx = new LWSContext({ port: -1 });

    assert(LWSContext.contexts.includes(ctx), 'new context not listed');
    ctx.destroy();
  },

  'ctx.sockets() is an array, empty for a fresh context'() {
    const ctx = new LWSContext({ port: -1 });
    const list = ctx.sockets();

    assert(Array.isArray(list), 'not an array');
    assertStrictEquals(0, list.length);
    ctx.destroy();
  },

  async 'sockets of a TCPSocket server are visible without a context reference'() {
    const port = freePort();
    const before = LWSContext.sockets().length;
    let resolveOpen;
    const opened = new Promise(r => (resolveOpen = r));

    const server = TCPSocket.listen({
      hostname: '127.0.0.1',
      port,
      socket: { open(socket) { resolveOpen(); }, data() {} },
    });

    const client = await TCPSocket.connect({ hostname: '127.0.0.1', port, socket: { data() {} } });
    await opened;

    const all = LWSContext.sockets();

    assert(all.length > before, `expected more than ${before} sockets, got ${all.length}`);

    const owner = LWSContext.contexts.filter(c => c.sockets().length);

    assert(owner.length >= 1, 'no context owns a socket');
    assertStrictEquals(all.length, LWSContext.contexts.reduce((n, c) => n + c.sockets().length, 0));

    for(const s of all) assertStrictEquals(s, LWSSocket.get(s.id));

    /* peer and local never throw, so an inspector can walk every socket */
    for(const s of all) {
      const { peer, local } = s;

      assert(peer === null || typeof peer.port == 'number', 'bad peer');
      assert(local === null || typeof local.port == 'number', 'bad local');
    }

    const listener = all.find(s => s.local && s.local.port == port && s.peer === null);

    assert(listener, 'listening socket (local set, peer null) not found');

    client.end?.();
    server.stop();
  },
});

/* the TCPSocket wrapper's own context keeps the event loop alive */
std.exit(0);
