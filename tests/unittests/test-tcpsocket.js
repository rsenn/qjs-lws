/**
 * Tests lib/tcpsocket.js (`TCPSocket`, evented) and lib/tcpsocketstream.js
 * (`TCPSocketStream`, streams-based) independently, each against a minimal
 * counterpart that does *not* itself use either wrapper - so a failure
 * points at one specific side rather than either of two wrapped
 * implementations talking to each other. Mirrors test-websocketstream.js's
 * structure, adapted for the raw-TCP role (see that file for the WS/WSS
 * pair's own coverage).
 *
 *  - Client (`new TCPSocket(...)` / `new TCPSocketStream(...)`) is tested
 *    against a plain createServer() raw echo protocol.
 *  - Server (`TCPSocket.protocol()` / `TCPSocketStream.protocol()`) is
 *    tested against a plain LWSContext raw client.
 */
import { tests, eq, assert, assertStrictEquals, fail } from './tinytest.js';
import { createServer, LWSContext, toArrayBuffer, toString, LWS_SERVER_OPTION_ONLY_RAW, LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG } from 'lws';
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
