/**
 * Tests lib/tcpsocket.js (`TCPSocket`, evented) and lib/tcpsocketstream.js
 * (`TCPSocketStream`, streams-based) independently, each against a minimal
 * counterpart that does *not* itself use either wrapper - so a failure
 * points at one specific side rather than either of two wrapped
 * implementations talking to each other. Mirrors test-websocketstream.js's
 * structure, adapted for the raw-TCP role (see that file for the WS/WSS
 * pair's own coverage).
 *
 *  - Client (`new TCPSocket(...)` / `new TCPSocketStream(...)` /
 *    `TCPSocket.connect()`) is tested against a plain createServer() raw
 *    echo protocol.
 *  - Server (`TCPSocket.protocol()` / `TCPSocketStream.protocol()` /
 *    `TCPSocket.listen()`) is tested against a plain LWSContext raw
 *    client.
 *
 * Every mock counterpart here is built directly on the native `lws.so` C
 * API (`createServer()`/`LWSContext#clientConnect()`) - none of them go
 * through any of `lib/tcpsocket.js`'s own wrapper surface, static or
 * instance - so a failure in a wrapper-side test always points at the
 * wrapper, never at another piece of the wrapper standing in as its own
 * counterpart.
 */
import { tests, eq, assert, assertStrictEquals, fail } from './tinytest.js';
import { createServer, LWSContext, toArrayBuffer, toString, LWS_SERVER_OPTION_ONLY_RAW, LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG } from 'lws.so';
import { TCPSocket, CLOSED } from '../../lib/tcpsocket.js';
import { TCPSocketStream } from '../../lib/tcpsocketstream.js';
import { freePort } from './subprocess-utils.js';
import { setTimeout } from 'os';
import * as std from 'std';

/* Every raw listener here needs the same low-level wiring: no HTTP mount
   exists to match against, so the vhost has to unconditionally bind new
   connections to the named raw protocol via listenAcceptRole/Protocol -
   ONLY_RAW skips the "does this look like HTTP first" check entirely
   (there's nothing else registered for it to fall back from). */
function mockRawEchoServer(port, protocol = 'echo') {
  return createServer({
    port,
    options: LWS_SERVER_OPTION_ONLY_RAW | LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG,
    listenAcceptRole: 'raw-skt',
    listenAcceptProtocol: protocol,
    protocols: [
      {
        name: protocol,
        onRawRx(wsi, data) {
          wsi.write(data);
        },
      },
    ],
  });
}

function rawProtocolServer(port, protocol, entry) {
  return createServer({
    port,
    options: LWS_SERVER_OPTION_ONLY_RAW | LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG,
    listenAcceptRole: 'raw-skt',
    listenAcceptProtocol: protocol,
    protocols: [entry],
  });
}

/* Plain raw client, built directly on LWSContext - the mock counterpart for
   every `TCPSocket.listen()` (Bun API, server) test below, same role
   `rawClient()`-style helpers play in the `TCPSocket.protocol()` group
   above. `onReceive`/`onError` are optional; `onConnected` always runs. */
function rawClient(port, { onConnected, onReceive, onError } = {}) {
  const ctx = new LWSContext({
    protocols: [
      {
        name: 'raw',
        onRawConnected(wsi) {
          onConnected?.(wsi);
        },
        onRawRx(wsi, data) {
          onReceive?.(wsi, data);
        },
        onClientConnectionError(wsi, msg) {
          if(onError) onError(msg);
          else fail('raw client connection error: ' + msg);
        },
      },
    ],
  });
  ctx.clientConnect({ address: 'localhost', port, method: 'RAW', protocol: 'raw' });
  return ctx;
}

await tests({
  async 'TCPSocket (client): connects and round-trips raw bytes'() {
    const port = freePort();
    const server = mockRawEchoServer(port);

    const socket = new TCPSocket('localhost', port);
    const received = new Promise((resolve, reject) => {
      socket.addEventListener('open', () => socket.send('hello-raw'));
      socket.addEventListener('message', e => resolve(toString(e.data)));
      socket.addEventListener('error', e => reject(new Error(e.message)));
    });

    eq('hello-raw', await received);

    socket.close();
    server.destroy();
  },

  async 'TCPSocket (client): the close event fires when the peer closes'() {
    // Closes from onRawRx (after data has actually arrived), not
    // onRawAdopt: wsi.close() called synchronously within onRawAdopt
    // itself segfaults natively (confirmed directly, reproducible in
    // isolation) - a real, separately-worth-tracking bug, sidestepped here
    // rather than chased down at the C level.
    const port = freePort();
    const server = rawProtocolServer(port, 'echo', {
      name: 'echo',
      onRawRx(wsi) {
        wsi.close();
      },
    });

    const socket = new TCPSocket('localhost', port);
    socket.addEventListener('open', () => socket.send('trigger'));
    await new Promise(resolve => socket.addEventListener('close', resolve, { once: true }));

    eq(CLOSED, socket.readyState);
    server.destroy();
  },

  async 'TCPSocket (client): consecutive writes arrive in order (raw TCP is an unframed byte stream)'() {
    // Unlike WS, raw has no message framing - three separate send() calls
    // can legitimately coalesce into a single 'message' event (confirmed:
    // they do, over loopback). So this accumulates bytes until the full
    // expected length arrives rather than asserting a fixed event count,
    // and checks the concatenation to confirm order/content survived.
    const port = freePort();
    const server = mockRawEchoServer(port);

    const socket = new TCPSocket('localhost', port);
    await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));

    const expected = 'onetwothree';
    let got = '';
    const all = new Promise(resolve => {
      socket.addEventListener('message', e => {
        got += toString(e.data);
        if(got.length >= expected.length) resolve();
      });
    });

    socket.send('one');
    socket.send('two');
    socket.send('three');

    await all;
    eq(expected, got);

    socket.close();
    server.destroy();
  },

  async 'TCPSocket.protocol() (server): round-trips raw bytes through a plain raw client'() {
    const port = freePort();

    let resolveReceived;
    const received = new Promise(resolve => (resolveReceived = resolve));

    const server = rawProtocolServer(
      port,
      'echo',
      TCPSocket.protocol('echo', socket => {
        assert(socket instanceof TCPSocket, 'expected a TCPSocket from .protocol()');
        socket.addEventListener('message', e => {
          resolveReceived(toString(e.data));
          socket.send('hello-from-server');
        });
      }),
    );

    const client = new LWSContext({
      protocols: [
        {
          name: 'raw',
          onRawConnected(wsi) {
            wsi.write(toArrayBuffer('hello-client-side'));
          },
          onClientConnectionError(wsi, msg) {
            resolveReceived(Promise.reject(new Error(msg)));
          },
        },
      ],
    });
    client.clientConnect({ address: 'localhost', port, method: 'RAW', protocol: 'raw' });

    eq('hello-client-side', await received);

    client.destroy();
    server.destroy();
  },

  async 'TCPSocket.protocol() (server): fires close when the client disconnects'() {
    // wsi.close() called synchronously within onRawConnected itself
    // segfaults natively (confirmed directly, reproducible in isolation,
    // same underlying issue as the onRawAdopt case noted above) - deferred
    // via setTimeout so it runs as its own, later native callback instead.
    const port = freePort();

    let resolveClosed;
    const closed = new Promise(resolve => (resolveClosed = resolve));

    const server = rawProtocolServer(
      port,
      'echo',
      TCPSocket.protocol('echo', socket => {
        socket.addEventListener('close', () => resolveClosed(true));
      }),
    );

    const client = new LWSContext({
      protocols: [
        {
          name: 'raw',
          onRawConnected(wsi) {
            setTimeout(() => wsi.close(), 0);
          },
          onClientConnectionError(wsi, msg) {
            resolveClosed(Promise.reject(new Error(msg)));
          },
        },
      ],
    });
    client.clientConnect({ address: 'localhost', port, method: 'RAW', protocol: 'raw' });

    assertStrictEquals(true, await closed);

    client.destroy();
    server.destroy();
  },

  async 'TCPSocket.protocol() (server): two concurrent connections stay independent'() {
    const port = freePort();
    const results = {};
    let doneCount = 0;
    let resolveAll;
    const all = new Promise(resolve => (resolveAll = resolve));

    const server = rawProtocolServer(
      port,
      'echo',
      TCPSocket.protocol('echo', socket => {
        socket.addEventListener('message', e => {
          const text = toString(e.data);

          socket.send('ack:' + text);
          results[text] = true;
          if(++doneCount === 2) resolveAll();
        });
      }),
    );

    function rawClient(msg) {
      const ctx = new LWSContext({
        protocols: [
          {
            name: 'raw',
            onRawConnected(wsi) {
              wsi.write(toArrayBuffer(msg));
            },
            onClientConnectionError(wsi, m) {
              fail('raw client connection error: ' + m);
            },
          },
        ],
      });
      ctx.clientConnect({ address: 'localhost', port, method: 'RAW', protocol: 'raw' });
      return ctx;
    }

    const c1 = rawClient('client-a');
    const c2 = rawClient('client-b');

    await all;

    assertStrictEquals(true, results['client-a']);
    assertStrictEquals(true, results['client-b']);

    c1.destroy();
    c2.destroy();
    server.destroy();
  },

  async 'TCPSocket.connect() (Bun API, client): connects and round-trips raw bytes'() {
    const port = freePort();
    const server = mockRawEchoServer(port);

    let resolveReceived;
    const received = new Promise(resolve => (resolveReceived = resolve));

    const client = await TCPSocket.connect({
      hostname: 'localhost',
      port,
      socket: {
        data(socket, data) {
          resolveReceived(toString(data));
        },
      },
    });

    client.write('hello-connect');

    eq('hello-connect', await received);

    client.end();
    server.destroy();
  },

  async 'TCPSocket.connect() (Bun API, client): open handler fires with the resolved socket'() {
    const port = freePort();
    const server = rawProtocolServer(port, 'echo', { name: 'echo' });

    let resolveOpened;
    const opened = new Promise(resolve => (resolveOpened = resolve));

    const client = await TCPSocket.connect({
      hostname: 'localhost',
      port,
      socket: { open: resolveOpened },
    });

    assertStrictEquals(client, await opened);

    client.close();
    server.destroy();
  },

  async 'TCPSocket.connect() (Bun API, client): close handler fires when the peer closes'() {
    const port = freePort();
    const server = rawProtocolServer(port, 'echo', {
      name: 'echo',
      onRawRx(wsi) {
        wsi.close();
      },
    });

    let resolveClosed;
    const closed = new Promise(resolve => (resolveClosed = resolve));

    const client = await TCPSocket.connect({
      hostname: 'localhost',
      port,
      socket: {
        close(socket) {
          resolveClosed(true);
        },
      },
    });

    client.write('trigger');

    assertStrictEquals(true, await closed);
    server.destroy();
  },

  async 'TCPSocket.connect() (Bun API, client): connectError fires (in addition to error) on a failed connect'() {
    const port = freePort(); // nothing listens on it

    let resolveConnectError;
    const connectError = new Promise(resolve => (resolveConnectError = resolve));

    let rejected;

    try {
      await TCPSocket.connect({
        hostname: 'localhost',
        port,
        socket: {
          connectError(socket, err) {
            resolveConnectError(err);
          },
        },
      });
    } catch(e) {
      rejected = e;
    }

    assert(rejected instanceof Error, 'expected TCPSocket.connect() to reject');
    assert((await connectError) instanceof Error, 'expected connectError to receive an Error');
  },

  async 'TCPSocket.listen() (Bun API, server): round-trips raw bytes through a plain raw client'() {
    const port = freePort();

    const server = TCPSocket.listen({
      hostname: '0.0.0.0',
      port,
      socket: {
        data(socket, data) {
          socket.write(data);
        },
      },
    });

    let resolveReceived;
    const received = new Promise(resolve => (resolveReceived = resolve));

    const client = rawClient(port, {
      onConnected: wsi => wsi.write(toArrayBuffer('hello-listen')),
      onReceive: (wsi, data) => resolveReceived(toString(data)),
      onError: msg => resolveReceived(Promise.reject(new Error(msg))),
    });

    eq('hello-listen', await received);

    client.destroy();
    server.stop();
  },

  async 'TCPSocket.listen() (Bun API, server): open handler can set .data, later handlers see it'() {
    const port = freePort();

    let resolveReceived;
    const received = new Promise(resolve => (resolveReceived = resolve));

    const server = TCPSocket.listen({
      hostname: '0.0.0.0',
      port,
      socket: {
        open(socket) {
          socket.data = { tag: 'server-side' };
        },
        data(socket) {
          resolveReceived(socket.data);
        },
      },
    });

    const client = rawClient(port, {
      onConnected: wsi => wsi.write(toArrayBuffer('ping')),
      onError: msg => resolveReceived(Promise.reject(new Error(msg))),
    });

    eq('server-side', (await received).tag);

    client.destroy();
    server.stop();
  },

  async 'TCPSocket.listen() (Bun API, server): close handler fires when the client disconnects'() {
    const port = freePort();

    let resolveClosed;
    const closed = new Promise(resolve => (resolveClosed = resolve));

    const server = TCPSocket.listen({
      hostname: '0.0.0.0',
      port,
      socket: {
        close(socket) {
          resolveClosed(true);
        },
      },
    });

    // Deferred via setTimeout, not called synchronously from onRawConnected -
    // see the note on the analogous TCPSocket.protocol() test above.
    const client = rawClient(port, {
      onConnected: wsi => setTimeout(() => wsi.close(), 0),
      onError: msg => resolveClosed(Promise.reject(new Error(msg))),
    });

    assertStrictEquals(true, await closed);

    client.destroy();
    server.stop();
  },

  async 'TCPSocket.listen() (Bun API, server): stop() tears down the listener'() {
    const port = freePort();

    const server = TCPSocket.listen({ hostname: '0.0.0.0', port, socket: {} });

    server.stop();

    let resolveFailed;
    const failed = new Promise(resolve => (resolveFailed = resolve));

    const client = rawClient(port, { onError: msg => resolveFailed(msg) });

    assert(typeof (await failed) === 'string', 'expected a connection error once the listener is stopped');

    client.destroy();
  },

  async 'TCPSocketStream (client): opened resolves with readable/writable, round-trips raw bytes'() {
    const port = freePort();
    const server = mockRawEchoServer(port);

    const ts = new TCPSocketStream({ host: 'localhost', port });
    const { readable, writable, remoteAddress } = await ts.opened;

    assert(readable, 'expected a readable stream');
    assert(writable, 'expected a writable stream');
    assert(typeof remoteAddress === 'string' && remoteAddress.length > 0, `expected a remoteAddress, got ${remoteAddress}`);

    const writer = writable.getWriter();
    const reader = readable.getReader();

    await writer.write('hello-stream');
    const { value, done } = await reader.read();

    assertStrictEquals(false, done);
    eq('hello-stream', toString(value.buffer ?? value));

    ts.close();
    server.destroy();
  },

  async 'TCPSocketStream (client): closed resolves once the connection closes'() {
    // Closes from onRawRx, not onRawAdopt - see the note on the analogous
    // TCPSocket test above.
    const port = freePort();
    const server = rawProtocolServer(port, 'echo', {
      name: 'echo',
      onRawRx(wsi) {
        wsi.close();
      },
    });

    const ts = new TCPSocketStream({ host: 'localhost', port });
    const { writable } = await ts.opened;

    await writable.getWriter().write('trigger');
    await ts.closed; // resolves (with no particular fields - raw has no close code/reason)

    server.destroy();
  },

  async 'TCPSocketStream.protocol() (server): round-trips raw bytes through a plain raw client'() {
    const port = freePort();

    let resolveReceived;
    const received = new Promise(resolve => (resolveReceived = resolve));

    const server = rawProtocolServer(
      port,
      'echo',
      TCPSocketStream.protocol('echo', async ts => {
        assert(ts instanceof TCPSocketStream, 'expected a TCPSocketStream from .protocol()');

        const { readable } = await ts.opened;
        const reader = readable.getReader();
        const { value } = await reader.read();

        resolveReceived(toString(value.buffer ?? value));
      }),
    );

    const client = new LWSContext({
      protocols: [
        {
          name: 'raw',
          onRawConnected(wsi) {
            wsi.write(toArrayBuffer('hello-client-side'));
          },
          onClientConnectionError(wsi, msg) {
            resolveReceived(Promise.reject(new Error(msg)));
          },
        },
      ],
    });
    client.clientConnect({ address: 'localhost', port, method: 'RAW', protocol: 'raw' });

    eq('hello-client-side', await received);

    client.destroy();
    server.destroy();
  },

  async 'TCPSocketStream.protocol() (server): two concurrent connections stay independent'() {
    const port = freePort();
    const results = {};
    let doneCount = 0;
    let resolveAll;
    const all = new Promise(resolve => (resolveAll = resolve));

    const server = rawProtocolServer(
      port,
      'echo',
      TCPSocketStream.protocol('echo', async ts => {
        const { readable, writable } = await ts.opened;
        const reader = readable.getReader();
        const writer = writable.getWriter();

        const { value } = await reader.read();
        const text = toString(value.buffer ?? value);

        await writer.write('ack:' + text);

        results[text] = true;
        if(++doneCount === 2) resolveAll();
      }),
    );

    function rawClient(msg) {
      const ctx = new LWSContext({
        protocols: [
          {
            name: 'raw',
            onRawConnected(wsi) {
              wsi.write(toArrayBuffer(msg));
            },
            onClientConnectionError(wsi, m) {
              fail('raw client connection error: ' + m);
            },
          },
        ],
      });
      ctx.clientConnect({ address: 'localhost', port, method: 'RAW', protocol: 'raw' });
      return ctx;
    }

    const c1 = rawClient('client-a');
    const c2 = rawClient('client-b');

    await all;

    assertStrictEquals(true, results['client-a']);
    assertStrictEquals(true, results['client-b']);

    c1.destroy();
    c2.destroy();
    server.destroy();
  },
});

// TCPSocket/TCPSocketStream each keep a lazily-created LWSContext singleton
// alive for the life of the process (by design, to share it across
// instances) - unlike every other suite here, nothing in this file ever
// destroys either one, so the event loop would otherwise never drain on
// its own.
std.exit(0);
