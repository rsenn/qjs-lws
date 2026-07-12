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
import { ReadableStream } from './streams.js';
import { LWS_WRITE_HTTP, LWS_WRITE_HTTP_FINAL } from 'lws.so';

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

  constructor(fn, { headers, html, access, upgrade, auth } = {}) {
    this.#fn = fn;
    this.#headers = headers;
    this.#html = html;
    this.#access = access;
    this.#upgrade = upgrade;
    this.#auth = auth;
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
}

/**
 * HTTP client role: `fn(req: Request, resp: Response)`, once the response
 * status/headers arrive - `resp.body` then streams the rest as it comes in.
 * Unlike `fetch()` (lib/fetch.js), redirects are handed to `fn` as plain 3xx
 * responses rather than being followed automatically.
 *
 * `hooks`:
 *   - `error(req, err)`              - connection/transfer failed
 *   - `redirect(req, url, status)`   - LWS_CALLBACK_CLIENT_HTTP_REDIRECT
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
   * Starts a client HTTP request on `ctx` and returns a promise for the wsi.
   * `options` is the same shape `Request`'s constructor and
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

    return ctx.clientConnect(req.url, { method: req.method, protocol: 'http', local_protocol_name: 'http', ...options });
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

  onClientHttpRedirect = (wsi, url, status) => this.#onRedirect?.(this.#session(wsi)?.req, url, status);

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

export const http = (fn, hooks) => new HttpProtocol(fn, hooks);
export const httpClient = (fn, hooks) => new HttpClientProtocol(fn, hooks);
export const ws = handlers => new WsProtocol(handlers);
export const client = handlers => new WsClientProtocol(handlers);
export const raw = handlers => new RawProtocol(handlers);
