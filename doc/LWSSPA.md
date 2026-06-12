# `LWSSPA`

Server-side multipart and `application/x-www-form-urlencoded` parser.
Implemented in `lws-spa.c`, wrapping `lws_spa_create_via_info()`.

## Construction

```js
const spa = new LWSSPA(wsi, options);
```

`wsi` must be an `LWSSocket`. `options` is an object that is also
used as `this` for the parser's callbacks. Recognised keys:

| Key | Default | Description |
|-----|---------|-------------|
| `countParams` / `count_params` | `1024` | Number of URL-encoded form parameters allocated |
| `maxStorage` / `max_storage`  | `512`  | Bytes of in-memory parameter storage |
| `acChunkSize` / `ac_chunk_size` | `0`  | Chunk size for streaming uploads (0 = default) |
| `onOpen(name, filename)`        | optional | A new field starts |
| `onContent(name, filename, buf)`| optional | A chunk of data is available |
| `onFinalContent(name, filename, buf)` | falls back to `onContent` | Final chunk for a field |
| `onClose(name, filename)`       | optional | A field finished |

The callbacks return either `undefined` (treated as `0`) or an
integer; non-zero / exception propagates back as the lws spa
callback return (negative aborts the upload).

## Instance methods

| Method | Description |
|--------|-------------|
| `process(buf [, offset [, length]])` | Feed received body bytes (`ArrayBuffer`). Returns the lws_spa result. |
| `finalize()`                          | `lws_spa_finalize()` — call when the HTTP body is complete. |

## Reading parameter values

`LWSSPA` exposes parsed values via the property accessor exotic
method. Use a numeric (parameter index) property to retrieve a
parsed string:

```js
const value = spa[0];   // string for parameter 0, or undefined
```

Internally this calls `lws_spa_get_string()` plus
`lws_spa_get_length()`.

## Typical usage in an HTTP handler

```js
import { LWSSPA } from 'lws';

const spaByWsi = new WeakMap();

{
  name: 'http',
  onFilterHttpConnection(wsi, url) {
    if(/multipart/.test(wsi.headers['content-type']))
      spaByWsi.set(wsi, new LWSSPA(wsi, {
        maxStorage: 1 << 17,
        onContent(name, filename, buf) {
          console.log('chunk', name, buf?.byteLength);
        },
        onClose(name, filename) {
          console.log('done', name);
        },
      }));
  },
  onHttpBody(wsi, buf, len) {
    spaByWsi.get(wsi)?.process(buf, 0, buf.byteLength);
  },
  onHttpBodyCompletion(wsi) {
    spaByWsi.get(wsi)?.finalize();
    wsi.wantWrite(() => {
      wsi.respond(200, { 'content-type': 'text/plain' });
      wsi.write('uploaded\n', LWS_WRITE_HTTP_FINAL);
      return -1;
    });
  },
}
```
