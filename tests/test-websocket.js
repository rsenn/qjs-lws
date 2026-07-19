/**
 * Exercises lib/websocket.js (WebSocket, evented) and lib/websocketstream.js
 * (WebSocketStream, streams-based) - client and server for both - plus
 * cross-compatibility between the two (they speak the same WS wire
 * protocol, so a WebSocket client must round-trip with a
 * WebSocketStream.protocol() server and vice versa).
 *
 * Each same-class test is checked against a minimal counterpart that does
 * *not* itself use the class under test (a plain createServer() echo
 * protocol, or a plain LWSContext client) - so a failure points at one
 * specific side rather than either of two wrapped implementations talking
 * to each other, same structure as tests/unittests/test-websocket(stream).js.
 */
import { tests, eq, assert, assertStrictEquals, fail } from './unittests/tinytest.js';
import { freePort } from './unittests/subprocess-utils.js';
import { createServer, LWSContext, LWSMPRO_NO_MOUNT, LWS_WRITE_TEXT, LWS_WRITE_BINARY } from 'lws.so';
import { WebSocket, CONNECTING, OPEN, CLOSED } from '../lib/websocket.js';
import { WebSocketStream } from '../lib/websocketstream.js';
import { TextDecoder } from 'textcode';
import * as std from 'std';

const dec = new TextDecoder();
const asText = value => (typeof value === 'string' ? value : dec.decode(value));
const asBytes = value => (typeof value === 'string' ? new Uint8Array(0) : new Uint8Array(value.buffer ?? value));

function mockEchoServer(port) {
  return createServer({
    port,
    vhostName: 'localhost',
    mounts: [{ mountpoint: '/echo', protocol: 'echo', originProtocol: LWSMPRO_NO_MOUNT }],
    protocols: [
      {
        name: 'echo',
        onReceive(wsi, data) {
          // Echo back with the same frame type it arrived as - a text frame
          // decodes to a JS string, a binary frame to an ArrayBuffer/view.
          wsi.write(data, typeof data === 'string' ? LWS_WRITE_TEXT : LWS_WRITE_BINARY);
        },
      },
    ],
  });
}

await tests({
  /* ================================================================ *
   * lib/websocket.js - WebSocket (evented)
   * ================================================================ */

  async 'WebSocket (client): readyState starts CONNECTING, moves to OPEN on connect'() {
    const port = freePort();
    const server = mockEchoServer(port);

    const ws = new WebSocket(`ws://localhost:${port}/echo`, ['echo']);
    eq(CONNECTING, ws.readyState);

    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', e => reject(new Error(e.message)), { once: true });
    });

    eq(OPEN, ws.readyState);
    eq('echo', ws.protocol);

    ws.close();
    server.destroy();
  },

  async 'WebSocket (client): round-trips a text message'() {
    const port = freePort();
    const server = mockEchoServer(port);

    const ws = new WebSocket(`ws://localhost:${port}/echo`, ['echo']);
    await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));

    const received = new Promise(resolve => ws.addEventListener('message', e => resolve(asText(e.data)), { once: true }));
    ws.send('hello-client');

    eq('hello-client', await received);

    ws.close();
    server.destroy();
  },

  async 'WebSocket (client): round-trips binary data'() {
    const port = freePort();
    const server = mockEchoServer(port);

    const ws = new WebSocket(`ws://localhost:${port}/echo`, ['echo']);
    await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));

    const sent = new Uint8Array([1, 2, 3, 250, 255]);
    const received = new Promise(resolve => ws.addEventListener('message', e => resolve(asBytes(e.data)), { once: true }));
    ws.send(sent.buffer);

    const got = await received;
    eq(sent.length, got.length);
    for(let i = 0; i < sent.length; i++) eq(sent[i], got[i]);

    ws.close();
    server.destroy();
  },

  async 'WebSocket (client): multiple messages arrive in order'() {
    const port = freePort();
    const server = mockEchoServer(port);

    const ws = new WebSocket(`ws://localhost:${port}/echo`, ['echo']);
    await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));

    const got = [];
    const all = new Promise(resolve => {
      ws.addEventListener('message', e => {
        got.push(asText(e.data));
        if(got.length === 3) resolve();
      });
    });

    ws.send('one');
    ws.send('two');
    ws.send('three');

    await all;
    eq('one,two,three', got.join(','));

    ws.close();
    server.destroy();
  },

  async 'WebSocket (client): the close event carries the code the peer sent, readyState becomes CLOSED'() {
    const port = freePort();

    const server = createServer({
      port,
      vhostName: 'localhost',
      mounts: [{ mountpoint: '/echo', protocol: 'echo', originProtocol: LWSMPRO_NO_MOUNT }],
      protocols: [
        {
          name: 'echo',
          onEstablished(wsi) {
            wsi.close(4001, 'server-initiated');
          },
        },
      ],
    });

    const ws = new WebSocket(`ws://localhost:${port}/echo`, ['echo']);
    const { code } = await new Promise(resolve => ws.addEventListener('close', resolve, { once: true }));

    eq(4001, code);
    eq(CLOSED, ws.readyState);

    server.destroy();
  },

  async 'WebSocket.protocol() (server): round-trips through an echoing client'() {
    const port = freePort();

    let resolveReceived;
    const received = new Promise(resolve => (resolveReceived = resolve));

    const server = createServer({
      port,
      vhostName: 'localhost',
      mounts: [{ mountpoint: '/echo', protocol: 'echo', originProtocol: LWSMPRO_NO_MOUNT }],
      protocols: [
        WebSocket.protocol('echo', ws => {
          assert(ws instanceof WebSocket, 'expected a WebSocket from .protocol()');
          ws.addEventListener('message', e => resolveReceived(asText(e.data)));
          ws.send('hello-from-server');
        }),
      ],
    });

    const client = new LWSContext({
      protocols: [
        {
          name: 'ws',
          onClientReceive(wsi, data) {
            wsi.write(data, LWS_WRITE_TEXT);
          },
          onClientConnectionError(wsi, msg) {
            resolveReceived(Promise.reject(new Error(msg)));
          },
        },
      ],
    });
    client.clientConnect(`ws://localhost:${port}/echo`, { protocol: 'echo', localProtocolName: 'ws' });

    eq('hello-from-server', await received);

    client.destroy();
    server.destroy();
  },

  async 'WebSocket.protocol() (server): the close event fires when the peer closes'() {
    const port = freePort();

    let resolveClosed;
    const closed = new Promise(resolve => (resolveClosed = resolve));

    const server = createServer({
      port,
      vhostName: 'localhost',
      mounts: [{ mountpoint: '/echo', protocol: 'echo', originProtocol: LWSMPRO_NO_MOUNT }],
      protocols: [
        WebSocket.protocol('echo', ws => {
          ws.addEventListener('close', e => resolveClosed(e));
        }),
      ],
    });

    const client = new LWSContext({
      protocols: [
        {
          name: 'ws',
          onClientEstablished(wsi) {
            wsi.close(1000, 'done');
          },
          onClientConnectionError(wsi, msg) {
            resolveClosed(Promise.reject(new Error(msg)));
          },
        },
      ],
    });
    client.clientConnect(`ws://localhost:${port}/echo`, { protocol: 'echo', localProtocolName: 'ws' });

    const { code } = await closed;
    eq(1000, code);

    client.destroy();
    server.destroy();
  },

  async 'WebSocket.protocol() (server): two concurrent connections stay independent'() {
    const port = freePort();
    const results = {};
    let doneCount = 0;
    let resolveAll;
    const all = new Promise(resolve => (resolveAll = resolve));

    const server = createServer({
      port,
      vhostName: 'localhost',
      mounts: [{ mountpoint: '/echo', protocol: 'echo', originProtocol: LWSMPRO_NO_MOUNT }],
      protocols: [
        WebSocket.protocol('echo', ws => {
          ws.addEventListener('message', e => {
            const t = asText(e.data);
            results[t] = true;
            if(++doneCount === 2) resolveAll();
          });
        }),
      ],
    });

    function echoingClient(msg) {
      const ctx = new LWSContext({
        protocols: [
          {
            name: 'ws',
            onClientEstablished(wsi) {
              wsi.write(msg, LWS_WRITE_TEXT);
            },
            onClientConnectionError(wsi, m) {
              fail('client connection error: ' + m);
            },
          },
        ],
      });
      ctx.clientConnect(`ws://localhost:${port}/echo`, { protocol: 'echo', localProtocolName: 'ws' });
      return ctx;
    }

    const c1 = echoingClient('client-a');
    const c2 = echoingClient('client-b');

    await all;

    assertStrictEquals(true, results['client-a']);
    assertStrictEquals(true, results['client-b']);

    c1.destroy();
    c2.destroy();
    server.destroy();
  },

  /* ================================================================ *
   * lib/websocketstream.js - WebSocketStream (streams-based)
   * ================================================================ */

  async 'WebSocketStream (client): opened resolves with readable/writable, round-trips a message'() {
    const port = freePort();
    const server = mockEchoServer(port);

    const wss = new WebSocketStream(`ws://localhost:${port}/echo`, { protocols: ['echo'] });
    const { readable, writable, protocol } = await wss.opened;

    assert(readable, 'expected a readable stream');
    assert(writable, 'expected a writable stream');
    eq('echo', protocol);

    const writer = writable.getWriter();
    const reader = readable.getReader();

    await writer.write('hello-client');
    const { value, done } = await reader.read();

    assertStrictEquals(false, done);
    eq('hello-client', asText(value));

    reader.releaseLock();
    wss.close();
    await wss.closed;

    server.destroy();
  },

  async 'WebSocketStream (client): round-trips binary data'() {
    const port = freePort();
    const server = mockEchoServer(port);

    const wss = new WebSocketStream(`ws://localhost:${port}/echo`, { protocols: ['echo'] });
    const { readable, writable } = await wss.opened;
    const writer = writable.getWriter();
    const reader = readable.getReader();

    const sent = new Uint8Array([9, 8, 7, 0, 255]);
    await writer.write(sent.buffer);
    const { value } = await reader.read();

    const got = asBytes(value);
    eq(sent.length, got.length);
    for(let i = 0; i < sent.length; i++) eq(sent[i], got[i]);

    reader.releaseLock();
    wss.close();
    await wss.closed;

    server.destroy();
  },

  async 'WebSocketStream (client): multiple messages arrive in order'() {
    const port = freePort();
    const server = mockEchoServer(port);

    const wss = new WebSocketStream(`ws://localhost:${port}/echo`, { protocols: ['echo'] });
    const { readable, writable } = await wss.opened;
    const writer = writable.getWriter();
    const reader = readable.getReader();

    await writer.write('one');
    await writer.write('two');
    await writer.write('three');

    const got = [];
    for(let i = 0; i < 3; i++) got.push(asText((await reader.read()).value));

    eq('one,two,three', got.join(','));

    reader.releaseLock();
    wss.close();
    await wss.closed;

    server.destroy();
  },

  async 'WebSocketStream (client): closed resolves with the close code the peer sent'() {
    const port = freePort();

    const server = createServer({
      port,
      vhostName: 'localhost',
      mounts: [{ mountpoint: '/echo', protocol: 'echo', originProtocol: LWSMPRO_NO_MOUNT }],
      protocols: [
        {
          name: 'echo',
          onEstablished(wsi) {
            wsi.close(4001, 'server-initiated');
          },
        },
      ],
    });

    const wss = new WebSocketStream(`ws://localhost:${port}/echo`, { protocols: ['echo'] });
    await wss.opened;

    const { closeCode } = await wss.closed;
    eq(4001, closeCode);

    server.destroy();
  },

  async 'WebSocketStream.protocol() (server): opened resolves, round-trips through an echoing client'() {
    const port = freePort();

    let resolveReceived;
    const received = new Promise(resolve => (resolveReceived = resolve));

    const server = createServer({
      port,
      vhostName: 'localhost',
      mounts: [{ mountpoint: '/echo', protocol: 'echo', originProtocol: LWSMPRO_NO_MOUNT }],
      protocols: [
        WebSocketStream.protocol('echo', async wss => {
          const { readable, writable, protocol } = await wss.opened;

          assert(readable, 'expected a readable stream');
          assert(writable, 'expected a writable stream');

          const writer = writable.getWriter();
          await writer.write('hello-from-server');

          const { value } = await readable.getReader().read();
          resolveReceived({ text: asText(value), protocol });
        }),
      ],
    });

    const client = new LWSContext({
      protocols: [
        {
          name: 'ws',
          onClientReceive(wsi, data) {
            wsi.write(data, LWS_WRITE_TEXT);
          },
          onClientConnectionError(wsi, msg) {
            resolveReceived(Promise.reject(new Error(msg)));
          },
        },
      ],
    });
    client.clientConnect(`ws://localhost:${port}/echo`, { protocol: 'echo', localProtocolName: 'ws' });

    const { text } = await received;
    eq('hello-from-server', text);

    client.destroy();
    server.destroy();
  },

  async 'WebSocketStream.protocol() (server): onClosed resolves the closed promise'() {
    const port = freePort();

    let resolveClosed;
    const closed = new Promise(resolve => (resolveClosed = resolve));

    const server = createServer({
      port,
      vhostName: 'localhost',
      mounts: [{ mountpoint: '/echo', protocol: 'echo', originProtocol: LWSMPRO_NO_MOUNT }],
      protocols: [
        WebSocketStream.protocol('echo', async wss => {
          await wss.opened;
          resolveClosed(wss.closed);
        }),
      ],
    });

    const client = new LWSContext({
      protocols: [
        {
          name: 'ws',
          onClientEstablished(wsi) {
            wsi.close(1000, 'done');
          },
          onClientConnectionError(wsi, msg) {
            resolveClosed(Promise.reject(new Error(msg)));
          },
        },
      ],
    });
    client.clientConnect(`ws://localhost:${port}/echo`, { protocol: 'echo', localProtocolName: 'ws' });

    const { closeCode } = await closed;
    eq(1000, closeCode);

    client.destroy();
    server.destroy();
  },

  async 'WebSocketStream.protocol() (server): two concurrent connections stay independent'() {
    const port = freePort();
    const results = {};
    let doneCount = 0;
    let resolveAll;
    const all = new Promise(resolve => (resolveAll = resolve));

    const server = createServer({
      port,
      vhostName: 'localhost',
      mounts: [{ mountpoint: '/echo', protocol: 'echo', originProtocol: LWSMPRO_NO_MOUNT }],
      protocols: [
        WebSocketStream.protocol('echo', async wss => {
          const { readable, writable } = await wss.opened;
          const { value } = await readable.getReader().read();
          const text = asText(value);

          await writable.getWriter().write('ack:' + text);

          results[text] = true;
          if(++doneCount === 2) resolveAll();
        }),
      ],
    });

    function echoingClient(msg) {
      const ctx = new LWSContext({
        protocols: [
          {
            name: 'ws',
            onClientEstablished(wsi) {
              wsi.write(msg, LWS_WRITE_TEXT);
            },
            onClientConnectionError(wsi, m) {
              fail('client connection error: ' + m);
            },
          },
        ],
      });
      ctx.clientConnect(`ws://localhost:${port}/echo`, { protocol: 'echo', localProtocolName: 'ws' });
      return ctx;
    }

    const c1 = echoingClient('client-a');
    const c2 = echoingClient('client-b');

    await all;

    assertStrictEquals(true, results['client-a']);
    assertStrictEquals(true, results['client-b']);

    c1.destroy();
    c2.destroy();
    server.destroy();
  },

  /* ================================================================ *
   * cross-compatibility - WebSocket <-> WebSocketStream speak the same
   * wire protocol, so either can be the client against the other's server
   * ================================================================ */

  async 'cross-compat: a WebSocket client round-trips against a WebSocketStream.protocol() server'() {
    const port = freePort();

    const server = createServer({
      port,
      vhostName: 'localhost',
      mounts: [{ mountpoint: '/echo', protocol: 'echo', originProtocol: LWSMPRO_NO_MOUNT }],
      protocols: [
        WebSocketStream.protocol('echo', async wss => {
          const { readable, writable } = await wss.opened;
          const { value } = await readable.getReader().read();
          await writable.getWriter().write('server-stream-says:' + asText(value));
        }),
      ],
    });

    const ws = new WebSocket(`ws://localhost:${port}/echo`, ['echo']);
    await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));

    const received = new Promise(resolve => ws.addEventListener('message', e => resolve(asText(e.data)), { once: true }));
    ws.send('client-event-says-hi');

    eq('server-stream-says:client-event-says-hi', await received);

    ws.close();
    server.destroy();
  },

  async 'cross-compat: a WebSocketStream client round-trips against a WebSocket.protocol() server'() {
    const port = freePort();

    const server = createServer({
      port,
      vhostName: 'localhost',
      mounts: [{ mountpoint: '/echo', protocol: 'echo', originProtocol: LWSMPRO_NO_MOUNT }],
      protocols: [
        WebSocket.protocol('echo', ws => {
          ws.addEventListener('message', e => ws.send('server-event-says:' + asText(e.data)));
        }),
      ],
    });

    const wss = new WebSocketStream(`ws://localhost:${port}/echo`, { protocols: ['echo'] });
    const { readable, writable } = await wss.opened;
    const writer = writable.getWriter();
    const reader = readable.getReader();

    await writer.write('client-stream-says-hi');
    const { value } = await reader.read();

    eq('server-event-says:client-stream-says-hi', asText(value));

    reader.releaseLock();
    wss.close();
    server.destroy();
  },
});

/* WebSocket (lib/websocket.js) keeps a lazily-created LWSContext singleton
   alive for the life of the process by design (shared across every
   instance, client or accepted-server-side) - and WebSocketStream's client
   side is built on that same WebSocket internally as its default `ctor` -
   so, unlike test-app.js/test-middleware.js's per-call leaked contexts,
   nothing in this file ever destroys it and the event loop would otherwise
   never drain on its own. Same std.exit(0) used by
   tests/unittests/test-websocket(stream).js for the identical reason. */
std.exit(0);
