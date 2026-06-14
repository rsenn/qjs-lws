# Event-loop integration

qjs-lws does **not** call `lws_service()` in a script-side loop.
Instead, it forwards libwebsockets's pollfd registration to QuickJS's
own `os.setReadHandler` / `os.setWriteHandler`. The QuickJS event
loop is what wakes the C code up.

Implemented in `iohandler.h` and `callback_pollfd` in `lws-context.c`.

## How it works

1. libwebsockets calls `LWS_CALLBACK_ADD_POLL_FD` with
   `{ fd, events }`. qjs-lws installs a small JS thunk on the
   appropriate side (read/write) of that fd using
   `os.setReadHandler(fd, fn)` or `os.setWriteHandler(fd, fn)`.
2. When QuickJS's `os` loop wakes the fd, the thunk calls
   `lws_service_fd()` with a fake `lws_pollfd` built from the
   event mask.
3. `LWS_CALLBACK_CHANGE_MODE_POLL_FD` swaps the handler between
   read and write according to the new event mask.
4. `LWS_CALLBACK_DEL_POLL_FD` clears both handlers, removing the
   fd from QuickJS's event loop.

`LWS_CALLBACK_LOCK_POLL` / `UNLOCK_POLL` are no-ops because there is
no second thread.

## Consequences for user code

- **You never call `os.setReadHandler` for an lws-managed fd
  yourself** — it would clobber the binding's handler.
- The constructor of `LWSContext` and `LWSVhost` may **invoke
  callbacks before returning** because the underlying create call
  immediately registers fds with the loop.
- The script stays alive as long as there is at least one fd
  registered (i.e. while there are open connections or a listening
  socket). The standard QuickJS `qjs` runtime exits when its event
  loop has nothing to wait for.
- To shut everything down explicitly, call `ctx.cancelService()`.
  It runs `lws_cancel_service()` then clears every io handler the
  binding created (`iohandler_cleanup`).
- Closing one connection from JS via `wsi.close()` is fine — the
  remaining fds keep the loop alive.

## Custom logging

`logLevel(mask, callback)` plugs a JS function into libwebsockets'
log path so the lws log lines flow through the same `os` loop:

```js
import { logLevel, getLogLevelName, getLogLevelColour, LLL_USER, LLL_ERR } from 'lws';

logLevel(LLL_USER | LLL_ERR, (level, msg) => {
  console.log(`[${getLogLevelName(level)}] ${msg}`);
});
```

If you don't supply a callback, libwebsockets writes ANSI-colourised
output to `stderr` itself.

## When to use `cancelService()`

- After an HTTP fetch finishes — `lib/fetch.js` calls
  `ctx.cancelService()` on `onClientHttpDropProtocol` so the script
  can exit cleanly.
- When tearing down a long-lived server in response to a signal.
