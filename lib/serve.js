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
 * With no callback, `serve()` instead returns an async iterable yielding
 * whatever shows up - `Request` (call `.respond(response)` on it),
 * `WebSocketStream`, or `TCPSocket` - as connections arrive:
 *
 *   for await (const x of serve({ port: 8080 })) {
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
 */
import createContext from './lws/context.js';
import { http } from './lws/protocols.js';
import { Request } from './lws/request.js';
import { Response } from './lws/response.js';
import { ReadableStream } from './lws/streams.js';
import { URL } from './lws/url.js';
import { isPrototypeOf } from './lws/util.js';
import { WebSocketStream } from './websocketstream.js';
import { TCPSocket } from './tcpSocket.js';
import { LWSMPRO_CALLBACK, LWSMPRO_NO_MOUNT, LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG } from 'lws.so';

const NO_BODY_METHODS = new Set(['GET', 'HEAD']);

/** `ServerRequest` (lib/lws/app.js) -> a WHATWG `Request` streaming its body as it arrives. */
function toRequest(req) {
  const scheme = req.wsi.tls ? 'https' : 'http';
  const url = `${scheme}://${req.headers.host ?? 'localhost'}${req.originalUrl}`;

  const body = NO_BODY_METHODS.has(req.method)
    ? undefined
    : new ReadableStream({
        start: async controller => {
          const buf = await req.readBody(Infinity);

          if(buf && buf.byteLength) controller.enqueue(new Uint8Array(buf));
          controller.close();
        },
      });

  return new Request(url, { method: req.method, headers: req.headers, body });
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
    for await (const chunk of response.body) resp.write(chunk);
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
    if(!resp.headersSent)
      resp
        .status(500)
        .type('text/plain')
        .end(String(e?.stack ?? e));
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

  const { port = 0, hostname, host = hostname, tls, websocket = '/ws', raw = false, mounts, protocols = [], headers, html, access, upgrade, auth, ...rest } = opts;

  const sink = fetchHandler ? null : asyncQueue();

  /* When there's a fetch handler, HTTP requests never touch the queue -
     `respond()` (called from the `http()` adapter below) both awaits the
     handler and flushes its result straight onto the ServerResponse. In
     iterator mode, the Request handed out gets a bound `.respond()` so
     `for await (const req of serve(...)) req.respond(new Response(...))`
     works without the caller needing to keep the ServerResponse around. */
  const handleRequest = fetchHandler
    ? (req, resp) => respond(resp, fetchHandler(toRequest(req)))
    : (req, resp) => {
        const request = toRequest(req);
        request.respond = response => respond(resp, response);
        sink.push(request);
      };

  const wsPath = websocket === false ? false : websocket === true ? '/ws' : websocket?.mountpoint ?? websocket;
  const rawProtocol = raw === false ? false : raw === true ? 'raw' : (raw?.protocol ?? 'raw');

  const allProtocols = [{ name: 'http', ...http(handleRequest, { headers, html, access, upgrade, auth }) }, ...protocols];
  const allMounts = mounts ?? [];

  if(!mounts) allMounts.push({ mountpoint: '/', protocol: 'http', originProtocol: LWSMPRO_CALLBACK });

  if(wsPath !== false) {
    allProtocols.push(WebSocketStream.protocol('ws', wss => (fetchHandler ? fetchHandler(wss) : sink.push(wss))));
    if(!mounts) allMounts.push({ mountpoint: wsPath, protocol: 'ws', originProtocol: LWSMPRO_NO_MOUNT });
  }

  if(rawProtocol !== false) allProtocols.push(TCPSocket.protocol(rawProtocol, socket => (fetchHandler ? fetchHandler(socket) : sink.push(socket))));

  const ctx = createContext({
    port,
    vhostName: host,
    ...(tls ? { tls } : {}),
    ...(raw !== false ? { listenAcceptRole: 'raw-skt', listenAcceptProtocol: rawProtocol, options: (rest.options ?? 0) | LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG } : {}),
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
