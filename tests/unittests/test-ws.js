/**
 * Exercises the WebSocket-relevant parts of the raw native 'lws.so' module
 * directly - not lib/websocket.js's wrapper (see test-websocket.js for
 * that) - in both roles (server via createServer()/onXxx, client via
 * LWSContext/onClientXxx), each against a plain counterpart on the other
 * end so a failure points at one specific side.
 *
 * Close code/reason is the focus here, and it's split across two distinct,
 * non-overlapping mechanisms - a wsi only ever gets its code/reason from
 * one of them, never both:
 *
 *  - onClosed()/onClientClosed() report the code/reason from OUR OWN local
 *    wsi.close(code, reason) call - previously always undefined/undefined,
 *    regardless of which side closed, or whether the peer even reacted.
 *    lwsjs_socket_close() (lws-socket.c) stashes its own copy of code/
 *    reason onto the LWSSocket the moment .close() is called; deliberately
 *    NOT read back via lws_get_close_length()/lws_get_close_payload() at
 *    CLOSED time, because those read wsi->ws->ping_payload_buf, which lws
 *    reuses (and mutates in place - WS frame masking is applied to it
 *    whenever a client sends a frame, including its own close frame) to
 *    actually put the close frame on the wire - by CLOSED/CLIENT_CLOSED
 *    time it may no longer hold the bytes it was given. Confirmed
 *    empirically while building this: a client-side self-close came back
 *    with a scrambled code every time despite the right byte count, and
 *    the server-side RX path for an incoming close frame doesn't populate
 *    that buffer at all (only the client-side one does - see ops-ws.c's
 *    "server sees client close packet" vs client-parser-ws.c). Reading our
 *    own stash instead sidesteps both problems.
 *
 *  - onWsPeerInitiatedClose() reports the code/reason the *other* side
 *    sent, on whichever side received it. This already existed before the
 *    onClosed()/onClientClosed() work above and isn't changed here; it's
 *    exercised below for completeness alongside the locally-initiated
 *    cases, since a real close handler generally wants to distinguish "I
 *    was asked to close, here's why" from "I know why I closed".
 *
 * A wsi.close() call is deferred a microtask past onClientEstablished
 * (rather than called synchronously from inside it) wherever the *client*
 * initiates the close below: lws-protocol.c forces the dispatch's C-level
 * return value to nonzero whenever wsi.close() was called synchronously
 * during that same callback (so a plain, synchronous close() from a
 * callback still closes the connection even if the JS handler itself
 * returns normally) - and client-ws.c treats a nonzero
 * LWS_CALLBACK_CLIENT_ESTABLISHED return as a rejected handshake
 * ("HS: Rejected at CLIENT_ESTABLISHED", routed through
 * onClientConnectionError) rather than a clean close, which never reaches
 * onClientClosed at all. Deferring past the callback's own return sidesteps
 * that - and matches how a real client would close sometime after
 * connecting, not from inside the connection-established handler itself.
 * The equivalent isn't needed server-side: LWS_CALLBACK_ESTABLISHED has no
 * such special-cased rejection path.
 */
import { tests, eq, assert } from './tinytest.js';
import { createServer, LWSContext, LWSMPRO_NO_MOUNT, LWS_WRITE_TEXT } from 'lws.so';
import { TextDecoder } from 'textcode';
import { freePort } from './subprocess-utils.js';

// A fresh TextDecoder per call, not a shared module-level one: decode()
// defaults to streaming semantics that carry incomplete-sequence state
// across calls, and this file feeds it both message text and close-frame
// reason bytes from many independent connections - no reason to let one
// call's state affect another's.
const asText = value => (typeof value === 'string' ? value : value === undefined ? undefined : new TextDecoder().decode(value));

function echoServer(port, extra = {}) {
  return createServer({
    port,
    vhostName: 'localhost',
    mounts: [{ mountpoint: '/echo', protocol: 'echo', originProtocol: LWSMPRO_NO_MOUNT }],
    protocols: [{ name: 'echo', ...extra }],
  });
}

function connect(port, handlers) {
  const client = new LWSContext({ protocols: [{ name: 'ws', ...handlers }] });
  client.clientConnect(`ws://localhost:${port}/echo`, { protocol: 'echo', localProtocolName: 'ws' });
  return client;
}

await tests({
  async 'server (raw): onReceive/wsi.write round-trip a message'() {
    const port = freePort();
    let serverSaw;

    const server = echoServer(port, {
      onReceive(wsi, data) {
        serverSaw = asText(data);
        wsi.write(data, LWS_WRITE_TEXT);
      },
    });

    let client;
    const received = new Promise((resolve, reject) => {
      client = connect(port, {
        onClientEstablished(wsi) {
          wsi.write('hello-server', LWS_WRITE_TEXT);
        },
        onClientReceive(wsi, data) {
          resolve(asText(data));
        },
        onClientConnectionError(wsi, msg) {
          reject(new Error(msg));
        },
      });
    });

    eq('hello-server', await received);
    eq('hello-server', serverSaw);

    client.destroy();
    server.destroy();
  },

  async 'server (raw): onClosed reports the code/reason the server itself sent (locally-initiated)'() {
    const port = freePort();
    let resolveClosed;
    const closed = new Promise(resolve => (resolveClosed = resolve));

    const server = echoServer(port, {
      onEstablished(wsi) {
        wsi.close(4011, 'server-bye');
      },
      onClosed(wsi, code, reason) {
        resolveClosed({ code, reason: asText(reason) });
      },
    });

    const client = connect(port, {
      onClientConnectionError(wsi, msg) {
        resolveClosed(Promise.reject(new Error(msg)));
      },
    });

    const { code, reason } = await closed;
    eq(4011, code);
    eq('server-bye', reason);

    client.destroy();
    server.destroy();
  },

  async 'server (raw): onClosed leaves reason undefined for a code-only close'() {
    const port = freePort();
    let resolveClosed;
    const closed = new Promise(resolve => (resolveClosed = resolve));

    const server = echoServer(port, {
      onEstablished(wsi) {
        wsi.close(4012);
      },
      onClosed(wsi, code, reason) {
        resolveClosed({ code, reason });
      },
    });

    const client = connect(port, {
      onClientConnectionError(wsi, msg) {
        resolveClosed(Promise.reject(new Error(msg)));
      },
    });

    const { code, reason } = await closed;
    eq(4012, code);
    assert(reason === undefined, 'expected no reason arg, got: ' + JSON.stringify(reason));

    client.destroy();
    server.destroy();
  },

  async 'server (raw): onClosed reports no code/reason for a peer-initiated close'() {
    const port = freePort();
    let resolveClosed;
    const closed = new Promise(resolve => (resolveClosed = resolve));

    const server = echoServer(port, {
      onClosed(wsi, code, reason) {
        resolveClosed({ code, reason });
      },
    });

    const client = connect(port, {
      onClientEstablished(wsi) {
        Promise.resolve().then(() => wsi.close(4013, 'client-bye'));
      },
      onClientConnectionError(wsi, msg) {
        resolveClosed(Promise.reject(new Error(msg)));
      },
    });

    const { code, reason } = await closed;
    assert(code === undefined, 'expected no code (this close was peer-initiated, not local), got: ' + code);
    assert(reason === undefined, 'expected no reason, got: ' + JSON.stringify(reason));

    client.destroy();
    server.destroy();
  },

  async 'server (raw): onWsPeerInitiatedClose reports the code/reason the client sent'() {
    const port = freePort();
    let resolveClosed;
    const closed = new Promise(resolve => (resolveClosed = resolve));

    const server = echoServer(port, {
      onWsPeerInitiatedClose(wsi, code, reason) {
        resolveClosed({ code, reason: asText(reason) });
        return 0;
      },
    });

    const client = connect(port, {
      onClientEstablished(wsi) {
        Promise.resolve().then(() => wsi.close(4014, 'client-bye'));
      },
      onClientConnectionError(wsi, msg) {
        resolveClosed(Promise.reject(new Error(msg)));
      },
    });

    const { code, reason } = await closed;
    eq(4014, code);
    eq('client-bye', reason);

    client.destroy();
    server.destroy();
  },

  async 'client (raw): onClientClosed reports the code/reason the client itself sent (locally-initiated)'() {
    const port = freePort();

    const server = echoServer(port);

    let resolveClosed;
    const closed = new Promise(resolve => (resolveClosed = resolve));

    const client = connect(port, {
      onClientEstablished(wsi) {
        Promise.resolve().then(() => wsi.close(4021, 'client-bye'));
      },
      onClientClosed(wsi, code, reason) {
        resolveClosed({ code, reason: asText(reason) });
      },
      onClientConnectionError(wsi, msg) {
        resolveClosed(Promise.reject(new Error(msg)));
      },
    });

    const { code, reason } = await closed;
    eq(4021, code);
    eq('client-bye', reason);

    client.destroy();
    server.destroy();
  },

  async 'client (raw): onClientClosed leaves reason undefined for a code-only close'() {
    const port = freePort();

    const server = echoServer(port);

    let resolveClosed;
    const closed = new Promise(resolve => (resolveClosed = resolve));

    const client = connect(port, {
      onClientEstablished(wsi) {
        Promise.resolve().then(() => wsi.close(4022));
      },
      onClientClosed(wsi, code, reason) {
        resolveClosed({ code, reason });
      },
      onClientConnectionError(wsi, msg) {
        resolveClosed(Promise.reject(new Error(msg)));
      },
    });

    const { code, reason } = await closed;
    eq(4022, code);
    assert(reason === undefined, 'expected no reason arg, got: ' + JSON.stringify(reason));

    client.destroy();
    server.destroy();
  },

  async 'client (raw): onClientClosed reports no code/reason for a peer-initiated close'() {
    const port = freePort();

    const server = echoServer(port, {
      onEstablished(wsi) {
        wsi.close(4023, 'server-bye');
      },
    });

    let resolveClosed;
    const closed = new Promise(resolve => (resolveClosed = resolve));

    const client = connect(port, {
      onClientClosed(wsi, code, reason) {
        resolveClosed({ code, reason });
      },
      onClientConnectionError(wsi, msg) {
        resolveClosed(Promise.reject(new Error(msg)));
      },
    });

    const { code, reason } = await closed;
    assert(code === undefined, 'expected no code (this close was peer-initiated, not local), got: ' + code);
    assert(reason === undefined, 'expected no reason, got: ' + JSON.stringify(reason));

    client.destroy();
    server.destroy();
  },

  async 'client (raw): onWsPeerInitiatedClose reports the code/reason the server sent'() {
    const port = freePort();

    const server = echoServer(port, {
      onEstablished(wsi) {
        wsi.close(4024, 'server-bye');
      },
    });

    let resolveClosed;
    const closed = new Promise(resolve => (resolveClosed = resolve));

    const client = connect(port, {
      onWsPeerInitiatedClose(wsi, code, reason) {
        resolveClosed({ code, reason: asText(reason) });
        return 0;
      },
      onClientConnectionError(wsi, msg) {
        resolveClosed(Promise.reject(new Error(msg)));
      },
    });

    const { code, reason } = await closed;
    eq(4024, code);
    eq('server-bye', reason);

    client.destroy();
    server.destroy();
  },

  async 'two concurrent connections each get their own locally-initiated close code'() {
    const port = freePort();
    const results = {};
    let doneCount = 0;
    let resolveAll;
    const all = new Promise(resolve => (resolveAll = resolve));

    // First connection in gets 4030/'bye-a', the second 4031/'bye-b' - a
    // plain closed-over counter, since this protocol has no per-session
    // data (perSessionDataSize) for onEstablished to key off `this`.
    let nextCode = 4030;

    const server = echoServer(port, {
      onEstablished(wsi) {
        const code = nextCode++;

        wsi.close(code, 'bye-' + (code === 4030 ? 'a' : 'b'));
      },
      onClosed(wsi, code, reason) {
        results[code] = asText(reason);
        if(++doneCount === 2) resolveAll();
      },
    });

    function client() {
      return connect(port, {
        onClientConnectionError(wsi, msg) {
          resolveAll(Promise.reject(new Error(msg)));
        },
      });
    }

    const a = client();
    const b = client();

    await all;

    eq('4030,4031', Object.keys(results).sort().join(','));
    eq('bye-a', results[4030]);
    eq('bye-b', results[4031]);

    a.destroy();
    b.destroy();
    server.destroy();
  },
});
