# Raw TCP

libwebsockets supports "raw" sockets — plain TCP without HTTP /
WebSocket framing. qjs-lws exposes this through the same protocol
table by selecting the `raw-skt` role and using the `onRaw*`
callbacks.

## Raw client

```js
import { LWSContext, toArrayBuffer, toString } from 'lws';

const ctx = new LWSContext({
  protocols: [{
    name: 'raw',
    onConnecting(wsi, fd)        { /* socket() just returned */ },
    onRawConnected(wsi)          { wsi.write(toArrayBuffer('GET / HTTP/1.0\r\n\r\n')); },
    onRawRx(wsi, data)           { console.log(toString(data)); },
    onRawWriteable(wsi)          { /* called when send buffer drains */ },
    onRawClose(wsi, errno)       { ctx.cancelService(); },
  }],
});

ctx.clientConnect({
  address: 'example.com',
  port:    80,
  method:  'RAW',
  protocol: 'raw',
});
```

`method: 'RAW'` triggers raw mode; `protocol` is the name lookup
into the JS protocols table.

## Raw listener

`tcpSocket.js` shows the pattern: pass
`LWS_SERVER_OPTION_ONLY_RAW | LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG`
in `options` so the listener accepts plain TCP and routes new
connections through the protocol named in `listenAcceptProtocol`.

```js
import {
  createServer, toString,
  LWS_SERVER_OPTION_ONLY_RAW,
  LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG,
} from 'lws';

createServer({
  port: 1234,
  options: LWS_SERVER_OPTION_ONLY_RAW
         | LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG,
  listenAcceptRole:     'raw-skt',
  listenAcceptProtocol: 'echo',
  protocols: [{
    name: 'echo',
    onRawAdopt(wsi)        { console.log('accept', wsi.peer?.host); },
    onRawRx(wsi, data)     { wsi.write(data); },
    onRawClose(wsi)        { console.log('close'); },
  }],
});
```

## Raw vs. WebSocket lifecycle

| Event | Raw                 | WebSocket |
|-------|---------------------|-----------|
| Accept new conn | `onRawAdopt`  | `onEstablished` |
| Outbound connected | `onRawConnected` | `onClientEstablished` |
| Bytes available | `onRawRx`     | `onReceive` / `onClientReceive` |
| Ready to write | `onRawWriteable` | `onServerWriteable` / `onClientWriteable` |
| Closed | `onRawClose(errno)`  | `onClosed` / `onClientClosed` |

Raw sockets have no framing — `wsi.write(data)` writes the bytes as
is, no `LWS_PRE` padding is added (the binding only adds it for the
WebSocket role).

## Mixed listener (HTTP + raw fall-back)

`LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG` lets a
single port serve HTTP **and** drop to raw mode when the first
bytes don't look like HTTP:

```js
import { createServer, LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG } from 'lws';

createServer({
  port: 8080,
  options: LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG,
  listenAcceptRole:     'raw-skt',
  listenAcceptProtocol: 'raw-echo',
  protocols: [
    { name: 'http',     onHttp(wsi)   { /* … */ } },
    { name: 'raw-echo', onRawRx(wsi, d) { wsi.write(d); } },
  ],
});
```

## High-level wrapper: `lib/tcpSocket.js`

`TCPSocket` / `TCPSocketStream` from `lib/tcpSocket.js` wrap the raw
protocol with an EventTarget and a WHATWG-streams view:

```js
import { toString } from 'lws';
import { TCPSocket } from './lib/tcpSocket.js';

const s = new TCPSocket('example.com', 80);
s.addEventListener('open',    () => s.send('GET / HTTP/1.0\r\n\r\n'));
s.addEventListener('message', e => console.log(toString(e.data)));
s.addEventListener('close',   () => console.log('closed'));
```
