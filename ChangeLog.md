# Changelog

Format loosely follows [Keep a Changelog](https://keepachangelog.com/);
this project doesn't cut versioned releases yet, so entries accumulate
under `Unreleased` until that changes.

## Unreleased

### Added

- `LWSSocket` gained `pipelineLeader`, `isPipelineLeader`, and
  `pipelineQueueDepth` accessors for introspecting libwebsockets'
  `LCCSCF_PIPELINE` client connection queueing/muxing (h1 pipelining,
  h2 mux streams) — previously this state was private to `struct lws`
  and unobservable from JS. See
  [doc/LWSSocket.md](doc/LWSSocket.md#pipelining--keep-alive-introspection)
  and
  [doc/http-client.md](doc/http-client.md#connection-pipelining--keep-alive).
- Requires a small patch to the vendored libwebsockets adding the
  underlying `lws_get_txn_queue_leader()`, `lws_wsi_is_txn_queue_leader()`,
  and `lws_get_txn_queue_depth()` C accessors (not present upstream).
  Applied on the `libwebsockets` submodule's `txn-queue-introspection`
  branch; see `patches/0001-libwebsockets-txn-queue-introspection.patch`.
