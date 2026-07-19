# proxy

A forward proxy example, modeled after [Polipo](https://github.com/jech/polipo).
Listens for HTTP/1.1 (`CONNECT` and every other method - plain **or TLS**,
on the same port) and SOCKS4/4a/5 clients; connects onward directly, through
an upstream SOCKS4/5 proxy (the classic "HTTP → SOCKS bridge", e.g. bridging
to Tor), or through an upstream HTTP(S) proxy's own `CONNECT`.

See `PLAN.md` for the full design rationale and the primitives it's built on.

## Run

```sh
qjs server.js
qjs server.js --proxy-port 8123 --socks-port 1080
qjs server.js --onward-mode socks5 --onward-host 127.0.0.1 --onward-port 9050
qjs server.js --config /etc/polipo/config
qjs server.js --tls-cert cert.pem --tls-key key.pem
```

```
  -h, --help          show this help
  -c, --config PATH   config file (default: ./proxy.conf, silently skipped if missing)
      --proxy-port N  HTTP proxy listen port (default 8123, 0 disables it) - accepts
                      plain AND TLS connections on this same port
      --socks-port N  SOCKS4/5 listen port (default 1080, 0 disables it)
      --tls-cert PATH server cert for --proxy-port's TLS side (PEM, file path)
      --tls-key PATH  matching private key (PEM, file path)
      --tls-dir DIR   when --tls-cert/--tls-key aren't given, a self-signed cert is
                      generated and persisted here (default ./tls) so repeat runs
                      reuse the same identity
      --onward-mode   direct | socks5 | socks4 | http-connect (default direct)
      --onward-host   upstream host, required for every onward mode except direct
      --onward-port   upstream port, required for every onward mode except direct
      --dns-servers   comma-separated IPs to resolve onward hostnames with, instead
                      of the system default (/etc/resolv.conf)
  -v, --verbose       log each proxied connection (repeatable)
```

## Config file

Polipo-style `key = value`, one per line; `#` starts a comment; CLI flags
override the file. Example:

```
# /etc/polipo/config-style forward proxy config
proxyPort   = 8123
socksPort   = 1080
onwardMode  = socks5
onwardHost  = 127.0.0.1
onwardPort  = 9050
dnsServers  = 8.8.8.8, 1.1.1.1
verbose     = 1
```

Onward hostname resolution (the actual destination, and any onward SOCKS4/5
or http-connect upstream given as a hostname rather than an IP) goes through
libwebsockets' own async DNS resolver, sourced from `/etc/resolv.conf` by
default. `dnsServers`/`--dns-servers` overrides that with a specific list
instead - handy for a proxy that shouldn't leak DNS queries to whatever the
host's default resolver happens to be, or that needs a resolver that can
actually reach the onward destinations (e.g. a split-horizon internal DNS).

## Limitations (deliberate, to keep the example focused)

- **HTTP/2 is tunneled-only, not a listener protocol.** libwebsockets has no
  generic CONNECT-tunnel support for h2 (only a narrow WebSocket-over-h2
  upgrade, unrelated to general proxying - see `PLAN.md`). A CONNECT tunnel
  is always negotiated over HTTP/1.1, exactly how real browsers already talk
  to forward proxies; whatever the client and origin negotiate **inside**
  that tunnel (including h2 over TLS) is fully transparent relayed bytes, so
  HTTPS+h2 destinations work fine once tunneled.
- **Plain (non-CONNECT) forwarding is a dumb byte relay per connection.**
  The destination is resolved once, from the *first* request on an accepted
  connection. If a client pipelines further requests to a *different* origin
  over that same connection, they're still forwarded to the first
  destination - this isn't a full HTTP proxy that re-parses every request.
- **SOCKS5 listener has no authentication** - it always offers/accepts "no
  auth required" and doesn't implement RFC 1929 username/password
  sub-negotiation. Fine for a loopback/LAN proxy, not for exposing on an
  untrusted network.
- **Only `CONNECT` is implemented for SOCKS4/5** - `BIND` and `UDP ASSOCIATE`
  reply "command not supported".
- **Onward SOCKS5 has no authentication either** - the hand-rolled onward
  SOCKS5 client (see `onward.js`) always offers/uses "no auth", the same as
  the listener. Fine for a typical local SOCKS5 server (e.g. Tor's), not for
  one that requires RFC 1929 username/password credentials.
- **`--proxy-port`'s TLS side has no client certificate verification** -
  it's TLS for confidentiality on the wire between client and proxy, not
  mutual auth. With no `--tls-cert`/`--tls-key` given, the auto-generated
  cert is self-signed, so a real client needs `--proxy-insecure` (curl) or
  equivalent, or to be given the generated `tls/cert.pem` to trust.

## Testing it by hand

```sh
# plain HTTP forwarding
curl -x http://localhost:8123 http://example.com/

# HTTPS via CONNECT (also exercises h2-over-TLS transparently)
curl -x http://localhost:8123 https://example.com/ --http2

# TLS from client to the proxy itself (self-signed by default - --proxy-insecure
# skips verification; plain-HTTP clients keep working on the very same port)
curl --proxy-insecure -x https://localhost:8123 http://example.com/

# SOCKS5 listener
curl --socks5 localhost:1080 https://example.com/

# onward SOCKS5 bridging, self-contained (no external SOCKS server needed):
# terminal 1 - a plain SOCKS5 listener
qjs server.js --proxy-port 0 --socks-port 1080
# terminal 2 - an HTTP proxy that bridges everything onward through it
qjs server.js --proxy-port 8123 --socks-port 0 --onward-mode socks5 --onward-host 127.0.0.1 --onward-port 1080
curl -x http://localhost:8123 https://example.com/
```
