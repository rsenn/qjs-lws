# Examples cookbook

End-to-end snippets you can paste into a `.js` file and run with
`qjs -I path/to/build script.js`. They use only the C-side API
documented in [module.md](module.md); the higher-level wrappers
under `lib/` are covered in [helpers.md](helpers.md).

## 1. WebSocket echo server

```js
import { createServer, LWSMPRO_NO_MOUNT } from 'lws';

createServer({
  port: 8080,
  vhostName: 'localhost',
  mounts: [{ mountpoint: '/echo', protocol: 'echo', originProtocol: LWSMPRO_NO_MOUNT }],
  protocols: [{
    name: 'echo',
    onReceive(wsi, data) { wsi.write(data); },
  }],
});
console.log('listening on ws://localhost:8080/echo');
```

## 2. WebSocket broadcast

```js
import { createServer, LWSMPRO_NO_MOUNT, LWS_WRITE_TEXT, toString } from 'lws';

const clients = new Set();

createServer({
  port: 8080,
  vhostName: 'localhost',
  mounts: [{ mountpoint: '/chat', protocol: 'chat', originProtocol: LWSMPRO_NO_MOUNT }],
  protocols: [{
    name: 'chat',
    onEstablished(wsi)   { clients.add(wsi); },
    onClosed(wsi)        { clients.delete(wsi); },
    onReceive(wsi, msg)  {
      const text = typeof msg === 'string' ? msg : toString(msg);
      for(const c of clients) c.write(text, LWS_WRITE_TEXT);
    },
  }],
});
```

## 3. WebSocket client

```js
import { LWSContext, toString } from 'lws';

const ctx = new LWSContext({
  protocols: [{
    name: 'ws',
    onClientEstablished(wsi)         { wsi.write('ping'); },
    onClientReceive(wsi, data)       { console.log('got', toString(data)); wsi.close(); },
    onClientClosed(wsi)              { ctx.cancelService(); },
    onClientConnectionError(wsi, m)  { console.error(m); ctx.cancelService(); },
  }],
});

ctx.clientConnect('wss://echo.websocket.events/');
```

## 4. Static-file server

```js
import { createServer, LWSMPRO_FILE } from 'lws';
import extraMimetypes from './lib/lws/mimetypes.js';

createServer({
  port: 8080,
  vhostName: 'localhost',
  mounts: [{
    mountpoint: '/',
    origin:     './public',
    def:        'index.html',
    originProtocol: LWSMPRO_FILE,
    extraMimetypes,
  }],
  protocols: [{ name: 'http' }],
});
```

## 5. HTTP endpoint that dispatches to JS

```js
import { createServer, LWSMPRO_CALLBACK, LWS_WRITE_HTTP_FINAL } from 'lws';

createServer({
  port: 8080,
  vhostName: 'localhost',
  mounts: [{ mountpoint: '/api', protocol: 'api', originProtocol: LWSMPRO_CALLBACK }],
  protocols: [{
    name: 'api',
    onHttp(wsi, uri) {
      const body = JSON.stringify({ uri, method: wsi.method });
      wsi.respond(200, { 'content-type': 'application/json' }, body.length);
      wsi.write(body, LWS_WRITE_HTTP_FINAL);
    },
  }],
});
```

## 6. HTTP server with HTTPS

```js
import {
  createServer, LWSMPRO_CALLBACK, LWS_WRITE_HTTP_FINAL,
  LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT,
  LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX,
  LWS_SERVER_OPTION_REDIRECT_HTTP_TO_HTTPS,
} from 'lws';

createServer({
  port: 443,
  vhostName: 'localhost',
  options:
      LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT
    | LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX
    | LWS_SERVER_OPTION_REDIRECT_HTTP_TO_HTTPS,
  serverSslCert:       'localhost.crt',
  serverSslPrivateKey: 'localhost.key',
  serverSslCa:         'ca.crt',
  mounts: [{ mountpoint: '/', protocol: 'http', originProtocol: LWSMPRO_CALLBACK }],
  protocols: [{
    name: 'http',
    onHttp(wsi) {
      wsi.respond(200, { 'content-type': 'text/plain' });
      wsi.write('secure hello\n', LWS_WRITE_HTTP_FINAL);
    },
  }],
});
```

## 7. HTTP client (GET) that prints the body

```js
import { LWSContext, toString } from 'lws';

const ctx = new LWSContext({
  protocols: [{
    name: 'http',
    onEstablishedClientHttp(wsi, status)  { console.error('status', status); },
    onReceiveClientHttp(wsi) {
      const buf = new ArrayBuffer(64 * 1024);
      if(wsi.httpClientRead(buf)) this.onReceiveClientHttpRead(wsi, buf);
    },
    onReceiveClientHttpRead(wsi, buf, len) {
      console.log(toString(buf, 0, len));
    },
    onClosedClientHttp(wsi) { ctx.cancelService(); },
    onClientConnectionError(wsi, m) { console.error(m); ctx.cancelService(); },
  }],
});

ctx.clientConnect('https://example.com/');
```

## 8. POSTing JSON

```js
import { LWSContext, LWS_WRITE_HTTP_FINAL, LCCSCF_USE_SSL } from 'lws';

const payload = JSON.stringify({ hello: 'world' });

const ctx = new LWSContext({
  protocols: [{
    name: 'http',
    onClientAppendHandshakeHeader(wsi, buf, len) {
      wsi.addHeader('content-type',   'application/json',          buf, len);
      wsi.addHeader('content-length', String(payload.length),       buf, len);
      if(wsi.method === 'POST') wsi.bodyPending = 1;
    },
    onClientHttpWriteable(wsi) {
      wsi.write(payload, LWS_WRITE_HTTP_FINAL);
      wsi.bodyPending = 0;
    },
    onEstablishedClientHttp(wsi, status) { console.error('->', status); },
    onClosedClientHttp(wsi) { ctx.cancelService(); },
  }],
});

ctx.clientConnect('https://httpbin.org/post', {
  method: 'POST',
  sslConnection: LCCSCF_USE_SSL,
});
```

## 9. Multipart file upload (server)

```js
import { createServer, LWSSPA, LWSMPRO_CALLBACK, LWS_WRITE_HTTP_FINAL } from 'lws';

const spaMap = new WeakMap();

createServer({
  port: 8080,
  vhostName: 'localhost',
  mounts: [{ mountpoint: '/upload', protocol: 'up', originProtocol: LWSMPRO_CALLBACK }],
  protocols: [{
    name: 'up',
    onFilterHttpConnection(wsi, url) {
      spaMap.set(wsi, new LWSSPA(wsi, {
        maxStorage: 1 << 17,
        onContent(name, file, buf) { console.log(name, file, buf.byteLength); },
      }));
    },
    onHttpBody(wsi, buf) { spaMap.get(wsi).process(buf, 0, buf.byteLength); },
    onHttpBodyCompletion(wsi) {
      spaMap.get(wsi).finalize();
      wsi.wantWrite(() => {
        wsi.respond(200, { 'content-type': 'text/plain' });
        wsi.write('uploaded\n', LWS_WRITE_HTTP_FINAL);
        return -1;
      });
    },
  }],
});
```

## 10. Raw TCP echo on port 1234

```js
import {
  createServer,
  LWS_SERVER_OPTION_ONLY_RAW,
  LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG,
} from 'lws';

createServer({
  port: 1234,
  options:
      LWS_SERVER_OPTION_ONLY_RAW
    | LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG,
  listenAcceptRole:     'raw-skt',
  listenAcceptProtocol: 'echo',
  protocols: [{
    name: 'echo',
    onRawAdopt(wsi)     { console.log('accept', wsi.peer?.host, wsi.peer?.port); },
    onRawRx(wsi, data)  { wsi.write(data); },
    onRawClose(wsi)     { console.log('close'); },
  }],
});
```

## 11. Logging into your own sink

```js
import { logLevel, getLogLevelName, LLL_USER, LLL_WARN, LLL_ERR } from 'lws';

logLevel(LLL_USER | LLL_WARN | LLL_ERR, (level, line) => {
  console.error(`[${getLogLevelName(level)}] ${line}`);
});
```

## 12. Inspecting live sockets

```js
import { LWSSocket } from 'lws';

setInterval(() => {
  for(const s of LWSSocket.list())
    console.error(s.id, s.protocol, s.peer?.host);
}, 5000);
```
