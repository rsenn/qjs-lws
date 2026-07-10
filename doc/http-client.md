# HTTP client

The same `LWSContext` + protocol mechanism drives outbound HTTP
requests. You create a context with no listening port, install an
`'http'` protocol with the client callbacks, and call
`ctx.clientConnect(url)`.

## GET with URL string

```js
import { LWSContext, toString } from 'lws';

const ctx = new LWSContext({
  protocols: [{
    name: 'http',
    onEstablishedClientHttp(wsi, status) {
      console.log('status', status, wsi.headers);
    },
    onReceiveClientHttp(wsi) {                    // tells us bytes are ready
      const buf = new ArrayBuffer(64 * 1024);
      if(wsi.httpClientRead(buf))                 // copies them out
        this.onReceiveClientHttpRead(wsi, buf);
    },
    onReceiveClientHttpRead(wsi, data, len) {
      console.log(toString(data, 0, len));
    },
    onCompletedClientHttp(wsi)  { /* body fully received */ },
    onClosedClientHttp(wsi)     { ctx.cancelService(); },
    onClientConnectionError(wsi, msg, errno) {
      console.error('error', msg, errno);
      ctx.cancelService();
    },
  }],
});

ctx.clientConnect('https://blog.fefe.de/');
```

`onReceiveClientHttp` is a "data ready" notification — you must
call `wsi.httpClientRead(buf)` yourself to drain the read.

## Sending custom request headers

```js
import { WSI_TOKEN_HTTP_ACCEPT, WSI_TOKEN_HTTP_USER_AGENT } from 'lws';

{
  name: 'http',
  onClientAppendHandshakeHeader(wsi, buf, len) {
    wsi.addHeader(WSI_TOKEN_HTTP_ACCEPT,     '*/*',      buf, len);
    wsi.addHeader(WSI_TOKEN_HTTP_USER_AGENT, 'qjs-lws',  buf, len);
    wsi.addHeader('x-custom',                'value',    buf, len);
  },
}
```

Use the `WSI_TOKEN_HTTP_*` constants where they exist — they pack
more tightly in the request than a literal name.

## POST with a body

```js
import { LCCSCF_USE_SSL, LWS_WRITE_HTTP_FINAL } from 'lws';

ctx.clientConnect('https://httpbin.org/post', {
  method: 'POST',
  sslConnection: LCCSCF_USE_SSL,
});
```

In the protocol:

```js
{
  name: 'http',
  onClientAppendHandshakeHeader(wsi, buf, len) {
    if(!wsi.redirectedToGet && wsi.method === 'POST')
      wsi.bodyPending = 1;                    // tells lws there's a body
  },
  onClientHttpWriteable(wsi) {
    wsi.write('{"hello":"world"}', LWS_WRITE_HTTP_FINAL);
    wsi.bodyPending = 0;
  },
}
```

`wsi.bodyPending` is a getter/setter — assigning calls
`lws_client_http_body_pending()`.

## Multipart upload

```js
import { LCCSCF_HTTP_MULTIPART_MIME } from 'lws';

ctx.clientConnect('https://example.com/upload', {
  method: 'POST',
  sslConnection: LCCSCF_USE_SSL | LCCSCF_HTTP_MULTIPART_MIME,
});
```

```js
onClientHttpWriteable(wsi) {
  const ab = new ArrayBuffer(4096);
  let len = wsi.clientHttpMultipart('field', null, null, ab);   // text part header
  len += write('value\r\n', ab, len);
  len += wsi.clientHttpMultipart('file', 'a.txt', 'text/plain', ab, len);
  len += write('hello\r\n', ab, len);
  len += wsi.clientHttpMultipart(null, null, null, ab, len);    // closing boundary

  wsi.write(ab, len, LWS_WRITE_HTTP_FINAL);
  wsi.bodyPending = 0;
}
```

## Redirects

`onClientHttpRedirect(wsi, url, status)` fires before the redirect is
followed. Set `LCCSCF_HTTP_NO_FOLLOW_REDIRECT` in `sslConnection` to
disable redirect following.

`wsi.redirectedToGet` is `true` if a POST was downgraded to GET via
a 303 redirect.

## Connection pipelining / keep-alive

By default every `clientConnect()` opens its own network connection.
Setting `LCCSCF_PIPELINE` in `sslConnection` lets lws reuse an
existing connection to the same vhost/endpoint instead: for h1,
subsequent requests queue on the first ("leader") connection and run
sequentially over it; for h2, they join the same network connection
as parallel mux streams as soon as it's up. See
`libwebsockets/lib/core-net/README.md` for the full mechanism.

```js
import { LCCSCF_PIPELINE } from 'lws';

const a = ctx.clientConnect(url, { sslConnection: LCCSCF_PIPELINE });
const b = ctx.clientConnect(url, { sslConnection: LCCSCF_PIPELINE });
```

Both connections still get their own full set of callbacks — lws
does not distinguish "leader" from "queued" at the callback level
(see `lib/core-net/README.md`: "The user code does not know which
wsi was first or is queued, it just waits for stuff to happen the
same either way"). To actually observe whether reuse happened, use
the `pipelineLeader` / `isPipelineLeader` / `pipelineQueueDepth`
accessors on `LWSSocket` — see
[LWSSocket.md](LWSSocket.md#pipelining--keep-alive-introspection).

These accessors require the `lws_get_txn_queue_leader()` /
`lws_wsi_is_txn_queue_leader()` / `lws_get_txn_queue_depth()` patch
to the vendored libwebsockets in `patches/`; upstream lws does not
expose this state. `lib/fetch.js` does not use `LCCSCF_PIPELINE` yet
(each `fetch()` call opens its own `LWSContext`/vhost, so there's no
shared "existing connection" to reuse) — using it there needs the
caller to share one context/vhost across calls first.

## Promise wrapper: `lib/fetch.js`

`lib/fetch.js` builds a WHATWG-`fetch`-shaped API on top of these
callbacks:

```js
import { fetch } from './lib/fetch.js';

const res = await fetch('https://example.com/', { tls: {} });
console.log(res.status, res.headers);
for await (const chunk of res.body) console.log(toString(chunk));
```

It uses the `ReadableStream` adapter from `lib/lws/streams.js` and a
permissive default TLS setup.
