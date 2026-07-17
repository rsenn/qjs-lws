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
 */
import createContext from './lws/context.js';
import { http } from './lws/protocols.js';
import { compilePath } from './lws/app.js';
import { Headers } from './lws/headers.js';
import { Request } from './lws/request.js';
import { Response } from './lws/response.js';
import { URL } from './lws/url.js';
import { isPrototypeOf } from './lws/util.js';
import { WebSocket } from './websocket.js';
import { WebSocketStream } from './websocketstream.js';
import { TCPSocket } from './tcpsocket.js';
import { LWSMPRO_CALLBACK, LWSMPRO_NO_MOUNT, LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG, LWS_SERVER_OPTION_ADOPT_APPLY_LISTEN_ACCEPT_CONFIG } from 'lws.so';

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
 * Wraps a static `Response` route entry (`routes` option) as a handler
 * function - buffers the body once, on first use, and hands out a fresh
 * `Response` per call, so the same route entry can serve any number of
 * requests despite a body being a one-shot stream.
 */
function staticHandler(response) {
  let cached;

  return () =>
    (cached ??= response.arrayBuffer().then(buf => ({ buf, status: response.status, headers: new Headers(response.headers) }))).then(
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
 * Flush a `Response` onto a `ServerResponse` (lib/lws/app.js). Without a
 * declared `content-length`, the response is close-delimited (no chunked
 * encoding here) - fine for a browser/curl, but leaves an HTTP client that's
 * waiting on `content-length` to know the body's done (e.g.
 * HttpClientProtocol, see lib/lws/protocols.js) stuck until the connection
 * closes. So: if the handler already set `content-length` itself, stream
 * the body as-is (it knows what it's doing, possibly for a body larger than
 * comfortably fits in memory); otherwise buffer it to compute one.
 */
async function flush(resp, response) {
  resp.status(response.status);
  response.headers.forEach((value, name) => resp.append(name, value));

  if(!response.body) {
    resp.end();
    return;
  }

  if(resp.headers.has('content-length')) {
    for await(const chunk of response.body) resp.write(chunk);
    resp.end();
    return;
  }

  const buf = await response.arrayBuffer();
  resp.set('content-length', String(buf.byteLength));
  resp.end(buf);
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

  constructor(ctx, port, hostname) {
    this.#ctx = ctx;
    this.port = port;
    this.hostname = hostname;
  }

  get context() {
    return this.#ctx;
  }

  stop() {
    return this.#ctx.destroy();
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
      respond(resp, fetchHandler(toRequest(req)));
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

  const rawProtocol = raw === false ? false : raw === true ? 'raw' : (raw?.protocol ?? 'raw');
  const rawAlways = raw !== false && raw !== true && !!raw.always;
  const rawClass = raw?.Class ?? TCPSocket;

  const rawEntry = rawProtocol !== false ? rawClass.protocol(rawProtocol, socket => (fetchHandler ? fetchHandler(socket) : sink.push(socket))) : null;

  // With rawAlways, the raw entry has to be protocols[0] (see the class
  // doc comment above) - everywhere else, order doesn't matter, so it's
  // simplest to just append it after 'ws' like before.
  const allProtocols = [...(rawAlways && rawEntry ? [rawEntry] : []), { name: 'http', ...http(handleRequest, { headers, html, access, upgrade, auth }) }, ...protocols];
  const allMounts = mounts ?? [];

  if(!mounts) allMounts.push({ mountpoint: '/', protocol: 'http', originProtocol: LWSMPRO_CALLBACK });

  if(wsPath !== false) {
    allProtocols.push(
      wsBunStyle
        ? WebSocket.protocol('ws', ws => {
            wsOpen?.(ws);
            if(wsMessage) ws.addEventListener('message', e => wsMessage(ws, e.data));
            if(wsClose) ws.addEventListener('close', e => wsClose(ws, e.code, e.reason));
          })
        : wsClass.protocol('ws', wss => (fetchHandler ? fetchHandler(wss) : sink.push(wss))),
    );
    if(!mounts) allMounts.push({ mountpoint: wsPath, protocol: 'ws', originProtocol: LWSMPRO_NO_MOUNT });
  }

  if(rawEntry && !rawAlways) allProtocols.push(rawEntry);

  const ctx = createContext({
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
    ...rest,
    mounts: allMounts,
    protocols: allProtocols,
  });

  const server = new Server(ctx, port, host);

  if(fetchHandler) return server;

  return Object.assign(sink, { context: ctx, stop: () => ctx.destroy(), port, hostname: host });
}

export { Response } from './lws/response.js';
export { Request } from './lws/request.js';
