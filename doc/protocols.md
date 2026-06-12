# Protocol handler objects

A *protocol* is the object you list in the `protocols` array passed
to `LWSContext` or `LWSVhost`. It is the JS analogue of `struct
lws_protocols`. Mounts and inbound connections are dispatched to a
protocol by **name**; client connections pick one via
`localProtocolName`.

## Shape

```js
{
  name: 'my-protocol',
  rx_buffer_size: 4096,        // optional
  id: 0,                        // optional
  tx_packet_size: 0,            // optional

  // Either a fall-back callback…
  callback(wsi, reason, ...args) { … },

  // …or named handlers (preferred). Mix freely.
  onEstablished(wsi) { … },
  onReceive(wsi, data, len, frame) { … },
  onClosed(wsi) { … },
}
```

The descriptor can also be supplied as an array (`[name, callback,
rx_buffer_size, id, tx_packet_size]`).

### Per-session storage

`per_session_data_size` is fixed by the binding to `sizeof(JSValue)`.
The hidden slot holds a per-connection JS object that is bound as
`this` inside every callback. You can attach arbitrary properties to
it without using `WeakMap`s.

### Lookup of named callbacks

`lwsjs_get_lws_callbacks` walks every entry in
`lws_callback_names[]` (see `lws.c`) and for each `LWS_CALLBACK_*`
that has a name, looks up the corresponding JS property
`onCamelCaseName` on the protocol descriptor. If present, that
function is invoked instead of the generic `callback`. The naming
rule is:

```
LWS_CALLBACK_HTTP_BIND_PROTOCOL  ->  onHttpBindProtocol
LWS_CALLBACK_WS_PEER_INITIATED_CLOSE -> onWsPeerInitiatedClose
LWS_CALLBACK_RECEIVE_CLIENT_HTTP -> onReceiveClientHttp
```

(first letter capitalised, underscores stripped and next letter
capitalised.) The same mapping is exposed at runtime through
`getCallbackName(n)` and `getCallbackNumber(name)`.

## Callback contract

Every callback receives `(wsi, …)`. When you provide a named
handler, the *reason* is implicit (the handler name encodes it);
when you provide the generic `callback`, you also receive the
integer reason as the second argument.

```js
callback(wsi, reason, ...args) { /* args == named-handler tail */ }
onClientReceive(wsi, data, size, frame) { … }
```

Return value:
- `undefined`/`0` → continue normally.
- non-zero → libwebsockets will close the connection. The binding
  invokes `lws_wsi_close()` with `LWS_TO_KILL_ASYNC` and also clears
  the registered io handler.
- Throwing an exception is *not* fatal: the binding prints it via
  `js_error_print()` and continues with return `0`.

## Argument tail per reason

See [callbacks.md](callbacks.md) for the full table of arguments
passed to each `LWS_CALLBACK_*` reason. A short summary:

| Reason | Tail args |
|--------|-----------|
| `RECEIVE` / `CLIENT_RECEIVE` | `(data, len, frame?)` — `data` is a string for text frames, `ArrayBuffer` for binary; `frame` is `{ multifragment, first, final }` only for multi-fragment messages |
| `WS_PEER_INITIATED_CLOSE` | `(code, reasonString)` |
| `CLIENT_HTTP_REDIRECT` | `(url, status)` |
| `ESTABLISHED_CLIENT_HTTP` | `(responseCode)` |
| `ADD_HEADERS` / `CHECK_ACCESS_RIGHTS` / `PROCESS_HTML` | `(buf, lenArray)` — write into `buf`, update `lenArray[0]` |
| `CLIENT_APPEND_HANDSHAKE_HEADER` | `(buf, lenArray)` — write headers with `wsi.addHeader(...)` |
| `RAW_RX` / `MQTT_CLIENT_RX` | `(data, len)` |
| `CLIENT_CONNECTION_ERROR` | `(message, errno)` |
| `CONNECTING` | `(int32 hintOrFd)` |
| `OPENSSL_PERFORM_SERVER_CERT_VERIFICATION` | `(int64 sslPtr, preverifyOk)` |
| `RAW_CLOSE` | `(errno)` |
| `HTTP_CONFIRM_UPGRADE` | `(typeString)` |
| `FILTER_HTTP_CONNECTION` | `(urlString)` |
| `HTTP` | `(uriString)` |

For any other reason, if libwebsockets supplies `in`/`len`, the
binding passes them as `(data, len)` — text frames are decoded to
JS strings, binary frames are passed as `ArrayBuffer`.

## Default mode pollfd handling

The binding intercepts:

- `LWS_CALLBACK_ADD_POLL_FD`
- `LWS_CALLBACK_DEL_POLL_FD`
- `LWS_CALLBACK_CHANGE_MODE_POLL_FD`
- `LWS_CALLBACK_LOCK_POLL` / `UNLOCK_POLL` (no-ops)

These reasons are **never delivered to user JS** — they drive the
integration with `os.setReadHandler`/`os.setWriteHandler`. See
[event-loop.md](event-loop.md).

## Reasons handled implicitly

Several reasons are massaged before reaching JS:

- `WSI_CREATE` / `*_BIND_PROTOCOL` allocate the per-session object.
- `WSI_DESTROY` releases per-session state and the JS `LWSSocket`.
- `CLIENT_FILTER_PRE_ESTABLISH` / `ESTABLISHED_CLIENT_HTTP` /
  `FILTER_HTTP_CONNECTION` / `HTTP` populate `wsi.headers`,
  `wsi.uri`, `wsi.method`.
- `HTTP_CONFIRM_UPGRADE` sets the socket type to WS if the
  upgrade target is `"websocket"`.
- A `CLIENT_RECEIVE` for an inbound close frame (opcode 8) is
  rewritten to `WS_PEER_INITIATED_CLOSE` so you don't have to
  parse the close frame yourself.

## Plugin-style protocols

`lws-context.c` allocates extra slots in the protocol table for the
built-in libwebsockets plugins (`PLUGIN_PROTOCOL_DEADDROP`,
`MIRROR`, `DUMB_INCREMENT`, etc.). They are currently
**commented out** in the source — only the `http-only` dummy is
prepended automatically. To use a plugin you would re-enable the
matching `#ifdef PLUGIN_PROTOCOL_*` block at build time.
