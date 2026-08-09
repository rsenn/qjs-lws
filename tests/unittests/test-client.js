/**
 * Exercises different client setups (WebSocket, HTTP GET, HTTP POST, raw
 * TCP) against an in-process fixture server for each - createServer() on
 * its own LWSContext, driven by the same event loop as the client under
 * test, torn down with server.destroy() once the exchange completes.
 */
import { tests, eq, assert, assertStrictEquals, fail } from './tinytest.js';
import { logLevel, LWSContext, createServer, LWS_WRITE_TEXT, LWS_WRITE_HTTP_FINAL, LWSMPRO_NO_MOUNT, LWSMPRO_CALLBACK, LWS_SERVER_OPTION_ONLY_RAW, LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG, toString, toArrayBuffer, } from 'lws.so';
import { freePort } from './subprocess-utils.js';

logLevel(0, () => {});

await tests({
  async 'WebSocket client: connects to an in-process WS echo server and round-trips a message'() {
    const port = freePort();

    const server = createServer({
      port,
      vhostName: 'localhost',
      mounts: [{ mountpoint: '/echo', protocol: 'echo', originProtocol: LWSMPRO_NO_MOUNT }],
      protocols: [
        {
          name: 'echo',
          onReceive(wsi, data) {
            wsi.write(data, LWS_WRITE_TEXT);
          },
        },
      ],
    });

    let ctx;
    const result = await new Promise((resolve, reject) => {
      ctx = new LWSContext({
        protocols: [
          {
            name: 'ws',
            onClientEstablished(wsi) {
              wsi.write('ping-from-parent', LWS_WRITE_TEXT);
            },
            onClientReceive(wsi, data) {
              ctx.cancelService();
              resolve(data);
            },
            onClientConnectionError(wsi, msg) {
              ctx.cancelService();
              reject(new Error(msg));
            },
          },
        ],
      });
      ctx.clientConnect(`ws://localhost:${port}/echo`, { protocol: 'echo', localProtocolName: 'ws' });
    });

    ctx.destroy();
    server.destroy();

    eq('ping-from-parent', result);
  },

  async 'HTTP client (GET): connects to an in-process HTTP server and reads the response'() {
    const port = freePort();

    const server = createServer({
      port,
      vhostName: 'localhost',
      mounts: [{ mountpoint: '/', protocol: 'http', originProtocol: LWSMPRO_CALLBACK }],
      protocols: [
        {
          name: 'http',
          onHttp(wsi) {
            wsi.respond(200, { 'content-type': 'text/plain' });
            wsi.write('hello ' + wsi.uri, LWS_WRITE_HTTP_FINAL);
          },
        },
      ],
    });

    let ctx;
    const result = await new Promise((resolve, reject) => {
      ctx = new LWSContext({
        protocols: [
          {
            name: 'http',
            onEstablishedClientHttp(wsi, status) {
              this.status = status;
            },
            onReceiveClientHttp(wsi) {
              const buf = new ArrayBuffer(4096);
              if(wsi.httpClientRead(buf)) this.onReceiveClientHttpRead(wsi, buf);
            },
            onReceiveClientHttpRead(wsi, buf, len) {
              ctx.cancelService();
              resolve({ status: this.status, body: toString(buf, 0, len) });
            },
            onClientConnectionError(wsi, msg) {
              ctx.cancelService();
              reject(new Error(msg));
            },
          },
        ],
      });
      // The string-URL form of clientConnect() for an http:// scheme never
      // actually starts the connection (see the final summary) - the
      // object form works correctly.
      ctx.clientConnect({ address: 'localhost', port, path: '/world', host: 'localhost', method: 'GET', protocol: 'http' });
    });

    ctx.destroy();
    server.destroy();

    eq(200, result.status);
    eq('hello /world', result.body);
  },

  async 'HTTP client (POST with body): an in-process server echoes the request body back'() {
    const port = freePort();
    const payload = 'the request body, round-tripped';

    const server = createServer({
      port,
      vhostName: 'localhost',
      mounts: [{ mountpoint: '/', protocol: 'http', originProtocol: LWSMPRO_CALLBACK }],
      protocols: [
        {
          name: 'http',
          onHttp(wsi) {
            this.chunks = [];
          },
          onHttpBody(wsi, buf) {
            this.chunks.push(new Uint8Array(buf).slice());
          },
          onHttpBodyCompletion(wsi) {
            const total = this.chunks.reduce((n, c) => n + c.byteLength, 0);
            const all = new Uint8Array(total);
            let off = 0;
            for(const c of this.chunks) {
              all.set(c, off);
              off += c.byteLength;
            }
            wsi.wantWrite(() => {
              wsi.respond(200, { 'content-type': 'text/plain' });
              wsi.write(all.buffer, LWS_WRITE_HTTP_FINAL);
              return -1;
            });
          },
        },
      ],
    });

    let ctx;
    const result = await new Promise((resolve, reject) => {
      ctx = new LWSContext({
        protocols: [
          {
            name: 'http',
            onClientAppendHandshakeHeader(wsi, buf, len) {
              wsi.addHeader('content-type', 'text/plain', buf, len);
              wsi.addHeader('content-length', String(toArrayBuffer(payload).byteLength), buf, len);
              if(!wsi.redirectedToGet && wsi.method === 'POST') wsi.bodyPending = 1;
            },
            onClientHttpWriteable(wsi) {
              wsi.write(payload, LWS_WRITE_HTTP_FINAL);
              wsi.bodyPending = 0;
            },
            onEstablishedClientHttp(wsi, status) {
              this.status = status;
            },
            onReceiveClientHttp(wsi) {
              const buf = new ArrayBuffer(4096);
              if(wsi.httpClientRead(buf)) this.onReceiveClientHttpRead(wsi, buf);
            },
            onReceiveClientHttpRead(wsi, buf, len) {
              ctx.cancelService();
              resolve({ status: this.status, body: toString(buf, 0, len) });
            },
            onClientConnectionError(wsi, msg) {
              ctx.cancelService();
              reject(new Error(msg));
            },
          },
        ],
      });
      ctx.clientConnect({ address: 'localhost', port, path: '/', host: 'localhost', method: 'POST', protocol: 'http' });
    });

    ctx.destroy();
    server.destroy();

    eq(200, result.status);
    eq(payload, result.body);
  },

  async 'Raw TCP client: connects to an in-process raw echo server and round-trips bytes'() {
    const port = freePort();

    const server = createServer({
      port,
      options: LWS_SERVER_OPTION_ONLY_RAW | LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG,
      listenAcceptRole: 'raw-skt',
      listenAcceptProtocol: 'echo',
      protocols: [
        {
          name: 'echo',
          onRawRx(wsi, data) {
            wsi.write(data);
          },
        },
      ],
    });

    let ctx;
    const result = await new Promise((resolve, reject) => {
      ctx = new LWSContext({
        protocols: [
          {
            name: 'raw',
            onRawConnected(wsi) {
              wsi.write(toArrayBuffer('raw-from-parent'));
            },
            onRawRx(wsi, data) {
              ctx.cancelService();
              resolve(toString(data));
            },
            onClientConnectionError(wsi, msg) {
              ctx.cancelService();
              reject(new Error(msg));
            },
          },
        ],
      });
      ctx.clientConnect({ address: 'localhost', port, method: 'RAW', protocol: 'raw' });
    });

    ctx.destroy();
    server.destroy();

    eq('raw-from-parent', result);
  },
});
