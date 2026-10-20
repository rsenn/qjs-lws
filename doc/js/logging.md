# Log formatting (`lib/lws/log.js`)

Formats the text lws.so emits through the `logLevel()` callback
(`[wsisrv|1|localhost|adopted|127.0.0.1]: RAW_RX: RX 99 bytes: ...`) as
structured entries, rendered in one of three formats.

`lib/lws/context.js` installs it as the default log callback, so setting
environment variables is usually all that is needed:

| Variable | Effect |
|----------|--------|
| `DEBUG=1` | enables `LLL_USER` logging (lifecycle events and RX/TX traffic) |
| `LOGFMT=human\|curl\|ndjson` | terminal format, default `human` |
| `TRAFFIC=<file>` | RX/TX lines are appended raw to the file instead of the terminal |

## Formats

**`human`** — one header line per entry, payload indented below it. A payload
may span many lines; length-prefixed debugger frames are split and JSON is
pretty-printed. Colour is used only when stdout is a tty.

```
20:40:05.574 wsisrv#1 127.0.0.1 RX 99 bytes RAW_RX
    {
      "type": "event"
    }
```

**`curl`** — imitates `curl --verbose`: `* ` info lines, `> ` request and `< `
response header lines, `{ [n bytes data]` / `} [n bytes data]` for received
and sent bodies.

```
* Connection #1 from 127.0.0.1
> GET /x HTTP/1.1
> Host: a
>
< HTTP/1.1 200 OK
< A: b
<
} [HTTP 40 bytes data]
hello
```

**`ndjson`** — one JSON object per line, never colourised, full payload,
readable back with `parseNDJSON()`:

```json
{"time":"2026-10-20T20:40:05.574Z","level":"USER","wsi":{"kind":"wsisrv","id":1,"vhost":"localhost","state":"adopted","peer":"127.0.0.1"},"event":"RAW_RX","dir":"rx","bytes":99,"data":"0000005a\n{...}"}
```

## API

```js
import { logLevel, LLL_USER, LLL_ERR } from 'lws.so';
import { createLogger } from './lib/lws/log.js';

logLevel(LLL_USER | LLL_ERR, createLogger({ format: 'curl', out: file }));
```

`createLogger(opts)` returns a `(level, msg)` callback.

| Option | Default | |
|--------|---------|---|
| `format` | `'human'` | `'ndjson'`, `'human'` or `'curl'` |
| `out` | stdout | file object with `puts()`, or `(text) => void` |
| `color` | tty only | never applies to `ndjson` |
| `maxData` | `4096` | payload chars shown by `human`/`curl`, `0` = unlimited |
| `filter` | – | `(entry) => boolean`; return false to drop an entry |

Other exports: `parseEntry(level, msg)`, `unescapeData(str)`,
`parseNDJSON(text)`, `formatNDJSON/formatHuman/formatCurl(entry, opts)` and the
`formats` table.

An entry has `time`, `level`, optional `wsi` (`kind`, `id`, and `vhost`/`state`/`peer`,
`port`, or `target` depending on the kind), `event`, and for traffic `dir`
(`'rx'`/`'tx'`), `bytes`, `proto`, `data` (unescaped).
