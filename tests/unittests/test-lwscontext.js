import { tests, eq, assert, assertStrictEquals, fail } from './tinytest.js';
import { LWSContext, createServer, LWS_SERVER_OPTION_ONLY_RAW, LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG } from 'lws.so';

function freePort() {
  // Unlikely-to-collide high port range for this test file's own use.
  return 18000 + (Date.now() % 900) + Math.floor(Math.random() * 50);
}

await tests({
  'client-only construction (no port) succeeds'() {
    const ctx = new LWSContext({ protocols: [{ name: 'http' }] });
    assert(ctx instanceof LWSContext, 'expected an LWSContext instance');
    ctx.destroy();
  },

  'createServer() is equivalent to new LWSContext()'() {
    const ctx = createServer({ protocols: [{ name: 'http' }] });
    assert(ctx instanceof LWSContext, 'expected createServer() to return an LWSContext instance');
    ctx.destroy();
  },

  'listening on a port succeeds and destroy() tears it down'() {
    const port = freePort();
    const ctx = createServer({ port, vhostName: 'localhost', protocols: [{ name: 'http' }] });
    assert(ctx instanceof LWSContext, 'expected an LWSContext instance');
    const result = ctx.destroy();
    assertStrictEquals(true, result);
  },

  'destroy() is idempotent-safe (second call does not throw)'() {
    const ctx = new LWSContext({ protocols: [{ name: 'http' }] });
    assertStrictEquals(true, ctx.destroy());
    ctx.destroy(); // no-op on an already-destroyed context; must not throw
  },

  'methods on a destroyed context throw InternalError'() {
    const ctx = new LWSContext({ protocols: [{ name: 'http' }] });
    ctx.destroy();
    try {
      ctx.cancelService();
      fail('expected a throw calling a method on a destroyed context');
    } catch(e) {
      assert(/destroyed/i.test(e.message), 'expected a "destroyed" error message, got: ' + e.message);
    }
  },

  'hostname accessor returns a non-empty string'() {
    const ctx = new LWSContext({ protocols: [{ name: 'http' }] });
    assert(typeof ctx.hostname === 'string' && ctx.hostname.length > 0, 'expected a non-empty hostname string');
    ctx.destroy();
  },

  'protocols accessor reflects the registered protocol names'() {
    const ctx = new LWSContext({ protocols: [{ name: 'http' }, { name: 'chat' }] });
    const names = ctx.protocols.map(p => p.name);
    assert(names.includes('http'), 'expected "http" among registered protocols, got: ' + names.join(','));
    assert(names.includes('chat'), 'expected "chat" among registered protocols, got: ' + names.join(','));
    ctx.destroy();
  },

  'getVhostByName() finds the default vhost, returns undefined for an unknown name'() {
    const ctx = new LWSContext({ vhostName: 'localhost', protocols: [{ name: 'http' }] });
    const vh = ctx.getVhostByName('localhost');
    assert(vh !== undefined, 'expected to find the default vhost by name');
    assertStrictEquals(undefined, ctx.getVhostByName('no-such-vhost'));
    ctx.destroy();
  },

  'info property retains the options object passed to the constructor'() {
    const opts = { protocols: [{ name: 'http' }], vhostName: 'localhost' };
    const ctx = new LWSContext(opts);
    eq('localhost', ctx.info.vhostName ?? ctx.info.vhost_name);
    ctx.destroy();
  },

  'camelCase and snake_case option names are both accepted'() {
    const ctx = new LWSContext({ vhost_name: 'localhost', protocols: [{ name: 'http' }] });
    assert(ctx instanceof LWSContext, 'expected construction with vhost_name to succeed');
    ctx.destroy();
  },

  /* Regression for BUGS: option-key-casing-silently-ignored. localPort
     (client_connect_info_fromobj, lws-context.c) was gated by a plain
     js_has_property() exact-match check with no camelCase fallback, so
     clientConnect({ localPort }) silently bound the default (any) source
     port instead of throwing or working - confirmed here by having the
     server read back the actual source port the connection arrived from
     (wsi.peer.port) and asserting it matches what was requested. */
  async 'clientConnect({ localPort }) binds the outgoing connection to that source port'() {
    const port = freePort();
    const sourcePort = freePort();

    let resolvePort, rejectClient;
    const observed = new Promise((resolve, reject) => {
      resolvePort = resolve;
      rejectClient = reject;
    });

    const server = createServer({
      port,
      options: LWS_SERVER_OPTION_ONLY_RAW | LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG,
      listenAcceptRole: 'raw-skt',
      listenAcceptProtocol: 'raw',
      protocols: [
        {
          name: 'raw',
          onRawAdopt(wsi) {
            resolvePort(wsi.peer.port);
          },
        },
      ],
    });

    const client = new LWSContext({
      protocols: [
        {
          name: 'raw',
          onRawConnected() {},
          onClientConnectionError(wsi, msg) {
            rejectClient(new Error(msg));
          },
        },
      ],
    });
    client.clientConnect({ address: 'localhost', port, method: 'RAW', protocol: 'raw', localPort: sourcePort });

    eq(sourcePort, await observed);

    client.destroy();
    server.destroy();
  },
});
