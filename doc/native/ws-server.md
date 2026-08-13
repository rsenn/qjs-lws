# WebSocket server

A WebSocket server is just an `LWSContext` with a protocol whose
WebSocket callbacks are populated, plus a mount that gives the
protocol a URL prefix (or that is implicit by selecting the protocol
via `Sec-WebSocket-Protocol`).

## Minimal echo server

```js
import { createServer, LWS_WRITE_TEXT, LWSMPRO_NO_MOUNT } from 'lws';

createServer({
  port: 8080,
  vhostName: 'localhost',
  mounts: [{
    mountpoint: '/echo',
    protocol:   'echo',
    originProtocol: LWSMPRO_NO_MOUNT,
  }],
  protocols: [{
    name: 'echo',
    onEstablished(wsi)    { this.peer = wsi.peer?.host; console.log('open', this.peer); },
    onReceive(wsi, data)  { wsi.write(data); },               // text or binary
    onClosed(wsi)         { console.log('close', this.peer); },
  }],
});
```

The `this` object inside the callbacks is **per-connection** — see
[LWSSocket.md](LWSSocket.md#lifetime--per-session-data).

## Backpressure: writing only when writeable

For any write larger than one packet, request a writeable signal
and queue data inside the writeable callback:

```js
{
  name: 'feed',
  async onEstablished(wsi) {
    this.queue = ['a', 'b', 'c', 'd'];
    wsi.wantWrite();
  },
  onServerWriteable(wsi) {
    const msg = this.queue.shift();
    if(msg !== undefined) wsi.write(msg);
    if(this.queue.length) wsi.wantWrite();
  },
}
```

You can also pass a one-shot handler to `wantWrite`:

```js
import { waitWrite } from './lib/lws/util.js';

await waitWrite(wsi);    // resolves on next writeable
wsi.write('hello');
```

## Sub-protocols and the upgrade

If the client sends `Sec-WebSocket-Protocol: chat, foo`, lws picks
the first JS protocol whose `name` matches. Bind a URL prefix to a
protocol name via `mounts` (`LWSMPRO_NO_MOUNT` reserves the prefix
for non-HTTP use).

To intercept the upgrade itself:

```js
{
  name: 'chat',
  onHttpConfirmUpgrade(wsi, kind) {       // kind === 'websocket'
    if(!validate(wsi.headers)) return -1;  // reject
  },
  onFilterProtocolConnection(wsi, name) { /* inspect chosen subprotocol */ },
  onEstablished(wsi) { … },
}
```

## Receiving multi-fragment messages

For frames larger than the configured `rx_buffer_size`, the
fragment descriptor is appended as a third argument:

```js
onReceive(wsi, data, len, frame) {
  if(frame?.multifragment) {
    this.parts ??= [];
    this.parts.push(data);
    if(frame.final) {
      handle(concat(this.parts));
      this.parts.length = 0;
    }
  } else {
    handle(data);
  }
}
```

## Handling the close frame

When the peer sends a close frame, the binding synthesises
`onWsPeerInitiatedClose(wsi, code, reasonStr)` instead of
`onClientReceive`. After `onClosed` runs the connection is gone.

```js
{
  name: 'chat',
  onWsPeerInitiatedClose(wsi, code, reason) {
    console.log('peer closed', code, reason);
    return 0;
  },
  onClosed(wsi) { … },
}
```

## Closing from the server

```js
wsi.close(1000, 'bye');     // status code + optional reason
```

`code` defaults to `1000`. `reason` may be a string or `ArrayBuffer`.

## Reflecting client headers

```js
onEstablished(wsi) {
  const { headers } = wsi;
  console.log('User-Agent:', headers['user-agent']);
  console.log('Origin:',     headers['origin']);
}
```

`wsi.headers` is populated on first access after a relevant HTTP
callback (`FILTER_HTTP_CONNECTION`, `CLIENT_FILTER_PRE_ESTABLISH`,
`HTTP`, `ESTABLISHED_CLIENT_HTTP`).
