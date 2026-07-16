/**
 * Adapters that bridge lws's native `on<CallbackReason>` protocol callbacks
 * to a small set of role-shaped handlers, so the same handler set works
 * whether the wsi underneath is HTTP, WS or a raw TCP socket.
 *
 * Each adapter is a class: it owns whatever per-wsi lifecycle state its role
 * needs (a WeakMap keyed by wsi), and exposes its `on<Name>` methods as
 * class-field arrow functions - own, enumerable, bound instance properties -
 * so an instance spreads directly into a `protocols: [...]` descriptor:
 *
 *   protocols: [{ name: 'chat', ...ws({ open, message, close }) }]
 *
 * `http()` is the odd one out: an lws connection (`wsi`) outlives any single
 * HTTP request/response on it (keep-alive), so each `onHttp` gets a fresh
 * `ServerRequest`/`ServerResponse` pair (see ./app.js) and the handler is
 * called `fn(req, resp)` - not `fn(wsi, ...)` - with body chunks and
 * completion routed onto that pair automatically.
 */
import { ServerRequest, ServerResponse } from './app.js';
import { Headers } from './headers.js';
import { Request } from './request.js';
import { Response } from './response.js';
import { ReadableStream, WritableStream } from './streams.js';
import { waitWrite } from './util.js';
import { LWS_WRITE_HTTP, LWS_WRITE_HTTP_FINAL } from 'lws';
import { MultipartParser } from './multipart.js';

/**
 * HTTP server role: `fn(req: ServerRequest, resp: ServerResponse)`, once per
 * request. `hooks` covers the rarer server-side callbacks, each passed
 * through as-is (`wsi`, plus whatever lws hands that reason):
 *
 *   - `headers(wsi, buf, len)`  - LWS_CALLBACK_ADD_HEADERS
 *   - `html(wsi, buf, len)`     - LWS_CALLBACK_PROCESS_HTML
 *   - `access(wsi, buf, len)`   - LWS_CALLBACK_CHECK_ACCESS_RIGHTS
 *   - `upgrade(wsi, type)`      - LWS_CALLBACK_HTTP_CONFIRM_UPGRADE
 *   - `auth(wsi, ...)`          - LWS_CALLBACK_VERIFY_BASIC_AUTHORIZATION
 */
export class HttpProtocol {
  #fn;
  #headers;
  #html;
  #access;
  #upgrade;
  #auth;
  #requests = new WeakMap();

  constructor(fn, { headers, html, access, upgrade, auth, post } = {}) {
    this.#fn = fn;
    this.#headers = headers;
    this.#html = html;
    this.#access = access;
    this.#upgrade = upgrade;
    this.#auth = auth;

    if(post) {
      Object.assign(
        this,
        HttpProtocol.post(wsi => {
          const parser = new MultipartParser(wsi);
          post(wsi, parser);
          return parser;
        }),
      );
    }
  }

  onHttp = wsi => {
    const req = new ServerRequest(wsi);
    const resp = new ServerResponse(wsi);

    this.#requests.set(wsi, req);
    this.#fn(req, resp);
  };

  onHttpBody = (wsi, buf) => this.#requests.get(wsi)?._appendBody(buf);
  onHttpBodyCompletion = wsi => this.#requests.get(wsi)?._closeBody();
  onClosedHttp = wsi => this.#requests.delete(wsi);

  onAddHeaders = (wsi, buf, len) => this.#headers?.(wsi, buf, len);
  onProcessHtml = (wsi, buf, len) => this.#html?.(wsi, buf, len);
  onCheckAccessRights = (wsi, buf, len) => this.#access?.(wsi, buf, len);
  onHttpConfirmUpgrade = (wsi, type) => this.#upgrade?.(wsi, type);
  onVerifyBasicAuthorization = (wsi, ...args) => this.#auth?.(wsi, ...args);

  static post(callback) {
    const controllers = new WeakMap();

    const finish = wsi => {
      controllers.get(wsi)?.close();
      controllers.delete(wsi);
    };

    return {
      onHttpBody: (wsi, buf) => {
        let controller = controllers.get(wsi);

        if(!controller) controllers.set(wsi, (controller = callback(wsi)));

        if(buf && buf.byteLength) controller.write(buf);
      },
      onHttpBodyCompletion: finish,
      //onClosedHttp: finish,
    };
  }
}

/**
 * HTTP client role: `fn(req: Request, resp: Response)`, once the response
 * status/headers arrive - `resp.body` then streams the rest as it comes in.
 * 3xx redirects are followed automatically (lws does this itself, on a
 * fresh wsi of its own - see `onClientHttpRedirect` below), same as a
 * default WHATWG `fetch()`; `fn` only ever sees the final response.
 *
 * `hooks`:
 *   - `error(req, err)`              - connection/transfer failed
 *   - `redirect(req, url, status)`   - LWS_CALLBACK_CLIENT_HTTP_REDIRECT
 *                                      (informational - the redirect is
 *                                      followed either way)
 *   - `read(req, data, len)`         - LWS_CALLBACK_RECEIVE_CLIENT_HTTP_READ
 *                                      (informational - `resp.body` is
 *                                      already fed from this internally)
 *   - `handshake(wsi, buf, len)`     - LWS_CALLBACK_CLIENT_APPEND_HANDSHAKE_HEADER
 *                                      (fires after this class's own header/
 *                                      body-length writes, to add more)
 *   - `filter(wsi)`                  - LWS_CALLBACK_CLIENT_FILTER_PRE_ESTABLISH
 */
export class HttpClientProtocol {
  #fn;
  #onError;
  #onRedirect;
  #onRead;
  #onHandshake;
  #onFilter;
  #pending;
  #redirecting = false;
  #sessions = new WeakMap();

  constructor(fn, { error, redirect, read, handshake, filter } = {}) {
    this.#fn = fn;
    this.#onError = error;
    this.#onRedirect = redirect;
    this.#onRead = read;
    this.#onHandshake = handshake;
    this.#onFilter = filter;
  }

  /**
   * Starts a client HTTP request on `ctx` and returns a promise for
   * `{ req, wsi }`. `options` is the same shape `Request`'s constructor and
   * `LWSContext#clientConnect` both accept (method, headers, body, ...) -
   * `body` may be a `String`, an `ArrayBuffer`/view, or a `ReadableStream`
   * (anything `Request`/`Body` accepts). If a body is present on `url`
   * (when it's already a `Request`) or on `options`, and no explicit
   * `method` was given, the request defaults to POST instead of GET.
   *
   * The body is fully read up front (awaited here, before the connection
   * even opens) so its exact byte length is known for the `content-length`
   * header - lws's HTTP/1.1 client body write needs that declared ahead of
   * the request line being sent, there's no chunked-encoding fallback here.
   */
  async connect(ctx, url, options = {}) {
    const hasBody = options.body != null || (url instanceof Request && url._bodyInit != null);
    const req = new Request(url, hasBody && !options.method ? { ...options, method: 'POST' } : options);
    const body = req.body != null ? new Uint8Array(await req.arrayBuffer()) : null;

    let controller;
    const resp = new Response(new ReadableStream({ start: c => (controller = c) }), {});

    this.#pending = { req, resp, controller, body };

    const wsi = ctx.clientConnect(req.url, { method: req.method, protocol: 'http', local_protocol_name: 'http', ...options });
    return { req, wsi };
  }

  #session(wsi) {
    let session = this.#sessions.get(wsi);

    if(!session && this.#pending) {
      session = this.#pending;
      this.#pending = undefined;
      this.#sessions.set(wsi, session);
    }

    return session;
  }

  onServerNewClientInstantiated = wsi => void this.#session(wsi);

  onClientFilterPreEstablish = wsi => this.#onFilter?.(wsi);

  onClientAppendHandshakeHeader = (wsi, buf, len) => {
    const session = this.#session(wsi);
    if(!session) return;

    for(const [name, value] of session.req.headers) wsi.addHeader(name, value, buf, len);

    if(session.body) {
      if(!session.req.headers.has('content-length')) wsi.addHeader('content-length', String(session.body.byteLength), buf, len);
      wsi.bodyPending = 1;
    }

    this.#onHandshake?.(wsi, buf, len);
  };

  /* Fires once lws is ready for the (POST/PUT/...) request body - writing it
     any earlier would corrupt the request framing. `body` was already fully
     read (see connect()) so this is one write, never re-entered - matches
     what content-length above declared. */
  onClientHttpWriteable = wsi => {
    const session = this.#session(wsi);
    if(!session || !session.body) return;

    wsi.write(session.body.buffer, LWS_WRITE_HTTP_FINAL);
    wsi.bodyPending = 0;
  };

  /* lws follows the redirect itself, on a brand-new wsi - this one gets
     dropped right after (onClientHttpDropProtocol below). Re-arming
     `#pending` with the same session is what lets that new wsi's first
     callback (#session()) pick this session back up instead of finding
     nothing. */
  onClientHttpRedirect = (wsi, url, status) => {
    const session = this.#session(wsi);

    if(session) {
      session.resp.redirected = true;
      this.#sessions.delete(wsi);
      this.#pending = session;
      this.#redirecting = true;
    }

    this.#onRedirect?.(session?.req, url, status);
  };

  onEstablishedClientHttp = (wsi, status) => {
    const session = this.#session(wsi);
    if(!session) return;

    session.resp.status = status;
    session.resp.headers = new Headers(wsi.headers);
    session.established = true;
    this.#fn(session.req, session.resp);
  };

  /* Just the "data's ready, go read it" signal - the actual bytes (already
     correctly sized) arrive via onReceiveClientHttpRead below, which
     wsi.httpClientRead() re-enters synchronously from inside lws itself
     (see libwebsockets/lib/roles/http/client/client-http.c). */
  onReceiveClientHttp = wsi => {
    const buf = new ArrayBuffer(0xff0 * 16);

    try {
      wsi.httpClientRead(buf);
    } catch(e) {}
  };

  onReceiveClientHttpRead = (wsi, data, len) => {
    const session = this.#session(wsi);

    session?.controller.enqueue(new Uint8Array(data));
    this.#onRead?.(session?.req, data, len);
  };

  onCompletedClientHttp = wsi => {
    const session = this.#session(wsi);
    if(session) {
      session.completed = true;
      session.controller.close();
    }
  };

  /* A response with no content-length and no chunked encoding is delimited
     by the connection closing (HTTP/1.0-style) - lws has no other way to
     tell us the body finished, so LWS_CALLBACK_COMPLETED_CLIENT_HTTP never
     fires for it. Treat "closed after we got a response" as that response
     having finished, same as a real browser/HTTP client would; only a close
     before establishment, or before any bytes at all, is an actual error. */
  onClosedClientHttp = wsi => {
    const session = this.#session(wsi);
    this.#sessions.delete(wsi);

    if(!session) return;

    if(!session.established) {
      this.#onError?.(session.req, new Error('closed'));
      return;
    }

    if(!session.completed) {
      session.completed = true;
      try {
        session.controller.close();
      } catch(e) {}
    }
  };

  /* Fires when a wsi is dropped without going through onClosedClientHttp -
     the expected case is right after onClientHttpRedirect above (lws
     dropping the old wsi once it's following the redirect on a new one),
     which #redirecting distinguishes from a genuine abrupt drop. */
  onClientHttpDropProtocol = wsi => {
    if(this.#redirecting) {
      this.#redirecting = false;
      return;
    }

    const session = this.#session(wsi);
    this.#sessions.delete(wsi);

    if(!session) return;

    if(!session.established) this.#onError?.(session.req, new Error('dropped'));
    else if(!session.completed)
      try {
        session.controller.error(new Error('dropped'));
      } catch(e) {}
  };

  onClientConnectionError = (wsi, msg) => {
    const session = this.#session(wsi);
    this.#sessions.delete(wsi);

    this.#onError?.(session?.req, new Error(msg));
  };
}

/**
 * Captures the code/reason lws only ever delivers via the separate
 * `onWsPeerInitiatedClose` callback, so both WS roles below can hand their
 * `close` handler a single `close(wsi, code, reason)` call regardless of
 * whether the peer or we initiated the close.
 */
class WsCloseTracker {
  #pending = new WeakMap();

  peerClose = (wsi, code, reason) => {
    this.#pending.set(wsi, { code, reason });
    return 0;
  };

  take(wsi) {
    const info = this.#pending.get(wsi);
    this.#pending.delete(wsi);
    return info ?? {};
  }
}

/** WS server role: `{ open(wsi), message(wsi, data, size), close(wsi, code, reason) }`. */
export class WsProtocol {
  #open;
  #message;
  #close;
  #closed = new WsCloseTracker();

  constructor({ open, message, close } = {}) {
    this.#open = open;
    this.#message = message;
    this.#close = close;
  }

  onEstablished = (...args) => this.#open?.(...args);
  onReceive = (...args) => this.#message?.(...args);
  onWsPeerInitiatedClose = this.#closed.peerClose;
  onClosed = wsi => {
    const { code, reason } = this.#closed.take(wsi);
    this.#close?.(wsi, code, reason);
  };
}

/** WS client role: `{ open(wsi), message(wsi, data, size), close(wsi, code, reason), error(wsi, message) }`. */
export class WsClientProtocol {
  #open;
  #message;
  #close;
  #error;
  #closed = new WsCloseTracker();

  constructor({ open, message, close, error } = {}) {
    this.#open = open;
    this.#message = message;
    this.#close = close;
    this.#error = error;
  }

  onClientEstablished = (...args) => this.#open?.(...args);
  onClientReceive = (...args) => this.#message?.(...args);
  onWsPeerInitiatedClose = this.#closed.peerClose;
  onClientClosed = wsi => {
    const { code, reason } = this.#closed.take(wsi);
    this.#close?.(wsi, code, reason);
  };
  onClientConnectionError = (wsi, msg) => this.#error?.(wsi, msg);
}

/**
 * RAW role (client + server share one callback namespace in lws):
 * `{ open(wsi), message(wsi, data, size), close(wsi), error(wsi, message) }`.
 * `open` fires for both an accepted server connection (`onRawAdopt`) and an
 * established client connection (`onRawConnected`) - check `wsi.client` to
 * tell them apart.
 */
export class RawProtocol {
  #open;
  #message;
  #close;
  #error;

  constructor({ open, message, close, error } = {}) {
    this.#open = open;
    this.#message = message;
    this.#close = close;
    this.#error = error;
  }

  onRawAdopt = (...args) => this.#open?.(...args);
  onRawConnected = (...args) => this.#open?.(...args);
  onRawRx = (...args) => this.#message?.(...args);
  onRawClose = (...args) => this.#close?.(...args);
  onClientConnectionError = (wsi, msg) => this.#error?.(wsi, msg);
}

/**
 * Promisified `{ opened, closed }` (each resolving to `{ readable, writable,
 * ...extra }`) fed directly from open/message/close/error events - no
 * EventTarget/dispatchEvent in between. This is what `WebSocketStream`
 * (lib/websocketstream.js) and `TCPSocketStream` (lib/tcpsocketstream.js) are
 * built on, independently of the evented `WebSocket`/`TCPSocket` classes -
 * `extra(wsi, ...)` supplies whatever role-specific fields `opened` should
 * carry (`protocol`/`extensions` for WS, `remoteAddress`/... for raw) and
 * `closeInfo(wsi, ...)` likewise for what `closed` resolves with
 * (`{closeCode, reason}` for WS, `{}` for raw).
 *
 * One instance backs any number of concurrent connections, same as the
 * role adapters above - `session()`'s own `open`/`message`/`close`/`error`
 * methods (matching the `ws()`/`client()`/`raw()` handler shape exactly, so
 * they spread straight into one of those) route events to the right
 * session by wsi. Two ways to register one:
 *
 *   - `session()` - wsi not known yet (about to `ctx.clientConnect()`); the
 *     *next* open/message/close/error this instance receives claims it,
 *     the same "pending" handoff `HttpClientProtocol` uses above.
 *   - `session(wsi)` - wsi already exists (server accept/establish);
 *     `opened` resolves immediately, no need to wait for a native `open`.
 */
export class StreamAdapter {
  #extra;
  #closeInfo;
  #pending;
  #sessions = new WeakMap();

  constructor({ extra = () => ({}), closeInfo = () => ({}) } = {}) {
    this.#extra = extra;
    this.#closeInfo = closeInfo;
  }

  session(wsi) {
    const box = { wsi, controller: undefined };

    const readable = new ReadableStream({
      start: c => (box.controller = c),
      cancel: () => box.wsi?.close(),
    });

    const writable = new WritableStream({
      write: async chunk => {
        await waitWrite(box.wsi);
        box.wsi.write(chunk);
      },
      close: () => box.wsi?.close(),
      abort: reason => box.wsi?.close(undefined, reason),
    });

    let resolveOpened, rejectOpened, resolveClosed;
    const opened = new Promise((resolve, reject) => {
      resolveOpened = resolve;
      rejectOpened = reject;
    });
    const closed = new Promise(resolve => (resolveClosed = resolve));

    const entry = { box, readable, writable, resolveOpened, rejectOpened, resolveClosed };

    if(wsi) {
      this.#sessions.set(wsi, entry);
      resolveOpened({ readable, writable, ...this.#extra(wsi) });
    } else {
      this.#pending = entry;
    }

    return { opened, closed };
  }

  #session(wsi) {
    let session = this.#sessions.get(wsi);

    if(!session && this.#pending) {
      session = this.#pending;
      session.box.wsi = wsi;
      this.#pending = undefined;
      this.#sessions.set(wsi, session);
    }

    return session;
  }

  open = (wsi, ...args) => {
    const session = this.#session(wsi);

    session?.resolveOpened({ readable: session.readable, writable: session.writable, ...this.#extra(wsi, ...args) });
  };

  message = (wsi, data) => this.#session(wsi)?.box.controller.enqueue(data);

  close = (wsi, ...args) => {
    const session = this.#session(wsi);
    this.#sessions.delete(wsi);
    if(!session) return;

    try {
      session.box.controller.close();
    } catch(e) {}

    session.resolveClosed(this.#closeInfo(wsi, ...args));
  };

  error = (wsi, message) => {
    const session = this.#session(wsi);
    this.#sessions.delete(wsi);
    if(!session) return;

    const err = new Error(message);

    try {
      session.box.controller.error(err);
    } catch(e) {}

    session.rejectOpened(err);
  };
}

export const http = (fn, hooks) => new HttpProtocol(fn, hooks);
export const httpClient = (fn, hooks) => new HttpClientProtocol(fn, hooks);
export const ws = handlers => new WsProtocol(handlers);
export const client = handlers => new WsClientProtocol(handlers);
export const raw = handlers => new RawProtocol(handlers);
export const stream = opts => new StreamAdapter(opts);
