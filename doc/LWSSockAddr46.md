# `LWSSockAddr46`

A tagged `ArrayBuffer` of size `sizeof(union { sockaddr_in;
sockaddr_in6; })` that carries either an IPv4 or IPv6 address.
Implemented in `lws-sockaddr46.c`.

The class itself **inherits from `ArrayBuffer`** — every instance is
also a regular `ArrayBuffer`, so it can be passed wherever an
`ArrayBuffer` is accepted.

## Construction

```js
new LWSSockAddr46();                       // empty
new LWSSockAddr46(family);                 // family only
new LWSSockAddr46('127.0.0.1');           // parsed numeric address
new LWSSockAddr46('::1', 80);             // address + port
new LWSSockAddr46(family, addressBuf);     // raw bytes (4 = IPv4, 16 = IPv6)
new LWSSockAddr46(family, addressBuf, port);
new LWSSockAddr46(sockaddrBuf);            // copy of an existing sockaddr_in/6
```

Arguments are parsed positionally:

1. If the first argument is a number, it is `sa_family` (`AF_INET`
   / `AF_INET6`).
2. If the next argument is a 4 or 16-byte `ArrayBuffer`, it's
   copied into `sin_addr` or `sin6_addr` respectively.
3. If the argument is a string, `lws_sa46_parse_numeric_address()`
   parses both IPv4 and IPv6 literals.
4. A final numeric argument is the port (stored in network byte
   order).

## Instance accessors

| Property | Description |
|----------|-------------|
| `family`  | `AF_INET` (2) or `AF_INET6` (10), read-only |
| `port`    | host-order port; writable |
| `address` | Raw `ArrayBuffer` of address bytes (4 or 16); writable (assigning a 4-byte buf sets `family = AF_INET`, a 16-byte buf sets `AF_INET6`) |
| `host`    | Numeric-address string; writable |

## Instance methods

| Method | Wraps |
|--------|-------|
| `toString()`        | `[ipv6]:port` or `ipv4:port` formatted string |
| `compare(other)`    | `lws_sa46_compare_ads()` — `0` if equal |
| `onNet(other, mask)`| `lws_sa46_on_net()` — true if `other` is on the same network for `mask` bits |

## Where it appears

- `LWSSocket.peer` and `LWSSocket.local` return `LWSSockAddr46`.
- `LWSContext.asyncDnsServerAdd(addr)` / `asyncDnsServerRemove(addr)`
  take any value convertible via the constructor.
- `wsi.peer.host`, `wsi.peer.port`, `wsi.local.host`,
  `wsi.local.port` are how `tcpsocket.js` / `tcpsocketstream.js` expose
  remote/local endpoints to user code.
