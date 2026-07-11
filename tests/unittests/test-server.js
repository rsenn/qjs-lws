/**
 * Exercises different server setups (WebSocket, HTTP callback, static file,
 * raw TCP, HTTPS) by running each server in this process and forking off a
 * client subprocess to actually connect to it - a genuinely separate OS
 * process and event loop, not an in-process fake.
 */
import { tests, eq, assert, assertStrictEquals, fail } from './tinytest.js';
import { createServer, LWS_WRITE_TEXT, LWS_WRITE_HTTP_FINAL, LWSMPRO_NO_MOUNT, LWSMPRO_CALLBACK, LWSMPRO_FILE, LWS_SERVER_OPTION_ONLY_RAW, LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG, LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT, LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX, } from 'lws';
import { spawnAndWaitFor, stopProcess, readLog, freePort } from './subprocess-utils.js';

const REPO_ROOT = '/mnt/data/Projects/plot-cv/quickjs/qjs-lws';

async function runClient(code, marker = 'RESULT:') {
  const proc = await spawnAndWaitFor(code, marker, { timeoutMs: 8000 });
  const log = readLog(proc.logPath);
  stopProcess(proc.pid);
  return log;
}

await tests({
  async 'WebSocket echo server: a client subprocess round-trips a message'() {
    const port = freePort();
    let serverSawIt;

    const ctx = createServer({
      port,
      vhostName: 'localhost',
      mounts: [{ mountpoint: '/echo', protocol: 'echo', originProtocol: LWSMPRO_NO_MOUNT }],
      protocols: [
        {
          name: 'echo',
          onReceive(wsi, data) {
            serverSawIt = data;
            wsi.write(data, LWS_WRITE_TEXT);
          },
        },
      ],
    });

    const clientCode = `
      import { LWSContext, LWS_WRITE_TEXT } from 'lws';
      const ctx = new LWSContext({
        protocols: [{
          name: 'ws',
          onClientEstablished(wsi) { wsi.write('hello-server', LWS_WRITE_TEXT); },
          onClientReceive(wsi, data) { console.log('RESULT:' + data); ctx.cancelService(); },
          onClientConnectionError(wsi, msg) { console.log('RESULT:ERROR:' + msg); ctx.cancelService(); },
        }],
      });
      ctx.clientConnect('ws://localhost:${port}/echo', { protocol: 'echo', localProtocolName: 'ws' });
    `;

    const log = await runClient(clientCode);
    ctx.destroy();

    assert(log.includes('RESULT:hello-server'), 'expected the echoed message back, got: ' + log);
    eq('hello-server', serverSawIt);
  },

  async 'HTTP server (dynamic JS handler): a client subprocess GETs a response'() {
    const port = freePort();

    const ctx = createServer({
      port,
      vhostName: 'localhost',
      mounts: [{ mountpoint: '/api', protocol: 'api', originProtocol: LWSMPRO_CALLBACK }],
      protocols: [
        {
          name: 'api',
          onHttp(wsi) {
            // The `uri` callback argument is delivered as an ArrayBuffer, not
            // a string (see callback_protocol()'s argv-building in
            // lws-context.c) - wsi.uri is the documented, correct way to read
            // the request path as a string.
            wsi.respond(200, { 'content-type': 'text/plain' });
            wsi.write(`hello ${wsi.uri}`, LWS_WRITE_HTTP_FINAL);
          },
        },
      ],
    });

    const clientCode = `
      import { LWSContext, toString } from 'lws';
      const ctx = new LWSContext({
        protocols: [{
          name: 'http',
          onEstablishedClientHttp(wsi, status) { this.status = status; },
          onReceiveClientHttp(wsi) {
            const buf = new ArrayBuffer(4096);
            if(wsi.httpClientRead(buf)) this.onReceiveClientHttpRead(wsi, buf);
          },
          onReceiveClientHttpRead(wsi, buf, len) { console.log('RESULT:' + this.status + ':' + toString(buf, 0, len)); },
          onClosedClientHttp(wsi) { ctx.cancelService(); },
          onClientConnectionError(wsi, msg) { console.log('RESULT:ERROR:' + msg); ctx.cancelService(); },
        }],
      });
      // The string-URL form of clientConnect() for an http:// scheme never
      // actually starts the connection (a separate bug - see the final
      // summary); the object form works correctly.
      ctx.clientConnect({ address: 'localhost', port: ${port}, path: '/api/world', host: 'localhost', method: 'GET', protocol: 'http' });
    `;

    const log = await runClient(clientCode);
    ctx.destroy();

    assert(log.includes('RESULT:200:hello /api/world'), 'expected a 200 with the response body, got: ' + log);
  },

  async 'Static-file server: a client subprocess GETs a served file'() {
    const port = freePort();

    const ctx = createServer({
      port,
      vhostName: 'localhost',
      mounts: [{ mountpoint: '/', origin: REPO_ROOT + '/tests/unittests/fixtures', def: 'hello.txt', originProtocol: LWSMPRO_FILE }],
      protocols: [{ name: 'http' }],
    });

    const clientCode = `
      import { LWSContext, toString } from 'lws';
      const ctx = new LWSContext({
        protocols: [{
          name: 'http',
          onEstablishedClientHttp(wsi, status) { this.status = status; },
          onReceiveClientHttp(wsi) {
            const buf = new ArrayBuffer(4096);
            if(wsi.httpClientRead(buf)) this.onReceiveClientHttpRead(wsi, buf);
          },
          onReceiveClientHttpRead(wsi, buf, len) { console.log('RESULT:' + this.status + ':' + toString(buf, 0, len)); },
          onClosedClientHttp(wsi) { ctx.cancelService(); },
          onClientConnectionError(wsi, msg) { console.log('RESULT:ERROR:' + msg); ctx.cancelService(); },
        }],
      });
      ctx.clientConnect({ address: 'localhost', port: ${port}, path: '/hello.txt', host: 'localhost', method: 'GET', protocol: 'http' });
    `;

    const log = await runClient(clientCode);
    ctx.destroy();

    assert(log.includes('RESULT:200:'), 'expected a 200 response, got: ' + log);
    assert(log.includes('static file fixture content'), 'expected the fixture file contents, got: ' + log);
  },

  async 'Raw TCP echo server: a client subprocess round-trips raw bytes'() {
    const port = freePort();
    let serverSawIt;

    const ctx = createServer({
      port,
      options: LWS_SERVER_OPTION_ONLY_RAW | LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG,
      listenAcceptRole: 'raw-skt',
      listenAcceptProtocol: 'echo',
      protocols: [
        {
          name: 'echo',
          onRawRx(wsi, data) {
            serverSawIt = data;
            wsi.write(data);
          },
        },
      ],
    });

    const clientCode = `
      import { LWSContext, toArrayBuffer, toString } from 'lws';
      const ctx = new LWSContext({
        protocols: [{
          name: 'raw',
          onRawConnected(wsi) { wsi.write(toArrayBuffer('raw-hello')); },
          onRawRx(wsi, data) { console.log('RESULT:' + toString(data)); ctx.cancelService(); },
          onClientConnectionError(wsi, msg) { console.log('RESULT:ERROR:' + msg); ctx.cancelService(); },
        }],
      });
      ctx.clientConnect({ address: 'localhost', port: ${port}, method: 'RAW', protocol: 'raw' });
    `;

    const log = await runClient(clientCode);
    ctx.destroy();

    assert(log.includes('RESULT:raw-hello'), 'expected the echoed raw bytes back, got: ' + log);
  },

  'HTTPS server: constructs and binds an SSL vhost from the repo test cert'() {
    // A real client<->server TLS round-trip isn't covered here: a qjs-lws
    // *client* connecting to a local self-signed HTTPS server consistently
    // gets ECONNRESET ("read failed") right after sending its handshake
    // request - reproduced standalone with LCCSCF_USE_SSL|
    // LCCSCF_ALLOW_SELFSIGNED, both context-level SSL options set, and an
    // explicit alpn: 'http/1.1' - while `curl` completes the same handshake
    // fine over both HTTP/1.1 and HTTP/2. Root cause not isolated; flagged
    // as a follow-up. This test is therefore limited to confirming that
    // server-side SSL vhost construction (cert/key loading, SSL_CTX setup)
    // succeeds against the repo's real test certificate, without throwing.
    const port = freePort();

    const ctx = createServer({
      port,
      vhostName: 'localhost',
      options: LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT | LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX,
      serverSslCert: REPO_ROOT + '/localhost.crt',
      serverSslPrivateKey: REPO_ROOT + '/localhost.key',
      mounts: [{ mountpoint: '/', protocol: 'http', originProtocol: LWSMPRO_CALLBACK }],
      protocols: [
        {
          name: 'http',
          onHttp(wsi) {
            wsi.respond(200, { 'content-type': 'text/plain' });
            wsi.write('secure hello', LWS_WRITE_HTTP_FINAL);
          },
        },
      ],
    });

    const vh = ctx.getVhostByName('localhost');
    assert(vh !== undefined, 'expected the SSL-enabled vhost to exist');
    ctx.destroy();
  },
});
