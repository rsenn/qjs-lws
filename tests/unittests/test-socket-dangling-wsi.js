/*
 * A LWSSocket reached through LWSContext.contexts[i].sockets() (or the static
 * LWSContext.sockets()) must stay safe to inspect after its struct lws was
 * destroyed: .local/.peer/.fd/.tls must not hand a dangling s->wsi to
 * lws_get_socket_fd() & co. Run under valgrind/ASAN to see the invalid read;
 * without them the checks still catch a crash or a stale fd.
 * qjsm loads the installed lws.so unless QUICKJS_MODULE_PATH points at the
 * build directory, so set it when testing a fresh build. valgrind also
 * reports unrelated realloc(0) noise from qjs-modules; look for frames in
 * lws-socket.c / lws-context.c.
 */
import { tests, assert, assertStrictEquals } from './tinytest.js';
import { LWSContext, createServer, LWS_WRITE_HTTP_FINAL, LWSMPRO_CALLBACK } from 'lws.so';
import * as os from 'os';
import * as std from 'std';
import { freePort } from './subprocess-utils.js';

const sleep = ms => new Promise(r => os.setTimeout(r, ms));

/* every getter that dereferences s->wsi; none may throw or crash */
function touch(s) {
  const out = {};

  for(const k of ['local', 'peer', 'fd', 'tls', 'method', 'protocol', 'uri', 'vhost', 'parent', 'child', 'network', 'peerWriteAllowance', 'bufferedAmount'])
    out[k] = s[k];

  return out;
}

function makeServer(port, extra = {}) {
  return createServer({
    port,
    vhostName: 'localhost',
    mounts: [{ mountpoint: '/', protocol: 'http', originProtocol: LWSMPRO_CALLBACK }],
    protocols: [
      {
        name: 'http',
        /* headers only: the body never completes, so the connection stays
           open until a test closes it (a finished loopback response closes
           before the test gets to look at the live socket) */
        onHttp(wsi) {
          wsi.respond(200, 1000, {});
        },
        ...extra,
      },
    ],
  });
}

/* destroy whatever a test created even when one of its asserts throws, so a
   failure does not leave live contexts behind for the next test */
async function guarded(contexts, fn) {
  try {
    await fn();
  } finally {
    for(const c of contexts) c.destroy();
  }
}

/* contexts reached through the global list, as the scenario states */
const globalCtx = ctx => LWSContext.contexts.find(c => c === ctx);

await tests({
  async 'retained client socket: .local after close is null/undefined, no crash'() {
    const port = freePort();
    const server = makeServer(port);
    let established;
    const client = new LWSContext({
      protocols: [{ name: 'http', onEstablishedClientHttp(wsi) { established = wsi; } }],
    });

    await guarded([client, server], async () => {
      client.clientConnect({ address: '127.0.0.1', port, path: '/', host: 'localhost', method: 'GET', protocol: 'http' });
      for(let i = 0; i < 100 && !established; i++) await sleep(10);
      assert(established, 'client never established');

      const c = globalCtx(client);
      assert(c, 'client context not in LWSContext.contexts');
      const held = c.sockets().find(s => s === established);
      assert(held, 'client socket not in ctx.sockets()');
      assert(held.local === null || typeof held.local.port == 'number', 'bad local while live');

      established.close();
      await sleep(300);
      std.gc();

      /* the held wrapper outlives the wsi */
      const r = touch(held);
      assert(r.local === null || r.local === undefined, 'stale .local: ' + r.local);
      assert(!(held.fd > 0), 'stale fd after close: ' + held.fd);
      assert(!c.sockets().includes(held), 'closed socket still listed');
    });
  },

  async 'every socket in the list stays inspectable across close of the others'() {
    const port = freePort();
    const server = makeServer(port);
    const seen = [];
    const client = new LWSContext({
      protocols: [{ name: 'http', onEstablishedClientHttp(wsi) { seen.push(wsi); } }],
    });

    await guarded([client, server], async () => {
      for(let i = 0; i < 5; i++)
        client.clientConnect({ address: '127.0.0.1', port, path: '/', host: 'localhost', method: 'GET', protocol: 'http' });
      for(let i = 0; i < 50 && !seen.length; i++) await sleep(10);

      /* some of the five may still be queued behind the first (no role yet) */
      const snapshot = globalCtx(client).sockets();
      assert(snapshot.length >= 2, 'expected several sockets, got ' + snapshot.length);

      /* close from inside the iteration: later list entries lose their wsi */
      for(const s of snapshot) {
        touch(s);
        for(const o of seen) try { o.close(); } catch(e) {}
      }

      await sleep(300);
      std.gc();

      for(const s of snapshot) {
        const r = touch(s);
        assert(r.local === null || r.local === undefined, 'stale .local after close');
      }
    });
  },

  async 'server-side accepted sockets: .local read in and after onClosed'() {
    const port = freePort();
    const accepted = [];
    const afterClose = [];
    const server = makeServer(port, {
      onClosed(wsi) { afterClose.push(touch(wsi)); },
      onHttp(wsi) {
        accepted.push(wsi);
        wsi.respond(200, 2, {});
        wsi.write('ok', LWS_WRITE_HTTP_FINAL);
      },
    });
    let done = false;
    const client = new LWSContext({
      protocols: [{ name: 'http', onClosedClientHttp() { done = true; } }],
    });

    client.clientConnect({ address: '127.0.0.1', port, path: '/', host: 'localhost', method: 'GET', protocol: 'http' });
    for(let i = 0; i < 100 && !accepted.length; i++) await sleep(10);
    await sleep(200);
    std.gc();

    for(const w of accepted) {
      const r = touch(w);
      assert(r.local === null || r.local === undefined, 'stale server-side .local');
    }

    /* contexts list still sane after the connections are gone */
    for(const c of LWSContext.contexts) for(const s of c.sockets()) touch(s);

    client.destroy();
    server.destroy();
  },

  async 'sockets of a destroyed context: held wrappers survive ctx.destroy()'() {
    const port = freePort();
    const server = makeServer(port);
    let established;
    const client = new LWSContext({
      protocols: [{ name: 'http', onEstablishedClientHttp(wsi) { established = wsi; } }],
    });

    await guarded([], async () => {
      client.clientConnect({ address: '127.0.0.1', port, path: '/', host: 'localhost', method: 'GET', protocol: 'http' });
      for(let i = 0; i < 100 && !established; i++) await sleep(10);
      assert(established, 'client never established');

      /* only this test's own contexts: its sockets are all live here */
      const held = globalCtx(client).sockets().concat(globalCtx(server).sockets());
      assert(held.some(s => s.local && s.local.port == port), 'listening socket missing');

      client.destroy();
      server.destroy();
      std.gc();

      for(const s of held) {
        const r = touch(s);
        assert(r.local === null || r.local === undefined, 'stale .local after context destroy');
      }
    });
  },
});

std.exit(0);
