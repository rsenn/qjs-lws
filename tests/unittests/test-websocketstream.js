/**
 * Tests both halves of lib/websocketstream.js independently, each against a
 * minimal counterpart that does *not* itself use WebSocketStream - so a
 * failure points at one specific side rather than either of two wrapped
 * implementations talking to each other.
 *
 *  - Client (`new WebSocketStream(url)`) is tested against a plain
 *    createServer() echo protocol.
 *  - Server (`WebSocketStream.protocol()`) is tested against a plain
 *    LWSContext client that echoes back whatever it receives.
 */
import { tests, eq, assert, assertStrictEquals, fail } from './tinytest.js';
import { createServer, LWSContext, LWSMPRO_NO_MOUNT, LWS_WRITE_TEXT } from 'lws.so';
import { WebSocketStream } from '../../lib/websocketstream.js';
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

  async 'WebSocketStream (client): closed resolves with the close code the peer sent'() {
    // Closing from the client's own side doesn't reliably report a code/
    // reason back through `closed` - a pre-existing limitation of
    // lib/websocket.js's onClientClosed, which only fills those in from
    // onWsPeerInitiatedClose (i.e. when the *server* closes on us). Exercise
    // that path instead, which does work.
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
    for(let i = 0; i < 3; i++) {
      const { value } = await reader.read();
      got.push(asText(value));
    }

    eq('one,two,three', got.join(','));

    reader.releaseLock();
    wss.close();
    await wss.closed;

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

          const reader = readable.getReader();
          const { value } = await reader.read();

          resolveReceived({ text: asText(value), protocol });
        }),
      ],
    });

    // Mocked echoing client - plain LWSContext, not client-side WebSocketStream.
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
          const writer = writable.getWriter();
          const reader = readable.getReader();

          const { value } = await reader.read();
          const text = asText(value);

          await writer.write('ack:' + text);

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
});

// WebSocket (lib/websocket.js), used internally as WebSocketStream's default
// client `ctor`, keeps a lazily-created LWSContext singleton alive for the
// life of the process (by design, to share it across instances) - unlike
// every other suite here, nothing in this file ever destroys it, so the
// event loop would otherwise never drain on its own.
std.exit(0);
