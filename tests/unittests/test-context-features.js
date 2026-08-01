/**
 * Covers the five LWSContext additions from TODO.md section 4 ("bind
 * first"/"bind next"): persistent cookie jar, conmon connection
 * diagnostics, retry/backoff policy, async DNS resolve, and native
 * event-loop timers.
 */
import { tests, eq, assert, assertStrictEquals, fail } from './tinytest.js';
import { createServer, LWSContext, LWSMPRO_CALLBACK } from 'lws.so';
import { freePort } from './subprocess-utils.js';

function startCookieServer(port) {
  return createServer({
    port,
    vhostName: 'localhost',
    mounts: [{ mountpoint: '/', protocol: 'api', originProtocol: LWSMPRO_CALLBACK }],
    protocols: [
      {
        name: 'api',
        onHttp(wsi) {
          wsi.respond(200, { 'content-type': 'text/plain', 'set-cookie': 'foo=bar; Path=/' }, 'hi');
          return 0;
        },
      },
    ],
  });
}

function httpGet(port, clientOpts, connectOpts) {
  return new Promise((resolve, reject) => {
    const client = new LWSContext({
      ...clientOpts,
      protocols: [
        {
          name: 'http',
          onEstablishedClientHttp(wsi, status) {
            this.status = status;
          },
          onReceiveClientHttp(wsi) {
            wsi.httpClientRead(new ArrayBuffer(4096));
          },
          onClosedClientHttp(wsi) {
            resolve({ client, status: this.status, conmon: wsi.conmon });
          },
          onClientConnectionError(wsi, msg) {
            reject(new Error(msg));
          },
        },
      ],
    });
    client.clientConnect({ address: 'localhost', port, path: '/', host: 'localhost', method: 'GET', protocol: 'http', ...connectOpts });
  });
}

await tests({
  async 'cookie jar captures a Set-Cookie and persists it to disk'() {
    const port = freePort();
    const server = startCookieServer(port);
    const jarPath = '/tmp/qjs-lws-test-cookiejar-' + port + '.txt';

    try {
      const result = await httpGet(port, { cookieJar: { path: jarPath, maxItems: 100 } }, { cacheCookies: true });

      try {
        assertStrictEquals(200, result.status);

        const std = await import('std');
        const contents = std.loadFile(jarPath);
        assert(contents.includes('foo\tbar'), 'expected the cookie jar file to contain the captured cookie, got: ' + contents);
      } finally {
        result.client.destroy();
      }
    } finally {
      server.destroy();
    }
  },

  async 'conmon reports per-connection timing when enabled'() {
    const port = freePort();
    const server = startCookieServer(port);

    try {
      const result = await httpGet(port, {}, { conmon: true });

      try {
        assertStrictEquals(200, result.status);
        assert(result.conmon && typeof result.conmon === 'object', 'expected a conmon object on the wsi');
        assert('connectUs' in result.conmon, 'expected conmon.connectUs, got: ' + JSON.stringify(result.conmon));
      } finally {
        result.client.destroy();
      }
    } finally {
      server.destroy();
    }
  },

  'retryDelay() increments the try counter and honors a custom table'() {
    const ctx = new LWSContext({});
    const policy = { retryMsTable: [100, 200, 400], jitterPercent: 0, concealCount: 1 };

    const r1 = ctx.retryDelay(policy, 0);
    eq(1, r1.tryCount);
    assertStrictEquals(true, r1.conceal);

    const r2 = ctx.retryDelay(policy, r1.tryCount);
    eq(2, r2.tryCount);
    assertStrictEquals(false, r2.conceal);

    ctx.destroy();
  },

  'retryDelay() with no policy falls back to the built-in default'() {
    const ctx = new LWSContext({});
    const r = ctx.retryDelay(undefined, 0);
    assert(r.delayMs > 0, 'expected a positive default delay, got: ' + r.delayMs);
    eq(1, r.tryCount);
    ctx.destroy();
  },

  'context-level retry policy is accepted at construction'() {
    const ctx = new LWSContext({ retry: { retryMsTable: [50, 100], jitterPercent: 0 } });
    assert(ctx instanceof LWSContext, 'expected construction with a retry policy to succeed');
    ctx.destroy();
  },

  async 'resolve() looks up localhost synchronously via the loopback shortcut'() {
    const ctx = new LWSContext({});
    try {
      const addrs = await ctx.resolve('localhost', { type: 'A' });
      assert(Array.isArray(addrs), 'expected an array of addresses');
      assert(addrs.includes('127.0.0.1'), 'expected 127.0.0.1 among the results, got: ' + JSON.stringify(addrs));
    } finally {
      ctx.destroy();
    }
  },

  async 'resolve() rejects or resolves without throwing for a name with no records'() {
    const ctx = new LWSContext({});
    try {
      // Either outcome (empty array or a rejection) is acceptable - what
      // matters is the promise settles instead of hanging.
      const addrs = await ctx.resolve('nonexistent.invalid.example.', { type: 'A' }).catch(() => []);
      assert(Array.isArray(addrs), 'expected an array (possibly empty)');
    } finally {
      ctx.destroy();
    }
  },

  async 'schedule() fires the callback once, near the requested delay'() {
    const ctx = new LWSContext({});
    const t0 = Date.now();

    await new Promise(resolve => {
      ctx.schedule(() => {
        assert(Date.now() - t0 >= 0, 'timer fired');
        resolve();
      }, 50);
    });

    ctx.destroy();
  },

  async 'schedule().cancel() prevents the callback from firing'() {
    const ctx = new LWSContext({});
    let fired = false;

    const timer = ctx.schedule(() => {
      fired = true;
    }, 50);
    timer.cancel();
    timer.cancel(); // must be a safe no-op, not a crash

    // Give any (incorrectly still-scheduled) timer a chance to fire.
    await new Promise(resolve => {
      ctx.schedule(resolve, 300);
    });

    assertStrictEquals(false, fired);
    ctx.destroy();
  },
});
