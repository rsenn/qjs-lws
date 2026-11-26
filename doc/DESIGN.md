# Design decisions

Cross-cutting choices that more than one document or source file depends
on. A decision that changes is corrected here in the same change.

## Socket and context registries

Rule: sockets are owned by the `LWSContext` that created them; contexts
are listed per runtime.

- Each `LWSContext` (C struct, `lws-context.h`) holds a `struct list_head
  sockets`, like its `handlers` and `timers`. `lws_context_user()` already
  leads from an lws context to it (`info.user` is the JS object, see
  `lwsjs_context_fromlws()`), so the user pointer itself stays as it is.
- A socket is added to the list of the context it is created for
  (`lws_get_context(wsi)`, or the `LWSContext` at the creation site) and
  leaves it in `socket_delete()`. When the context is freed it unlinks
  the sockets still on its list.
- There is no global socket list, so a runtime never sees the sockets of
  another one.
- Contexts sit in one process-wide list (`LWSContext.link`, `rt`). Readers
  filter by `rt == JS_GetRuntime(ctx)`. Adding and removing is guarded by
  a mutex where pthreads exist (not on Windows, where one runtime per
  thread creating contexts at the same instant is accepted as a risk).
- JS API: `ctx.sockets()`, static `LWSContext.sockets()` and static getter
  `LWSContext.contexts`. `LWSSocket.list()` stays as a deprecated alias.

Why: with Bun-style wrappers (`TCPSocket`, `fetch()`) the caller has no
reference to the context or the socket, so a static entry point is needed.
`JS_SetRuntimeOpaque()` cannot hold a registry: `quickjs-libc.c` keeps its
`JSThreadState` there.

Open: a `{ vhost }` filter for `ctx.sockets()`; a per-runtime context
registry instead of the process-wide list.
