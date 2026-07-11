# Module exports — `import … from 'lws'`

All exports live on the C module `lws` (built as `lws.so`). The module
exports four classes and a large set of helper functions and integer
constants.

## Classes

| Name | Purpose | Doc |
|------|---------|-----|
| `LWSContext`     | libwebsockets context: owns vhosts, mounts, protocols | [LWSContext.md](LWSContext.md) |
| `LWSVhost`       | Additional virtual host attached to an `LWSContext`   | [LWSVhost.md](LWSVhost.md) |
| `LWSSocket`      | Per-connection `wsi` (websocket instance)             | [LWSSocket.md](LWSSocket.md) |
| `LWSSPA`         | Multipart POST / urlencoded form parser               | [LWSSPA.md](LWSSPA.md) |
| `LWSSockAddr46`  | Tagged `sockaddr_in` / `sockaddr_in6` ArrayBuffer     | [LWSSockAddr46.md](LWSSockAddr46.md) |

## Top-level functions

Defined in `lws.c` (`lws_funcs[]`) unless noted otherwise:

### Context construction

```js
createServer(info)   // === new LWSContext(info)
```

Defined in `lws-context.c` (`lwsjs_create_server`) — a thin alias
(`JS_CallConstructor` on `LWSContext`) meant for call sites where
`info.port` is set, so the code reads as creating a server rather
than a bare context. Functionally identical to `new LWSContext(info)`;
see [LWSContext.md](LWSContext.md#construction).

### Callback name / number conversion

```js
getCallbackName(reason)    // → string ("Established", "ClientReceive", …)
getCallbackNumber(name)    // → integer  (camelCase → enum)
```

`getCallbackName` returns the PascalCased symbol (`CLIENT_RECEIVE` →
`ClientReceive`). `getCallbackNumber` accepts the same form (or
camelCase) and decamelizes it back to the underscore-separated
name before looking it up.

### HTTP token name

```js
getTokenName(WSI_TOKEN_HOST)     // → "Host"
```

Returns the literal HTTP header name for a `WSI_TOKEN_*` index (the
trailing `": "` is stripped).

### Log levels

```js
getLogLevelName(LLL_USER)        // → "USER"
getLogLevelColour(LLL_USER)      // → ANSI escape
visible(LLL_INFO)                // → boolean (level currently visible)
log([level], [wsiOrCtx], msg | ArrayBuffer)
logLevel(mask, [callback(level, line)])
```

`logLevel` with one numeric arg sets the active mask
(`lws_set_log_level`). With a second function argument it installs a
JS log callback; the function is called for every libwebsockets log
line with `(level, msg)`. Without the callback, libwebsockets writes
ANSI-colourised log lines to `stderr`.

`log()` writes a user-level log message. If passed an `LWSSocket`,
the line is prefixed with the wsi tag; if passed an `LWSContext`
the message is associated with that context. With an ArrayBuffer
argument the buffer is hex-dumped.

### URI / connection info

```js
parseUri(uri)              // parses into struct lws_client_connect_info (internal)
```

### Buffer / string helpers

```js
toString(arraybuffer [, offset [, length]])     // → JS string
toArrayBuffer(stringOrBuf [, offset [, length]]) // → ArrayBuffer
toPointer(arraybuffer)                          // → "0x…" string of the buffer's address
write(srcStringOrBuf, dstArrayBuffer [, offset]) // memcpy-into-buffer helper
                                                 // returns bytes written;
                                                 // if `offset` is an array [n],
                                                 // n is incremented by bytes written
```

### Address / interface helpers

```js
parseMac(str [, dstArrayBuffer])      // → ArrayBuffer(6) or int (chars consumed)
parseNumericAddress(str [, dstArrayBuffer])
                                       // → ArrayBuffer(4 | 16) or int
writeNumericAddress(buf [, len])      // → "1.2.3.4" or "[::1]"
interfaceToSa(ipv6, name [, dstBuf])  // → ArrayBuffer with sockaddr or int
```

`parseMac` parses `"aa:bb:cc:dd:ee:ff"`. `parseNumericAddress` parses
both IPv4 and IPv6 — the result length tells you which.
`interfaceToSa` resolves a system interface (e.g. `"eth0"`) into a
sockaddr.

## Constants

All `LWS_*`, `LCCSCF_*`, `LWSMPRO_*`, `WSI_TOKEN_*`, `LWSHUMETH_*`,
and `LLL_*` macros from `libwebsockets.h` are exported as integer
constants. See [constants.md](constants.md) for the catalogue.
