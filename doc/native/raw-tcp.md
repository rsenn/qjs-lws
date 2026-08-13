# Raw TCP

Raw TCP connections bypass HTTP and WebSocket framing entirely. They're useful for custom protocols, database clients, game servers, or any protocol that isn't HTTP/WS.

## Creating a Raw Listener

To accept raw TCP connections, use `listenAcceptRole: 'raw-skt'` and specify which protocol should handle them with `listenAcceptProtocol`:

```js
import { createServer, LWS_SERVER_OPTION_ADOPT_APPLY_LISTEN_ACCEPT_CONFIG } from 'lws';

createServer({
  port: 8080,
  options: LWS_SERVER_OPTION_ADOPT_APPLY_LISTEN_ACCEPT_CONFIG,
  listenAcceptRole: 'raw-skt',
  listenAcceptProtocol: 'my-raw',
  protocols: [
    { name: 'http', /* ... */ },
    { name: 'my-raw', /* ... */ }
  ]
});
```

The protocol named in `listenAcceptProtocol` can be anywhere in the `protocols` array — libwebsockets will look it up by name when binding the socket.

## Raw Client Connections

Use `clientConnect()` with `raw: true` to initiate outbound raw TCP:

```js
import { LWSContext, LCCSCF_USE_SSL } from 'lws';

const ctx = new LWSContext({
  protocols: [{
    name: 'raw-client',
    onClientConnect(wsi) {
      wsi.write('HELLO\n');
    },
    onClientRx(wsi, data, len) {
      console.log('received:', data);
    },
    onClientClose(wsi) {
      console.log('connection closed');
    }
  }]
});

ctx.clientConnect('example.com', 1234, {
  raw: true,
  protocol: 'raw-client'
});
```

## Raw Callbacks

### Server-side (listener)

- `onRawAccept(wsi)` — Called when a new connection is accepted
- `onRawRx(wsi, data, len)` — Called when data is received
- `onRawClose(wsi)` — Called when the connection closes
- `onRawWriteable(wsi)` — Called when the socket is ready to write (after `wantWrite()`)

### Client-side

- `onClientConnect(wsi)` — Called when the connection is established
- `onClientRx(wsi, data, len)` — Called when data is received
- `onClientClose(wsi)` — Called when the connection closes
- `onClientWriteable(wsi)` — Called when the socket is ready to write

## Writing Data

Use `wsi.write()` to send data. If the socket isn't ready, call `wsi.wantWrite()` first:

```js
{
  name: 'raw',
  onRawRx(wsi, data, len) {
    const response = processData(data);
    if (!wsi.write(response)) {
      wsi.wantWrite();  // queue for later
    }
  },
  onRawWriteable(wsi) {
    // Called after wantWrite() when socket is ready
    wsi.write(queuedData);
  }
}
```

For simpler code, you can use a promise-based wrapper to wait for
the socket to become writeable:

```js
await new Promise(r => wsi.wantWrite(r));
wsi.write(data);
```

## Mixed HTTP and Raw

You can accept both HTTP and raw connections on the same port using `LWS_SERVER_OPTION_ADOPT_APPLY_LISTEN_ACCEPT_CONFIG`:

```js
import { createServer, LWS_SERVER_OPTION_ADOPT_APPLY_LISTEN_ACCEPT_CONFIG } from 'lws';

createServer({
  port: 8080,
  options: LWS_SERVER_OPTION_ADOPT_APPLY_LISTEN_ACCEPT_CONFIG,
  listenAcceptRole: 'raw-skt',
  listenAcceptProtocol: 'raw-handler',
  protocols: [
    { name: 'http', onHttp(wsi, uri) { /* handle HTTP */ } },
    { name: 'raw-handler', onRawAccept(wsi) { /* handle raw */ } }
  ]
});
```

Connections that don't look like HTTP are routed to the raw protocol. HTTP-looking connections are routed to the HTTP protocol.

## Further Reading

- [Protocol Objects](protocols.md) — Understanding protocol definitions
- [Callbacks](callbacks.md) — Complete callback reference
- [Event Loop](event-loop.md) — Integration with libwebsockets' event loop
