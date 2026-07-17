import { tests, eq, assert, assertStrictEquals, fail } from './tinytest.js';
import { LWSContext, createServer } from 'lws.so';

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
});
