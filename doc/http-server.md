# HTTP server

An HTTP server is an `LWSContext` with a listening `port`, an
`'http'` protocol that implements the HTTP callbacks, and a set of
mounts (`/api` → callback, `/static` → file, etc.).

## Hello world

```js
import { LWSContext, LWSMPRO_CALLBACK, LWS_WRITE_HTTP_FINAL } from 'lws';

new LWSContext({
  port: 3000,
  vhostName: 'localhost',
  mounts: [{ mountpoint: '/', protocol: 'http', originProtocol: LWSMPRO_CALLBACK }],
  protocols: [{
    name: 'http',
    onHttp(wsi, uri) {
      wsi.respond(200, { 'content-type': 'text/plain' });
      wsi.write(`hello ${uri}\n`, LWS_WRITE_HTTP_FINAL);
    },
  }],
});
```

`wsi.respond(status, headers?, length?, body?)` writes the response
headers and (optionally) a body in one shot. With no Content-Length
argument it passes `LWS_ILLEGAL_HTTP_CONTENT_LEN`, asking lws to
send `Transfer-Encoding: chunked` (when the role supports it) or
to omit the header.

## Inspecting the request

```js
onHttp(wsi, uri) {
  const { method, uri: u, headers } = wsi;
  console.log(method, u, headers['user-agent']);
}
```

- `wsi.method` is `'GET' | 'POST' | 'PUT' | …`
- `wsi.uri` is the path
- `wsi.headers` is a plain object of lowercased header names → values
- `wsi.tls` indicates TLS
- `wsi.peer` is an `LWSSockAddr46`; `wsi.peer.host` / `.port` are the
  remote endpoint

## Streaming a response

Use `wantWrite()` to drive each chunk:

```js
onHttp(wsi) {
  const obj = state(wsi);
  obj.lines = ['line 1\n', 'line 2\n', 'line 3\n'];
  wsi.respond(200, { 'content-type': 'text/plain' });
  obj.i = 0;
  wsi.wantWrite();
},
onHttpWriteable(wsi) {
  const obj = state(wsi);
  const more = obj.lines[obj.i + 1] !== undefined;
  wsi.write(obj.lines[obj.i++], more ? LWS_WRITE_HTTP : LWS_WRITE_HTTP_FINAL);
  if(more) wsi.wantWrite();
  else     return -1;
}
```

`LWS_WRITE_HTTP_FINAL` makes the binding call
`lws_http_transaction_completed()` and marks the wsi as completed —
the next non-zero return then closes the transaction.

## Reading the request body (POST/PUT)

```js
{
  name: 'http',
  onHttp(wsi)              { this.body = []; },
  onHttpBody(wsi, buf, len){ this.body.push(buf); },
  onHttpBodyCompletion(wsi){
    const all = concat(this.body);
    wsi.wantWrite(() => {
      wsi.respond(200, { 'content-type': 'text/plain' });
      wsi.write(`got ${all.byteLength} bytes\n`, LWS_WRITE_HTTP_FINAL);
      return -1;
    });
  },
}
```

For `multipart/form-data` or `application/x-www-form-urlencoded`,
use [`LWSSPA`](LWSSPA.md):

```js
import { LWSSPA } from 'lws';

const spaByWsi = new WeakMap();

{
  name: 'http',
  onFilterHttpConnection(wsi, url) {
    if(/multipart/.test(wsi.headers['content-type']))
      spaByWsi.set(wsi, new LWSSPA(wsi, {
        maxStorage: 1 << 17,
        onContent: (n, f, b) => console.log(n, f, b.byteLength),
      }));
  },
  onHttpBody(wsi, buf) { spaByWsi.get(wsi)?.process(buf, 0, buf.byteLength); },
  onHttpBodyCompletion(wsi) {
    spaByWsi.get(wsi)?.finalize();
    wsi.wantWrite(() => {
      wsi.respond(200, { 'content-type': 'text/plain' });
      wsi.write('ok\n', LWS_WRITE_HTTP_FINAL);
      return -1;
    });
  },
}
```

## Adding response headers from a hook

`onAddHeaders(wsi, buf, len)` runs *after* `respond()` reserves the
common headers and lets you append more:

```js
onAddHeaders(wsi, buf, len) {
  wsi.addHeader('x-served-by', 'qjs-lws', buf, len);
}
```

`buf` is the working ArrayBuffer; `len` is a `[offset]` tuple kept
up to date by `addHeader`.

## Static-file mounts and rewriting HTML

```js
import extraMimetypes from './lib/lws/mimetypes.js';

new LWSContext({
  port: 8080,
  mounts: [
    { mountpoint: '/static', origin: './public', def: 'index.html',
      originProtocol: LWSMPRO_FILE, extraMimetypes },
    { mountpoint: '/api', protocol: 'http', originProtocol: LWSMPRO_CALLBACK },
  ],
  protocols: [{ name: 'http', onHttp(wsi, uri){ /* … */ } }],
});
```

`onProcessHtml(wsi, buf, len)` can rewrite chunks of HTML being
served from disk; you write the transformed bytes back into `buf`
and update `len[0]`.

## Returning HTTP errors

```js
onHttp(wsi, uri) {
  if(!authorized(wsi.headers)) {
    wsi.respond(401, { 'www-authenticate': 'Basic realm="x"' });
    wsi.write('unauthorized\n', LWS_WRITE_HTTP_FINAL);
    return 0;
  }
  // …
}
```

## High-level helper: `lib/serve.js`

`lib/serve.js` wraps this pattern as `serve(opts, handler)` where
`handler(request)` returns a `Response` (similar to Bun's `serve`).
It uses the same C bindings.
