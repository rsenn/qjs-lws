/**
 * Bun-shaped HTTP(+WS+raw) server: `serve(url | options[, callback])`.
 *
 * `callback` (or `options.fetch`) is `(request: Request) => Response |
 * Promise<Response>`, called once per HTTP request - exactly Bun.serve()'s
 * `fetch` handler. WS connections (mounted at `options.websocket`, default
 * `/ws`) and, if `options.raw` is set, non-HTTP-looking raw TCP connections
 * are hitting the same server but don't fit the request/response shape, so
 * `callback` just receives the bare `WebSocketStream` / `TCPSocket`.
 *
 * `options.raw` also accepts `{ protocol, always }` - with `always: true`,
 * *every* connection is treated as raw TCP, even ones that look like valid
 * HTTP requests (lws's LWS_SERVER_OPTION_ADOPT_APPLY_LISTEN_ACCEPT_CONFIG,
 * vs. the default LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG,
 * which only kicks in once the first bytes fail to parse as HTTP). Requires
 * the raw protocol to be registered before 'http' in the vhost's protocol
 * list - confirmed empirically that lws only honors an explicit
 * listen_accept_protocol unconditionally (regardless of what the incoming
 * bytes look like) when it's protocols[0]; serve() handles that ordering
 * for you.
 *
 * `options.websocket`/`options.raw`, given as objects, also accept a
 * `Class` - the constructor used to wrap accepted connections, in place of
 * the defaults (`WebSocketStream` for WS, `TCPSocket` for raw). Pass the
 * evented `WebSocket`/`TCPSocketStream` (lib/tcpsocketstream.js) instead if
 * that shape suits the handler better - all four classes' `.protocol()`
 * statics (lib/websocket.js, lib/websocketstream.js, lib/tcpsocket.js,
 * lib/tcpsocketstream.js) are interchangeable `createServer()` protocol
 * descriptors built the same way, on top of lib/lws/protocols.js's
 * `ws()`/`client()`/`raw()` role adapters:
 *
 *   serve({
 *     websocket: { Class: WebSocket },        // evented instead of streams
 *     raw: { always: true, Class: TCPSocketStream }, // streams instead of evented
 *     fetch: x => { ... },
 *   });
 *
 * With no callback, `serve()` instead returns an async iterable yielding
 * whatever shows up - `Request` (call `.respond(response)` on it),
 * `WebSocketStream`, or `TCPSocket` - as connections arrive:
 *
 *   for await(const x of serve({ port: 8080 })) {
 *     if(x instanceof Request) x.respond(new Response('hi'));
 *     else if(x instanceof WebSocketStream) ...
 *     else ...
 *   }
 *
 * Both forms share the exact same underlying wiring (lib/lws/protocols.js's
 * `http()` adapter + WebSocketStream.protocol()/TCPSocket.protocol()) - a
 * callback is just sugar for `for await` with `.respond()` wired up for you.
 *
 * `options.{headers,html,access,upgrade,auth}` pass straight through to
 * `http()`'s same-named hooks (see lib/lws/protocols.js) for the rarer
 * server-side lws callbacks (ADD_HEADERS/PROCESS_HTML/CHECK_ACCESS_RIGHTS/
 * HTTP_CONFIRM_UPGRADE/VERIFY_BASIC_AUTHORIZATION) that don't fit the
 * request/response model.
 *
 * `options.websocket` also accepts Bun's evented shape - `{ open(ws),
 * message(ws, data), close(ws, code, reason) }` - instead of (or alongside)
 * `mountpoint`. When any of those are given, every connection accepted at
 * the WS mountpoint is wrapped as a `WebSocket` (lib/websocket.js, evented -
 * not `WebSocketStream`/`Class`, which only apply to the plain callback/
 * iterator forms) and `open`/`message`/`close` fire on it directly - `ws`
 * itself is a regular `WebSocket`, so `ws.send()`/`ws.close()`/`ws.data`
 * (just a free-form property - set it in `open`, read it back in
 * `message`/`close`) all work as expected:
 *
 *   serve({
 *     websocket: {
 *       open(ws) { ws.data = { id: nextId++ }; },
 *       message(ws, data) { ws.send(`echo:${data}`); },
 *       close(ws, code, reason) { ... },
 *     },
 *   });
 *
 * `options.routes` matches Bun's `routes` table: an object mapping path
 * patterns (`compilePath()`-style, see lib/lws/app.js - `:name` segments,
 * a trailing `*` wildcard) to either a `Response` (served as-is, for any
 * method - its body is buffered once and replayed per request, since a
 * body stream can only be read once), a handler `(req) => Response |
 * Promise<Response>` (any method, `req.params` populated from the path),
 * or a `{ GET: handler, POST: handler, ... }` object dispatching by
 * method - a method with no handler there gets a 405 (`HEAD` falls back to
 * `GET` if present, matching Bun). Routes are tried, in declaration order,
 * before `fetch`/the iterator form - a request only reaches those once no
 * route matches.
 *
 * A response with no `content-length` header streams as
 * `Transfer-Encoding: chunked` (proper `<hex-len>\r\n<data>\r\n` framing +
 * `0\r\n\r\n` terminator - `ServerResponse#write()`/`#end()`,
 * lib/lws/response.js) as the body is produced, instead of buffering the
 * whole thing first to compute a length - matches what Bun does. Set
 * `content-length` yourself on the `Response` if you already know it and
 * want it declared instead.
 *
 * `fetch(request, server)` gets a second argument - the `Server` this
 * `serve()` call returns (also returned directly when a `fetch` handler is
 * given) - exposing two more Bun APIs:
 *
 * - `server.upgrade(request, { data })`: promotes *this* HTTP connection to
 *   a WebSocket instead of answering it with a `Response`, from inside
 *   `fetch` itself - lets one `fetch` handler serve any number of distinct
 *   WS "endpoints" at different paths (decided however you like - URL,
 *   headers, auth), all landing on the single shared `websocket:
 *   {open,message,close}` handler set (same as Bun - there's no per-
 *   endpoint open/message/close, only per-connection `ws.data`, set from
 *   `options.data` here and read back in `open`/`message`/`close`).
 *   Returns `true` if the upgrade was accepted (return `undefined` from
 *   `fetch` after calling it, same as Bun), `false` otherwise (answer with
 *   a normal `Response` instead, e.g. a 401). Requires `websocket` to be
 *   configured in Bun's evented shape (`{open,message,close}` - see
 *   above); with a plain `Class`/mountpoint-only `websocket` option, or no
 *   `fetch` handler at all, `.upgrade()` is a no-op that always returns
 *   `false`.
 *
 *   Must be called synchronously, before `fetch`'s first `await` if it's
 *   async - matches Bun's own contract, and is a hard requirement here:
 *   `LWS_CALLBACK_HTTP_CONFIRM_UPGRADE` (what this is built on - lws never
 *   fires `LWS_CALLBACK_HTTP`/calls `fetch` normally for a genuine upgrade
 *   request at all) is a synchronous native callback lws expects an
 *   immediate answer from. A `fetch` that *rejects* an upgrade (didn't
 *   call `.upgrade()`) faces the same constraint answering back: only a
 *   plain, already-in-memory `Response` returned synchronously (not a
 *   Promise, not a streamed body) can be sent as the reply; anything else
 *   just hangs up the connection instead of risking a malformed response.
 *   See `upgradeHook`/`makeUpgradeHook()` below for the full reasoning.
 *
 *   Known constraint: lws itself resolves *which* registered protocol an
 *   accepted WS upgrade binds to purely by matching the client's
 *   `Sec-WebSocket-Protocol` header against registered protocol names (or
 *   the vhost's first protocol if that header is absent) - confirmed
 *   empirically to be completely independent of mount/URL. `.upgrade()`
 *   accepting the request doesn't override that. In practice this only
 *   matters for a client that explicitly passes custom `protocols` to
 *   `new WebSocket(url, protocols)` naming something this vhost never
 *   registered - the ordinary `new WebSocket(url)` case (no header sent)
 *   is unaffected.
 *
 * - `server.publish(topic, message)`: broadcasts `message` to every WS
 *   connection currently subscribed to `topic` (`ws.subscribe(topic)`,
 *   `ws.unsubscribe(topic)`, `ws.isSubscribed(topic)`, `ws.publish(topic,
 *   message)` - the last one same as `server.publish()` but excludes the
 *   calling socket, matching Bun) - a Server-wide topic registry
 *   (lib/websocket.js's `TopicRegistry`) so the app doesn't have to track
 *   its own list of live sockets. Returns the total bytes handed to
 *   `wsi.write()` across every recipient - lws doesn't expose a
 *   per-write backpressure/delivery-confirmed result to check against, so
 *   this is "bytes attempted", not a confirmed-delivered count, unlike
 *   Bun's own (uWebSockets-backed) exact accounting. A closed socket's
 *   subscriptions are dropped automatically.
 */
import createContext from './lws/context.js';
import { http } from './lws/protocols.js';
import { compilePath } from './lws/app.js';
import { Headers } from './lws/headers.js';
import { Request } from './lws/request.js';
import { Response, ServerResponse } from './lws/response.js';
import { URL } from './lws/url.js';
import { isPrototypeOf } from './lws/util.js';
import { WebSocket } from './websocket.js';
import { WebSocketStream } from './websocketstream.js';
import { TCPSocket } from './tcpsocket.js';
import { LWSMPRO_CALLBACK, LWSMPRO_NO_MOUNT, LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG, LWS_SERVER_OPTION_ADOPT_APPLY_LISTEN_ACCEPT_CONFIG, CONTEXT_PORT_NO_LISTEN, LWSVhost, toArrayBuffer } from 'lws.so';

const NO_BODY_METHODS = new Set(['GET', 'HEAD']);

/** `ServerRequest` (lib/lws/app.js) -> a WHATWG `Request` streaming its body as it arrives. */
function toRequest(req) {
  const scheme = req.wsi.tls ? 'https' : 'http';
  const url = `${scheme}://${req.headers.host ?? 'localhost'}${req.originalUrl}`;

  // req.body (ServerRequest extends Body, lib/lws/app.js) enqueues each
  // chunk as it's read off the socket - unlike req.readBody(), it doesn't
  // wait for(or buffer) the whole body before the first byte is visible
  // here.
  const body = NO_BODY_METHODS.has(req.method) ? undefined : req.body;

  return new Request(url, { method: req.method, headers: req.headers, body });
}

/**
 * Builds a `Request` directly off a `wsi` still inside
 * `LWS_CALLBACK_HTTP_CONFIRM_UPGRADE` (see `upgrade()`/the `upgrade` hook
 * below) - unlike `toRequest()`, there's no `ServerRequest` yet at that
 * point (that's only built once `onHttp`/`LWS_CALLBACK_HTTP` fires, which
 * never happens for a genuine upgrade request - see `serve()`'s own doc
 * comment on `server.upgrade()`), and a GET-shaped upgrade request never
 * carries a body worth streaming.
 */
function requestFromWsi(wsi) {
  const headers = wsi.headers ?? {};
  const scheme = wsi.tls ? 'https' : 'http';
  const url = `${scheme}://${headers.host ?? 'localhost'}${wsi.uri ?? '/'}`;

  return new Request(url, { method: wsi.method || 'GET', headers });
}

/**
 * Best-effort synchronous body bytes for a `Response` - `undefined` if the
 * body isn't available without an `await` (a `ReadableStream`/iterable, or
 * anything but a string/ArrayBuffer/view). Body's constructor
 * (lib/lws/body.js) only keeps `_bodyInit` as an *own* property for a
 * plain, re-buildable body value - a stream/iterable body never gets one,
 * so `hasOwnProperty` (not just `!= null`, which a bodyless response's
 * inherited `null` default would also pass) is what actually distinguishes
 * the two.
 */
function syncResponseBytes(response) {
  if(response.body == null) return new ArrayBuffer(0);
  if(!Object.prototype.hasOwnProperty.call(response, '_bodyInit')) return undefined;

  const init = response._bodyInit;

  if(typeof init === 'string') return toArrayBuffer(init);
  if(init instanceof ArrayBuffer || ArrayBuffer.isView(init)) return init;

  return undefined;
}

/**
 * Wraps a static `Response` route entry (`routes` option) as a handler
 * function - buffers the body once, on first use, and hands out a fresh
 * `Response` per call, so the same route entry can serve any number of
 * requests despite a body being a one-shot stream.
 */
function staticHandler(response) {
  let cached;

  return () =>
    (cached ??= response.arrayBuffer().then(buf => ({ buf, status: response.statusCode, headers: new Headers(response.headers) }))).then(
      ({ buf, status, headers }) => new Response(buf, { status, headers }),
    );
}

/**
 * Compiles `options.routes` (Bun-shaped) into a match table: each pattern
 * (`compilePath()`, lib/lws/app.js - `:name` segments, trailing `*`) maps
 * to either a single any-method `handler`, or `methods` ({METHOD: handler})
 * for per-method dispatch.
 */
function compileRoutes(routes) {
  const table = [];

  for(const pattern in routes) {
    const { regex, keys } = compilePath(pattern, true);
    const entry = routes[pattern];

    if(typeof entry === 'function') table.push({ regex, keys, handler: entry });
    else if(isPrototypeOf(Response.prototype, entry)) table.push({ regex, keys, handler: staticHandler(entry) });
    else if(entry && typeof entry === 'object') {
      const methods = Object.setPrototypeOf({}, null);

      for(const m in entry) methods[m.toUpperCase()] = entry[m];
      table.push({ regex, keys, methods });
    }
  }

  return table;
}

/** First matching route (declaration order) for `path`/`method`, or `null`. */
function matchRoute(table, path, method) {
  for(const route of table) {
    const m = route.regex.exec(path);

    if(!m) continue;

    const params = Object.setPrototypeOf({}, null);

    for(let i = 0; i < route.keys.length; i++) params[route.keys[i]] = decodeURIComponent(m[i + 1]);

    if(route.methods) {
      const handler = route.methods[method] ?? (method === 'HEAD' ? route.methods.GET : undefined);

      if(!handler) return { params, allow: Object.keys(route.methods) };

      return { params, handler };
    }

    return { params, handler: route.handler };
  }

  return null;
}

/** Coerce whatever the handler returned into a real `Response`, matching Bun's leniency. */
function toResponse(value) {
  if(value == null) return new Response(null, { status: 404 });
  if(isPrototypeOf(Response.prototype, value)) return value;

  const { body, ...rest } = value;
  return new Response(body, rest);
}

/**
 * Flush a `Response` onto a `ServerResponse` (lib/lws/response.js). A client
 * waiting on `content-length` (or chunked encoding's own terminator) to know
 * the body's done - rather than the connection closing - would otherwise
 * hang (e.g. HttpClientProtocol, see lib/lws/protocols.js). If the handler
 * already set `content-length` itself, `ServerResponse#write()` streams the
 * body as-is (it knows what it's doing, possibly for a body larger than
 * comfortably fits in memory); otherwise `write()` switches to
 * `Transfer-Encoding: chunked` on its own on the first chunk and frames each
 * one - matching what Bun does for a streamed body with no declared length -
 * instead of buffering the whole thing here just to compute one upfront.
 */
async function flush(resp, response) {
  resp.status(response.statusCode);
  response.headers.forEach((value, name) => resp.append(name, value));

  if(!response.body) {
    resp.end();
    return;
  }

  for await(const chunk of response.body) resp.write(chunk);
  resp.end();
}

async function respond(resp, response) {
  try {
    await flush(resp, toResponse(await response));
  } catch(e) {
    // Route through flush() (not a raw resp.write()/.end()) so this error
    // body gets the same auto-computed content-length as any other
    // response - without one, a client waiting on content-length (rather
    // than connection-close) to know the body's done hangs forever, since
    // resp.end() here always happens at least one tick after onHttp
    // returns (see flush()'s own doc comment).
    if(!resp.headersSent) await flush(resp, new Response(String(e?.stack ?? e), { status: 500, headers: { 'content-type': 'text/plain' } }));
  }
}

/** A minimal FIFO async queue - `push()` from callbacks, consume with `for await`. */
function asyncQueue() {
  const values = [];
  const waiters = [];

  return {
    push(value) {
      const waiter = waiters.shift();
      if(waiter) waiter(value);
      else values.push(value);
    },
    [Symbol.asyncIterator]() {
      return {
        next: () => (values.length ? Promise.resolve({ value: values.shift(), done: false }) : new Promise(resolve => waiters.push(value => resolve({ value, done: false })))),
      };
    },
  };
}

class Server {
  #ctx;
  #pendingRequests = 0;
  #pendingWebSockets = 0;
  #development;
  #id;

  constructor(ctx, port, hostname, publish, development = false) {
    this.#ctx = ctx;
    this.port = port;
    this.hostname = hostname;
    this.#development = development;
    this.#id = `server-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    /** Bun's `server.publish(topic, message)` - broadcasts to every WS
        connection subscribed to `topic` (`ws.subscribe()`), server-wide,
        excluding nobody. `0` (no subscribers/no WS support configured) if
        `websocket: false` or no serve() session on this server ever
        called `ws.subscribe()`. */
    this.publish = publish ?? (() => 0);
  }

  get context() {
    return this.#ctx;
  }

  get url() {
    const protocol = this.#ctx.tls ? 'https' : 'http';
    const host = this.hostname || 'localhost';
    const port = this.port || (protocol === 'https' ? 443 : 80);
    return new URL(`${protocol}://${host}:${port}`);
  }

  get development() {
    return this.#development;
  }

  get id() {
    return this.#id;
  }

  get pendingRequests() {
    return this.#pendingRequests;
  }

  get pendingWebSockets() {
    return this.#pendingWebSockets;
  }

  stop() {
    return this.#ctx.destroy();
  }

  /** Bun's server.ref() - keeps the process alive while this server is running.
      Currently a no-op since lws contexts already keep the process alive. */
  ref() {
    // No-op: lws contexts already prevent process exit
  }

  /** Bun's server.unref() - allows the process to exit even if this server is running.
      Currently a no-op. */
  unref() {
    // No-op: would need lws context integration
  }

  /** Bun's server.subscriberCount(topic) - returns the number of WebSocket
      connections subscribed to a given topic. Returns 0 if no subscribers
      or no WebSocket support configured. */
  subscriberCount(topic) {
    // Would need access to the WebSocket TopicRegistry
    // For now, return 0 as a stub
    return 0;
  }

  /** Bun's server.requestIP(request) - returns the client IP address for a request.
      Returns null if unavailable. */
  requestIP(request) {
    // Would need to extract from the underlying wsi
    // For now, return null as a stub
    return null;
  }

  /** Bun's server.timeout(seconds) - sets the server-wide idle timeout.
      Currently a no-op. */
  timeout(seconds) {
    // No-op: would need lws context integration
  }

  /** Bun's server.closeIdleConnections() - closes all idle keep-alive connections.
      Returns the number of connections closed. Currently returns 0 as a stub. */
  closeIdleConnections() {
    // Would need lws context integration to enumerate and close idle connections
    return 0;
  }

  /** Bun's server.reload(options) - hot-reloads the server with new options.
      Currently a no-op stub. */
  reload(options) {
    // No-op: would need complex implementation to swap handlers without dropping connections
  }

  /** Bun's server.fetch(request) - makes an internal request to the server.
      Currently a no-op stub that returns a 501 Not Implemented response. */
  fetch(request) {
    // Would need to route the request through the server's handlers
    return Promise.resolve(new Response('Not Implemented', { status: 501 }));
  }

  // Internal methods for tracking requests and websockets
  _incrementRequests() {
    this.#pendingRequests++;
  }

  _decrementRequests() {
    this.#pendingRequests = Math.max(0, this.#pendingRequests - 1);
  }

  _incrementWebSockets() {
    this.#pendingWebSockets++;
  }

  _decrementWebSockets() {
    this.#pendingWebSockets = Math.max(0, this.#pendingWebSockets - 1);
  }
}

function urlToOptions(url) {
  const u = url instanceof URL ? url : new URL(String(url));
  const opts = { hostname: u.hostname };

  if(u.port) opts.port = +u.port;
  if(u.protocol === 'https:') opts.tls = {};

  return opts;
}

export function serve(...args) {
  const opts = {};
  let fetchHandler;

  for(const arg of args) {
    if(typeof arg === 'function') fetchHandler = arg;
    else if(typeof arg === 'string' || isPrototypeOf(URL.prototype, arg)) Object.assign(opts, urlToOptions(arg));
    else if(arg && typeof arg === 'object') Object.assign(opts, arg);
  }

  fetchHandler ??= opts.fetch;

  const { port = 0, hostname, host = hostname, tls, websocket = '/ws', raw = false, mounts, protocols = [], headers, html, access, upgrade, auth, routes, ...rest } = opts;

  const sink = fetchHandler ? null : asyncQueue();
  const routeTable = routes ? compileRoutes(routes) : null;

  // Assigned once the Server exists (below, after createContext()) -
  // referenced by closures (handleRequest, the upgrade hook) that only
  // ever run later, once the server's actually up, so the forward
  // reference is safe.
  let server;

  /* When there's a fetch handler, HTTP requests never touch the queue -
     `respond()` (called from the `http()` adapter below) both awaits the
     handler and flushes its result straight onto the ServerResponse. In
     iterator mode, the Request handed out gets a bound `.respond()` so
     `for await (const req of serve(...)) req.respond(new Response(...))`
     works without the caller needing to keep the ServerResponse around.
     `routes` (if given) are tried first, for both forms alike - only a
     request that matches no route falls through to fetch/the iterator. */
  const handleRequest = (req, resp) => {
    const match = routeTable && matchRoute(routeTable, req.path, req.method);

    if(match) {
      if(match.allow) {
        respond(resp, new Response(null, { status: 405, headers: { allow: match.allow.join(', ') } }));
        return;
      }

      const request = toRequest(req);

      request.params = match.params;
      respond(resp, match.handler(request));
      return;
    }

    if(fetchHandler) {
      respond(resp, fetchHandler(toRequest(req), server));
      return;
    }

    const request = toRequest(req);

    request.respond = response => respond(resp, response);
    sink.push(request);
  };

  const wsPath = websocket === false ? false : websocket === true ? '/ws' : (websocket?.mountpoint ?? websocket);
  const wsClass = websocket?.Class ?? WebSocketStream;

  /* Bun's evented shape - `{ open, message, close }` - takes over the WS
     mountpoint entirely instead of handing connections to fetch/the
     iterator as a `Class` instance; `Class` doesn't apply in this mode,
     every connection is a `WebSocket` (lib/websocket.js). */
  const wsOpen = websocket && typeof websocket === 'object' ? websocket.open : undefined;
  const wsMessage = websocket && typeof websocket === 'object' ? websocket.message : undefined;
  const wsClose = websocket && typeof websocket === 'object' ? websocket.close : undefined;
  const wsBunStyle = !!(wsOpen || wsMessage || wsClose);

  /**
   * `server.upgrade(request, options)` - see serve()'s own doc comment for
   * the full design/constraints. `wsUpgradeData` carries `options.data`
   * from here to the WS `open` handler below (same wsi throughout a plain
   * http->ws upgrade, so a WeakMap keyed by wsi is enough); `pendingUpgrade`
   * is only ever set for the duration of the single, synchronous
   * `fetchHandler()` call inside `upgradeHook` below - `.upgrade()` is only
   * valid called synchronously from within that exact call, matching Bun's
   * own contract, and `pendingUpgrade.request !== request` is what makes a
   * stale/foreign Request (or a second `.upgrade()` call) a no-op `false`
   * instead of hijacking someone else's connection.
   */
  const wsUpgradeData = new WeakMap();
  let pendingUpgrade = null;

  function upgradeConnection(request, options = {}) {
    if(!pendingUpgrade || pendingUpgrade.request !== request || pendingUpgrade.decided) return false;

    pendingUpgrade.accepted = true;
    pendingUpgrade.data = options.data;
    pendingUpgrade.decided = true;
    return true;
  }

  /**
   * `LWS_CALLBACK_HTTP_CONFIRM_UPGRADE` (the existing `upgrade` hook,
   * `HttpProtocol`/lib/lws/protocols.js) is the only point lws gives JS any
   * say over a WS upgrade *before* it happens - `LWS_CALLBACK_HTTP`
   * (`onHttp`/`fetch` normally) never fires for a genuine upgrade request
   * at all (confirmed directly against lws's own
   * lib/roles/http/server/server.c: an Upgrade header routes straight to
   * this callback, then lws's own native handshake, entirely bypassing
   * lws_http_action()/LWS_CALLBACK_HTTP). So `server.upgrade()` is wired up
   * by treating *this* callback as the "call fetch, see if it upgraded"
   * dispatch point instead: it synthesizes a `Request` from the still-
   * unestablished `wsi` (headers/uri/method are already parsed by this
   * point), calls `fetchHandler(request, server)`, and checks - strictly
   * synchronously, in the same tick, no `await` - whether that call made
   * `pendingUpgrade.accepted` true via `upgradeConnection()` above (Bun's
   * own real contract: `.upgrade()` must be called synchronously, before
   * fetch's first `await` if it's async - checking right after the call
   * returns, Promise or not, mirrors that exactly).
   *
   * Accepted: return 0 ("allowed") and let lws's native upgrade machinery
   * proceed as it always did - it binds the connection to whichever
   * registered protocol matches the client's Sec-WebSocket-Protocol header
   * (or the vhost's first/default protocol if none was sent - confirmed
   * empirically, this is *not* mount/URL-based at all), so the `websocket`
   * Bun-style handlers stay the single, shared open/message/close target
   * for every `.upgrade()`-accepted connection regardless of which URL
   * fetch() upgraded it from - same as Bun itself, which also has no
   * per-endpoint open/message/close, only per-connection `ws.data`.
   *
   * KNOWN CONSTRAINT: a client whose `Sec-WebSocket-Protocol` doesn't name
   * one of this vhost's registered protocols (and isn't absent, which
   * falls back to the vhost's default) fails the native upgrade
   * regardless of `.upgrade()` accepting it - lws resolves that purely by
   * protocol *name*, with no hook back into JS at that stage. In practice
   * this only bites an app that explicitly passes custom `protocols` to
   * `new WebSocket(url, protocols)`; the common `new WebSocket(url)` case
   * (no header sent) is unaffected.
   *
   * Rejected (fetch didn't call `.upgrade()`): lws's own contract for a
   * confirm-upgrade rejection (returning >0) requires the HTTP response to
   * already be fully written by the time this function returns - there's
   * no way to defer that, this is a synchronous native callback. That's
   * only achievable for a `fetch` that returned a plain `Response` (not a
   * Promise - i.e. a non-async handler, or one that resolved before any
   * `await`) whose body is already in memory (`syncResponseBytes()`) - the
   * overwhelmingly common shape for a "here's why I didn't upgrade you"
   * reply (`return new Response('Unauthorized', {status:401})`). Anything
   * else (an async handler, or a streamed rejection body) can't be
   * satisfied without corrupting lws's HTTP state machine, so that case
   * hangs up the connection instead (return -1) rather than risk a
   * malformed response.
   */
  function makeUpgradeHook() {
    return (wsi, type) => {
      if(type !== 'websocket') return upgrade?.(wsi, type);

      const request = requestFromWsi(wsi);
      const pending = { request, accepted: false, data: undefined, decided: false };

      pendingUpgrade = pending;
      let result;
      try {
        result = fetchHandler(request, server);
      } finally {
        pendingUpgrade = null;
      }

      if(pending.accepted) {
        wsUpgradeData.set(wsi, pending.data);
        Promise.resolve(result).catch(() => {}); // fetch shouldn't return anything here (Bun: "return undefined") - swallow it either way, success or failure, rather than an unhandled rejection
        return 0;
      }

      if(result instanceof Promise) return -1; // can't synchronously satisfy the reject-with-response contract - see doc comment above

      const response = toResponse(result);
      const bytes = syncResponseBytes(response);

      if(bytes === undefined) return -1; // streamed rejection body - same constraint

      const resp = new ServerResponse(wsi);

      resp.status(response.statusCode);
      response.headers.forEach((value, name) => resp.append(name, value));
      resp.end(bytes);

      return 1;
    };
  }

  const effectiveUpgrade = fetchHandler && wsBunStyle ? makeUpgradeHook() : upgrade;

  const rawProtocol = raw === false ? false : raw === true ? 'raw' : (raw?.protocol ?? 'raw');
  const rawAlways = raw !== false && raw !== true && !!raw.always;
  const rawClass = raw?.Class ?? TCPSocket;

  const rawEntry = rawProtocol !== false ? rawClass.protocol(rawProtocol, socket => (fetchHandler ? fetchHandler(socket) : sink.push(socket))) : null;

  // With rawAlways, the raw entry has to be protocols[0] (see the class
  // doc comment above) - everywhere else, order doesn't matter, so it's
  // simplest to just append it after 'ws' like before.
  const allProtocols = [...(rawAlways && rawEntry ? [rawEntry] : []), { name: 'http', ...http(handleRequest, { headers, html, access, upgrade: effectiveUpgrade, auth }) }, ...protocols];
  const allMounts = mounts ?? [];

  if(!mounts) allMounts.push({ mountpoint: '/', protocol: 'http', originProtocol: LWSMPRO_CALLBACK });

  let wsDescriptor;

  if(wsPath !== false) {
    wsDescriptor = wsBunStyle
      ? WebSocket.protocol('ws', ws => {
          // Only ever set for a connection server.upgrade() actually
          // accepted (see makeUpgradeHook() above) - the wsi is the same
          // one throughout a plain http->ws upgrade, so this WeakMap
          // lookup reliably reconnects the two.
          const wsi = WebSocket.lws(ws);

          if(wsUpgradeData.has(wsi)) {
            ws.data = wsUpgradeData.get(wsi);
            wsUpgradeData.delete(wsi);
          }

          wsOpen?.(ws);
          if(wsMessage) ws.onmessage = e => wsMessage(ws, e.data);
          if(wsClose) ws.onclose = e => wsClose(ws, e.code, e.reason);
        })
      : wsClass.protocol('ws', wss => (fetchHandler ? fetchHandler(wss) : sink.push(wss)));

    allProtocols.push(wsDescriptor);
    if(!mounts) allMounts.push({ mountpoint: wsPath, protocol: 'ws', originProtocol: LWSMPRO_NO_MOUNT });
  }

  if(rawEntry && !rawAlways) allProtocols.push(rawEntry);

  const ctx = createContext({
    port: CONTEXT_PORT_NO_LISTEN,
    ...rest,
  });

  const vhost = new LWSVhost(ctx, {
    port,
    vhostName: host,
    ...(tls ? { tls } : {}),
    ...(raw !== false
      ? {
          listenAcceptRole: 'raw-skt',
          listenAcceptProtocol: rawProtocol,
          options: (rest.options ?? 0) | (rawAlways ? LWS_SERVER_OPTION_ADOPT_APPLY_LISTEN_ACCEPT_CONFIG : LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG),
        }
      : {}),
    mounts: allMounts,
    protocols: allProtocols,
  });

  const actualPort = vhost.listenPort;

  server = new Server(ctx, actualPort, host, wsDescriptor?.publish);
  server.upgrade = upgradeConnection;

  if(fetchHandler) return server;

  // .upgrade() has no meaning here - it needs a synchronous fetch() call
  // to dispatch the accept/reject decision through, which is exactly what
  // iterator mode (no `fetch`) doesn't have - always false, not missing,
  // so calling it is a harmless no-op rather than a crash.
  return Object.assign(sink, { context: ctx, stop: () => ctx.destroy(), port: actualPort, hostname: host, publish: wsDescriptor?.publish ?? (() => 0), upgrade: () => false });
}

export { Response } from './lws/response.js';
export { Request } from './lws/request.js';
