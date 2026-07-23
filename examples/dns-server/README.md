# Recursive caching DNS resolver

A small recursive DNS resolver built on qjs-lws's UDP support
(`ctx.createUdp()`, `wsi.sendTo()`) plus its existing raw TCP
`clientConnect()`.

- Listens on UDP/53 (or `DNS_PORT`) for client queries.
- Resolves each query itself, starting from the IANA root hints
  (`root-hints.js`) and following NS referrals down to an authoritative
  answer - no upstream "forwarder" involved.
- Talks UDP to upstream nameservers, retrying over TCP when a reply comes
  back truncated (or the UDP leg fails outright).
- Caches RRsets by name+type, honouring TTLs.

## Files

- `server.js` - listens on UDP/53, decodes queries, calls the resolver, encodes and sends the reply.
- `resolver.js` - the referral-following resolution loop and the UDP/TCP upstream query plumbing.
- `dns-message.js` - DNS wire-format encode/decode (header, questions, A/AAAA/NS/CNAME/SOA/MX/TXT RRs).
- `cache.js` - a small TTL-respecting RRset cache.
- `root-hints.js` - the 13 IANA root server addresses.
- `bytes.js` - shared binary-buffer helpers.

## Run

Port 53 is privileged:

```sh
sudo qjs server.js
dig @127.0.0.1 example.com
```

or on an unprivileged port:

```sh
DNS_PORT=5353 qjs server.js
dig @127.0.0.1 -p 5353 example.com
```

Needs outbound UDP/TCP port 53 reachability to the public internet (root
servers, then whatever the referral chain leads to) - it will not work
behind a firewall that blocks that.

## How the UDP pieces fit together

Unlike TCP, a single UDP listener wsi receives datagrams from every peer -
there's no per-connection wsi. `onRawRx(wsi, data, peer)` gets an extra
`peer` argument (an `LWSSockAddr46`) precisely because of that: it's a
snapshot of *this* datagram's sender, safe to hold onto across the `await
resolver.resolve(...)` call even though other clients' queries may arrive
on the same listener wsi in the meantime. The reply goes back with
`wsi.sendTo(data, peer)`, which sends immediately via `sendto()` rather
than through the same queued/deferred path `wsi.write()` uses for TCP -
necessary here since a listener's implicit "current peer" changes with
every incoming datagram, but not needed (or used) for the outbound
resolver-udp sockets, which are each connected to one fixed upstream
server and use plain `wsi.write()`.
