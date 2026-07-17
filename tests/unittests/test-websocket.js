/**
 * Tests both halves of lib/websocket.js independently, each against a
 * minimal counterpart that does *not* itself use WebSocket - so a failure
 * points at one specific side rather than either of two wrapped
 * implementations talking to each other. Mirrors test-websocketstream.js's
 * structure (lib/websocketstream.js's independent, streams-based sibling).
 *
 *  - Client (`new WebSocket(url)`) is tested against a plain
 *    createServer() echo protocol.
 *  - Server (`WebSocket.protocol()`) is tested against a plain
 *    LWSContext client that echoes back whatever it receives.
 */
import { tests, eq, assert, assertStrictEquals, fail } from './tinytest.js';
import { createServer, LWSContext, LWSMPRO_NO_MOUNT, LWS_WRITE_TEXT } from 'lws.so';
import { WebSocket } from '../../lib/websocket.js';
import { TextDecoder } from 'textcode';
import { freePort } from './subprocess-utils.js';
import * as std from 'std';

const dec = new TextDecoder();
const asText = value => (typeof value === 'string' ? value : dec.decode(value));

function mockEchoServer(port) {
  return createServer({
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
}

await tests({
  async 'WebSocket (client): connects and round-trips a message'() {
    const port = freePort();
    const server = mockEchoServer(port);

    const ws = new WebSocket(`ws://localhost:${port}/echo`, ['echo']);

    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', e => reject(new Error(e.message)), { once: true });
    });

    eq('echo', ws.protocol);

    const received = new Promise(resolve => ws.addEventListener('message', e => resolve(asText(e.data)), { once: true }));
    ws.send('hello-client');

    eq('hello-client', await received);

    ws.close();
    server.destroy();
  },

  async 'WebSocket (client): the close event carries the code the peer sent'() {
    // Mirrors test-websocketstream.js's equivalent test: closing from the
    // client's own side doesn't reliably report a code back, so this
    // exercises the server-initiated-close path instead.
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

    // Mocked echoing client - plain LWSContext, not client-side WebSocket.
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

    const text = await received;
    eq('hello-from-server', text);

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
            const text = asText(e.data);

            ws.send('ack:' + text);
            results[text] = true;
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
});

// WebSocket keeps a lazily-created LWSContext singleton alive for the life
// of the process (by design, to share it across instances) - unlike every
// other suite here, nothing in this file ever destroys it, so the event
// loop would otherwise never drain on its own.
std.exit(0);
