# WebSocket client

A WebSocket client uses an `LWSContext` with no listening port and a
protocol that implements the client-side callbacks. The connection
is opened with `ctx.clientConnect(url, info)`.

## Minimal client

```js
import { LWSContext, toString } from 'lws';

const ctx = new LWSContext({
  protocols: [{
    name: 'ws',
    onClientEstablished(wsi)         { wsi.write('hello'); },
    onClientReceive(wsi, data)       { console.log('recv', toString(data)); },
    onClientClosed(wsi)              { ctx.cancelService(); },
    onClientConnectionError(wsi, msg) { console.error('fail', msg); ctx.cancelService(); },
  }],
});

ctx.clientConnect('wss://echo.websocket.events/');
```

The URI scheme:

- `ws://` / `wss://`  → WebSocket
- `http://` / `https://` → HTTP (`method` defaults to `GET`)

For `wss://` / `https://`, qjs-lws sets a permissive default
`ssl_connection` mask (see [tls.md](tls.md)).

## Subprotocols

```js
ctx.clientConnect('wss://example.com/socket', {
  protocol: 'chat,v2',           // Sec-WebSocket-Protocol header
  localProtocolName: 'ws',       // which JS protocol handles the wsi
});
```

`localProtocolName` selects the JS protocol descriptor by name. If
omitted, libwebsockets picks one based on the wsi role.

## Connection info object

If you skip the URI-string form, pass an info object:

```js
ctx.clientConnect({
  address: 'example.com',
  port:    443,
  path:    '/ws',
  host:    'example.com',
  origin:  'https://example.com',
  protocol: 'chat',
  localProtocolName: 'ws',
  ssl:     true,
  authUsername: 'user',
  authPassword: 'pass',
  iface:   'eth0',
  localPort: 12345,
  alpn:    'h2,http/1.1',
  keepWarmSecs: 30,
});
```

See [LWSContext.md](LWSContext.md#clientconnect) for the full list.

## Writing

```js
{
  name: 'ws',
  onClientEstablished(wsi) {
    this.queue = ['ping', 'how are you?'];
    wsi.wantWrite();
  },
  onClientWriteable(wsi) {
    const msg = this.queue.shift();
    if(msg !== undefined) wsi.write(msg);
    if(this.queue.length) wsi.wantWrite();
  },
}
```

## Sending custom handshake headers

`onClientAppendHandshakeHeader(wsi, buf, len)` lets you inject
headers right before the upgrade request is sent:

```js
import { WSI_TOKEN_HTTP_USER_AGENT, WSI_TOKEN_HTTP_COOKIE } from 'lws';

{
  name: 'ws',
  onClientAppendHandshakeHeader(wsi, buf, len) {
    wsi.addHeader(WSI_TOKEN_HTTP_USER_AGENT, 'qjs-lws/1.0', buf, len);
    wsi.addHeader(WSI_TOKEN_HTTP_COOKIE,     'session=abc',  buf, len);
  },
}
```

`buf` is an `ArrayBuffer` provided by libwebsockets; `len` is a
single-element array `[n]` tracking the running offset that
`addHeader` updates in place.

## Receiving and closing

```js
{
  name: 'ws',
  onClientReceive(wsi, data, len, frame) {
    if(typeof data === 'string') console.log('text:', data);
    else                          console.log('binary:', new Uint8Array(data));
  },
  onWsPeerInitiatedClose(wsi, code, reason) {
    console.log('server closed', code, reason);
  },
  onClientClosed(wsi) {
    ctx.cancelService();      // exit the script
  },
}
```

`onClientConnectionError(wsi, message, errno)` fires for TCP / TLS
/ HTTP-handshake failures *before* the WebSocket is established.

## Promise / EventTarget wrapper

`lib/websocket.js` exposes a thin WHATWG-WebSocket facade built on
top of these callbacks:

```js
import { WebSocket } from './lib/websocket.js';

const ws = new WebSocket('wss://echo.websocket.events/', 'chat');
ws.addEventListener('open',    () => ws.send('hi'));
ws.addEventListener('message', e => console.log(e.data));
ws.addEventListener('close',   () => console.log('closed'));
```
