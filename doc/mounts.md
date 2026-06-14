# HTTP mounts

A mount maps a URL prefix on a vhost to a backend: a directory of
static files, a JS protocol callback, a redirect, or a CGI script.
Mounts are passed via the `mounts` property of `LWSContext`'s or
`LWSVhost`'s info object. Implemented in `lws-context.c`
(`http_mount_from`, `http_mounts_from`).

## Shape

`mounts` can be one of:

```js
// Array of mount objects.
mounts: [
  { mountpoint: '/static', origin: './public', def: 'index.html', originProtocol: LWSMPRO_FILE },
  { mountpoint: '/api',    protocol: 'http',                       originProtocol: LWSMPRO_CALLBACK },
]

// An object keyed by mountpoint.
mounts: {
  '/static': { origin: './public', def: 'index.html', originProtocol: LWSMPRO_FILE },
  '/api':    { protocol: 'http', originProtocol: LWSMPRO_CALLBACK },
}

// Short tuple form.
mounts: [
  ['/static', './public', 'index.html', 'http', null /* basic_auth_login_file */],
]
```

## Mount object properties

| Property | C field | Notes |
|----------|---------|-------|
| `mountpoint`           | `mountpoint`           | URL prefix to match (e.g. `'/'`, `'/ws'`) |
| `origin`               | `origin`               | Filesystem path, hostname, or URL depending on `originProtocol` |
| `def`                  | `def`                  | Default file when the URL ends with `/` |
| `protocol`             | `protocol`             | Protocol name to bind for `LWSMPRO_CALLBACK` / `LWSMPRO_NO_MOUNT` |
| `cgienv`               | `cgienv`               | Array/object of `{name, value}` for CGI environment |
| `extraMimetypes` / `extra_mimetypes` | `extra_mimetypes` | Extra extension→mimetype map (see below) |
| `interpret`            | `interpret`            | Extension→CGI interpreter map |
| `cgiTimeout` / `cgi_timeout` | `cgi_timeout`    | CGI timeout seconds |
| `cacheMaxAge` / `cache_max_age` | `cache_max_age` | Cache-Control max-age |
| `authMask` / `auth_mask` | `auth_mask`          | Auth bitmask |
| `cacheReusable` / `cache_reusable` | `cache_reusable` | bool |
| `cacheRevalidate` / `cache_revalidate` | `cache_revalidate` | bool |
| `cacheIntermediaries` / `cache_intermediaries` | `cache_intermediaries` | bool |
| `originProtocol` / `origin_protocol` | `origin_protocol` | One of `LWSMPRO_*` |
| `basicAuthLoginFile` / `basic_auth_login_file` | `basic_auth_login_file` | htpasswd-style file |

`origin_protocol` values:

| Constant | Meaning |
|----------|---------|
| `LWSMPRO_HTTP`        | Proxy to another HTTP host (origin = `host[/path]`) |
| `LWSMPRO_HTTPS`       | Same, over TLS |
| `LWSMPRO_FILE`        | Serve files from a local directory (`origin` = path) |
| `LWSMPRO_CGI`         | Run as CGI |
| `LWSMPRO_REDIR_HTTP`  | 301/302 redirect to an http URL |
| `LWSMPRO_REDIR_HTTPS` | Same, https |
| `LWSMPRO_CALLBACK`    | Dispatch to a protocol's HTTP callbacks |
| `LWSMPRO_NO_MOUNT`    | Reserve the prefix without serving (e.g. websocket-only) |

## Vhost-options chains

`cgienv`, `extraMimetypes`, `interpret`, `headers`, `pvo`, and
`rejectServiceKeywords` are all `struct lws_protocol_vhost_options`
chains. Inputs accepted (see `vhost_options_from` / `vhost_option_from`):

- An array of `{ name, value, options?, next? }` objects.
- A single object — used as the head of the chain.
- A tuple `[name, value, options]`.

The `name`/`value` strings are duplicated into a private chain and
freed on context destroy.

Example `extraMimetypes`:

```js
mounts: [{
  mountpoint: '/',
  origin: '.',
  def: 'README.md',
  originProtocol: LWSMPRO_FILE,
  extraMimetypes: [
    { name: '.md',  value: 'text/markdown' },
    { name: '.wasm', value: 'application/wasm' },
  ],
}],
```

(`lib/lws/mimetypes.js` exports a ready-made table.)

## Common mount patterns

### Static files

```js
{ mountpoint: '/', origin: './public', def: 'index.html', originProtocol: LWSMPRO_FILE }
```

### Reverse proxy

```js
{ mountpoint: '/warmcat', origin: 'warmcat.com/', def: 'index.html', originProtocol: LWSMPRO_HTTP }
```

### Dispatch to a JS protocol

```js
{ mountpoint: '/api', protocol: 'http', originProtocol: LWSMPRO_CALLBACK }
```

Inside protocol `'http'`, `onHttp(wsi, uri)` is invoked for any URL
beginning with `/api`.

### WebSocket endpoint (no HTTP serving)

```js
{ mountpoint: '/ws', protocol: 'ws', originProtocol: LWSMPRO_NO_MOUNT }
```

Combine with a protocol `'ws'` that implements `onEstablished`,
`onReceive`, etc.

### Redirect

```js
{ mountpoint: '/old', origin: 'newsite.example/x', originProtocol: LWSMPRO_REDIR_HTTPS }
```
