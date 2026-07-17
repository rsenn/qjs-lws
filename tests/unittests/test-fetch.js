/**
 * Tests lib/fetch.js's `fetch()` against a plain createServer() (not
 * lib/serve.js, to keep this focused on the client side specifically).
 *
 * The root-level tests/test-fetch.js is a separate, non-assertion-based
 * crawl script exercising the HTTP/1.1 vs H2, plain vs TLS matrix; this
 * file is the tinytest-shaped regression coverage TODO.md flagged as
 * missing, focused on request construction correctness rather than
 * protocol-matrix coverage.
 */
import { tests, eq, assert, assertStrictEquals } from './tinytest.js';
import { createServer, toString, LWSMPRO_CALLBACK, LWS_WRITE_HTTP_FINAL } from 'lws.so';
import { fetch } from '../../lib/fetch.js';
import { freePort } from './subprocess-utils.js';
import * as std from 'std';

function echoServer(port, handler) {
  return createServer({
    port,
    vhostName: 'localhost',
    mounts: [{ mountpoint: '/', protocol: 'http', originProtocol: LWSMPRO_CALLBACK }],
    protocols: [{ name: 'http', onHttp: handler }],
  });
}

await tests({
  async 'fetch(): GET retrieves status, headers, and body'() {
    const port = freePort();
    const server = echoServer(port, wsi => {
      wsi.respond(200, { 'content-type': 'text/plain', 'x-custom': 'yes', 'content-length': '5' });
      wsi.write('hello', LWS_WRITE_HTTP_FINAL);
    });

    const resp = await fetch(`http://127.0.0.1:${port}/`, { keepAlive: false });

    eq(200, resp.status);
    eq('yes', resp.headers.get('x-custom'));
    eq('hello', await resp.text());

    server.destroy();
  },

  async 'fetch(): a POST sends exactly the Content-Type the caller set (regression: LCCSCF_HTTP_MULTIPART_MIME must not override it)'() {
    // lib/fetch.js used to unconditionally set LCCSCF_HTTP_MULTIPART_MIME
    // for every POST, which made lws auto-prepend its own
    // "multipart/form-data; boundary=..." Content-Type ahead of whatever
    // the caller explicitly asked for, regardless of the actual body.
    const port = freePort();
    let seenContentType;

    const server = echoServer(port, wsi => {
      seenContentType = wsi.headers['content-type'];
      wsi.respond(200, { 'content-length': '2' });
      wsi.write('ok', LWS_WRITE_HTTP_FINAL);
    });

    await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      body: 'foo=bar',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      keepAlive: false,
    });

    eq('application/x-www-form-urlencoded', seenContentType);

    server.destroy();
  },

  async 'fetch(): a POST body arrives at the server byte-for-byte'() {
    const port = freePort();
    const chunks = [];

    const server = createServer({
      port,
      vhostName: 'localhost',
      mounts: [{ mountpoint: '/', protocol: 'http', originProtocol: LWSMPRO_CALLBACK }],
      protocols: [
        {
          name: 'http',
          onHttpBody(wsi, buf) {
            chunks.push(new Uint8Array(buf));
          },
          onHttpBodyCompletion(wsi) {
            wsi.wantWrite(() => {
              wsi.respond(200, { 'content-length': '2' });
              wsi.write('ok', LWS_WRITE_HTTP_FINAL);
              return -1;
            });
          },
        },
      ],
    });

    const body = '0123456789'.repeat(500); // 5000 bytes - larger than one socket read
    const resp = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body, keepAlive: false });

    eq(200, resp.status);

    let total = 0;
    for(const c of chunks) total += c.byteLength;
    const merged = new Uint8Array(total);
    let offset = 0;
    for(const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }

    const received = toString(merged.buffer);
    assert(received.length === body.length, `expected ${body.length} bytes, got ${received.length}`);
    assert(received === body, 'expected the received body to match what was sent, byte for byte');

    server.destroy();
  },

  async 'fetch(): follows a 3xx redirect automatically'() {
    const port = freePort();

    const server = echoServer(port, wsi => {
      if(wsi.uri === '/start') {
        wsi.respond(302, { location: '/final' });
        wsi.write('', LWS_WRITE_HTTP_FINAL);
        return;
      }

      wsi.respond(200, { 'content-type': 'text/plain', 'content-length': '8' });
      wsi.write('final-ok', LWS_WRITE_HTTP_FINAL);
    });

    const resp = await fetch(`http://127.0.0.1:${port}/start`, { keepAlive: false });

    eq(200, resp.status);
    eq('final-ok', await resp.text());

    server.destroy();
  },
});

// fetch() keeps a lazily-created LWSContext singleton alive for the life
// of the process (shared across calls by design) - unlike every other
// suite here, nothing in this file ever destroys it, so the event loop
// would otherwise never drain on its own.
std.exit(0);
