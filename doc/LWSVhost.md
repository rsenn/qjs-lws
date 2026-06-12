# `LWSVhost`

A virtual host attached to an `LWSContext`. Implemented in
`lws-vhost.c`. Most users do not need this — the default vhost is
created from the context's `vhostName` property. Use `LWSVhost`
when you need additional listeners, separate TLS certificates per
hostname, or to attach a vhost to a different protocol set.

## Construction

```js
const vh = new LWSVhost(ctx, info);
```

`ctx` is an `LWSContext`. `info` is the same shape as `LWSContext`'s
constructor info — every supported property (port, mounts,
protocols, TLS, etc.) is forwarded to `lws_create_vhost()`.

Throws `TypeError` if the first argument is not an `LWSContext`.

The constructor stashes the original info object on the resulting
vhost as a configurable `info` property, mirroring `LWSContext`.

## Instance methods

| Method | Description |
|--------|-------------|
| `adoptSocket(fd)`           | `lws_adopt_socket_vhost()`; returns `LWSSocket`. |
| `adoptSocketReadbuf(fd, buf)` | `lws_adopt_socket_vhost_readbuf()` with pre-buffered bytes. |
| `nameToProtocol(name)`      | `lws_vhost_name_to_protocol()` — returns the protocol descriptor object, or `null`. |

## Instance accessors

| Property | Source |
|----------|--------|
| `tag`        | `lws_vh_tag()` |
| `name`       | `lws_get_vhost_name()` |
| `port`       | `lws_get_vhost_port()` |
| `listenPort` | `lws_get_vhost_listen_port()` |
| `iface`      | `lws_get_vhost_iface()` |

The toStringTag is `LWSVhost`.

## Lifecycle

The finaliser calls `lws_vhost_destroy()` and frees the stashed
`context_creation_info`. As with `LWSContext`, callbacks may fire
during construction because `lws_create_vhost()` is called last.

## Looking up vhosts

From the context:

```js
const vh = ctx.getVhostByName('admin.example.com');
```

From a `LWSSocket`:

```js
function onEstablished(wsi) {
  console.log('vhost', wsi.vhost.name);
}
```
