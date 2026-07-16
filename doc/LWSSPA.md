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
| `paramNames` / `param_names` | none | Array/iterable of expected field names, e.g. `['username', 'email']` - see below |
| `countParams` / `count_params` | `paramNames.length` if given, else `1024` | Number of URL-encoded form parameters allocated |
| `maxStorage` / `max_storage`  | `512`  | Bytes of in-memory parameter storage |
| `acChunkSize` / `ac_chunk_size` | `0`  | Chunk size for streaming uploads (0 = default) |
| `onOpen(name, filename)`        | optional | A new field starts |
| `onContent(name, filename, buf)`| optional | A chunk of data is available |
| `onFinalContent(name, filename, buf)` | falls back to `onContent` | Final chunk for a field |
| `onClose(name, filename)`       | optional | A field finished |

`onOpen`/`onContent`/`onClose` fire regardless of `paramNames` (that's
how `lib/lws/multipart.js`'s `MultipartParser` streams file uploads
without ever declaring field names up front). `paramNames` only
controls *indexed/named value retrieval* (`spa[n]`/`spa.name`, see
below) - without it, lws falls back to "arbitrary POST items" mode:
it discovers field names as they arrive and assigns them storage
slots itself, in first-seen order, so `spa[0]`/`spa.length`/
`spa.paramNames` still work, just without you having declared the
names up front.

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
method - a numeric (parameter index) property, or the field's own
name, both return the same parsed string:

```js
const spa = new LWSSPA(wsi, { paramNames: ['username', 'email'] });
// ...process()/finalize() the body...

spa[0];           // 'username's value, string or undefined
spa.username;     // same value, looked up by name instead of index
spa.paramNames;   // ['username', 'email'] - the known field names, in slot order
spa.length;       // 2 here - see below
```

Internally the index/name forms both call `lws_spa_get_string()` plus
`lws_spa_get_length()`. `.paramNames` and `.length` are real getters
(not part of the exotic string-key lookup, so they can't be shadowed
by a field literally named `length`/`paramNames`): `.paramNames`
returns the *known* field names - declared via `paramNames` up front,
and/or discovered dynamically in "arbitrary POST items" mode (see
above) - and `.length` is that array's length, i.e. how many name
slots are actually populated so far, **not** `countParams` (the
allocated capacity). Any other property access - a name that doesn't
match a known field, or anything not covered above - resolves through
the normal prototype chain instead (methods, `Symbol.toStringTag`,
...), so `spa.process`/`spa.finalize` etc. keep working unaffected
either way.

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
