# `LWSSocket`

A wrapper around `struct lws *` (a libwebsockets connection, "wsi").
Implemented in `lws-socket.c`. Sockets are not constructed from JS —
they are created internally for each connection and passed as the
first argument to protocol callbacks.

The `LWSSocket` constructor itself only carries the static helpers
`LWSSocket.list()` and `LWSSocket.get(id)`.

## Static helpers

| Method | Returns |
|--------|---------|
| `LWSSocket.list()`   | Array of every live `LWSSocket` |
| `LWSSocket.get(id)`  | The socket whose `id` matches (see `id` property), or `null` |

## Instance methods

### `wantWrite([callback])`

Calls `lws_callback_on_writable()`. When the connection is next
writeable, libwebsockets fires `LWS_CALLBACK_*_WRITEABLE`. If a
function `callback` is supplied, it replaces any pending writeable
handler and is called once with `(wsi)`; its return value is used as
the callback return (return `-1` to close).

```js
await new Promise(r => wsi.wantWrite(r));   // common pattern
wsi.write(buf);
```

If `wantWrite` is called repeatedly without a callback, only the
first registers a pending request — duplicate calls are ignored
(the C code guards with `s->want_write`).

### `write(data [, len_or_protocol [, protocol]])`

`data` is a string or `ArrayBuffer`. The write protocol defaults to:

- `LWS_WRITE_HTTP` for an HTTP role wsi,
- `LWS_WRITE_TEXT` for a WebSocket if `data` is a string,
- `LWS_WRITE_BINARY` for a WebSocket if `data` is binary.

Argument forms:

| Call | Behaviour |
|------|-----------|
| `wsi.write(data)`             | Whole buffer, default protocol |
| `wsi.write(data, proto)`      | Whole buffer with explicit `LWS_WRITE_*` |
| `wsi.write(data, len, proto)` | First `len` bytes only with explicit protocol |

For WebSocket roles the binding automatically prepends the
`LWS_PRE` padding bytes — you don't need to reserve them yourself.

If the protocol is `LWS_WRITE_HTTP_FINAL` and the underlying write
succeeded, `lws_http_transaction_completed()` is called and the
socket is marked `completed` (the next return from the JS callback
forces close).

The function throws `InternalError("I/O error: partially buffered
lws_write()")` if `lws_partial_buffered()` is non-zero.

Returns the number of bytes written.

### `respond(code [, length], [, body], [, headers])`

HTTP response helper using `lws_add_http_common_headers` +
`lws_add_http_header_by_name` + `lws_finalize_write_http_header`.
Arguments are scanned positionally by type:

- The first numeric argument is the HTTP status code.
- A second numeric argument is the Content-Length (otherwise the
  binding passes `LWS_ILLEGAL_HTTP_CONTENT_LEN` so libwebsockets
  emits `Transfer-Encoding: chunked` or omits the header).
- A string or `ArrayBuffer` argument is the body — its length is
  used as content length if not yet set.
- A plain object's keys are added as headers via
  `lws_add_http_header_by_name`.

Returns the total number of bytes written (headers + optional body).

```js
wsi.respond(200, { 'content-type': 'text/html' });        // headers only
wsi.respond(404, 13, 'Not found.\r\n');                   // with body
wsi.respond(200, body, {                                  // body & headers
  'content-type': 'application/json',
});
```

### `close([code [, reason]])`

Closes the connection. `code` defaults to `1000` (normal closure).
For WebSocket roles `reason` (string or `ArrayBuffer`) is recorded
with `lws_close_reason()` before `lws_close_free_wsi()` runs.

### `httpClientRead(buf [, offset])`

Wraps `lws_http_client_read()`. Reads incoming HTTP body bytes into
the provided `ArrayBuffer`. Returns the number of bytes consumed, or
`undefined` on error (-1).

Pattern (see `fetch.js`):

```js
onReceiveClientHttp(wsi) {
  const ab = new ArrayBuffer(0xff0 * 16);
  if(wsi.httpClientRead(ab))
    this.onReceiveClientHttpRead(wsi, ab);
}
```

### `addHeader(name | tokenIndex, value, buf, [len_array])`

Adds an outgoing HTTP header into a working `ArrayBuffer`. The
fourth argument is an array `[n]` whose `[0]` element tracks the
current write offset; the binding updates it in place. Used from
`onClientAppendHandshakeHeader` / `onAddHeaders`:

```js
onAddHeaders(wsi, buf, len) {
  wsi.addHeader('test', 'blah', buf, len);    // len is [0] → updated
}
```

If `name` is a number it is treated as a `WSI_TOKEN_*` constant and
`lws_add_http_header_by_token` is used; otherwise the value is
inserted by literal name.

### `clientHttpMultipart(name, filename, contentType, buf [, len_array])`

Wraps `lws_client_http_multipart()`. Writes the multipart boundary
and part header into `buf` starting at `len_array[0]` and updates
`len_array[0]` in place. Pass `null` for `name`/`filename`/
`contentType` to emit the trailing closing boundary.

Throws `RangeError` when the buffer is too small.

## Instance accessors

| Property | Returns |
|----------|---------|
| `id`           | Numeric per-process id assigned by qjs-lws |
| `tag`          | Libwebsockets debug tag (`lws_wsi_tag()`) |
| `vhost`        | `LWSVhost` for this connection |
| `context`      | `LWSContext` for this connection |
| `headers`      | Object of received HTTP headers (lowercased keys), populated lazily after `HTTP` / `CLIENT_FILTER_PRE_ESTABLISH` |
| `tls`          | Boolean — whether the connection is over SSL |
| `peer`         | `LWSSockAddr46` of `getpeername()` or `null` |
| `local`        | `LWSSockAddr46` of `getsockname()` or `null` |
| `fd`           | Underlying OS file descriptor |
| `parent`       | Parent wsi (mux / proxied) — `LWSSocket` or `undefined` |
| `child`        | Child wsi |
| `network`      | Underlying network wsi (`lws_get_network_wsi`) |
| `peerWriteAllowance` | `lws_get_peer_write_allowance()` |
| `protocol`     | Protocol name the wsi is bound to |
| `method`       | HTTP method as string (`'GET'`, `'POST'`, …) once known |
| `uri`          | Request URI string once known |
| `client`       | Boolean — `true` for outbound (client) connections |
| `response`     | HTTP response code (set in `onEstablishedClientHttp`) |
| `extensions`   | Array of extension names registered on the context |
| `h2`           | Boolean — `lws_wsi_is_h2()` |
| `redirectedToGet` | `true` if a client redirect downgraded POST to GET |
| `bodyPending`  | Get/set; setter calls `lws_client_http_body_pending(n)` — used to drive client POST body writes |
| `pipelineLeader` | The wsi this one is queued behind (`lws_get_txn_queue_leader()`), or `undefined` if not queued |
| `isPipelineLeader` | Boolean — `lws_wsi_is_txn_queue_leader()`, whether other client wsi may be queued behind this one |
| `pipelineQueueDepth` | Number of client wsi currently queued behind this one (`lws_get_txn_queue_depth()`) |

The toStringTag is `LWSSocket`.

### Pipelining / keep-alive introspection

When a client connection is made with `LCCSCF_PIPELINE` set in
`sslConnection`, libwebsockets transparently queues (h1) or muxes
(h2) additional connections to the same endpoint onto an existing
one instead of opening a new network connection — see
[http-client.md](http-client.md#connection-pipelining--keep-alive).
`pipelineLeader`, `isPipelineLeader` and `pipelineQueueDepth` expose
that state, which libwebsockets otherwise keeps private to `struct
lws`:

```js
const a = ctx.clientConnect(url, { sslConnection: LCCSCF_PIPELINE });
const b = ctx.clientConnect(url, { sslConnection: LCCSCF_PIPELINE });

console.log(b.pipelineLeader === a);   // true once b queued behind a
console.log(a.isPipelineLeader);       // true
console.log(a.pipelineQueueDepth);     // 1
```

## Lifetime / per-session data

When a protocol's `per_session_data_size` is left unspecified, qjs-lws
sets it to `sizeof(JSValue)` and uses the slot to hold a per-wsi JS
object that becomes `this` inside the protocol callbacks. The
binding allocates that object on the appropriate `*_BIND_PROTOCOL` /
`WSI_CREATE` reason and frees it on `WSI_DESTROY` (see
`callback_js` in `lws-context.c`). You can attach connection-local
state to `this` from any callback:

```js
{
  name: 'http',
  onHttpBindProtocol(wsi) { this.start = Date.now(); },
  onHttpDropProtocol(wsi) { console.log('took', Date.now() - this.start); },
}
```
