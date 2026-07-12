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

/** HTTP server role: `fn(req: ServerRequest, resp: ServerResponse)`, once per request. */
export class HttpProtocol {
  #fn;
  #requests = new WeakMap();

  constructor(fn) {
    this.#fn = fn;
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
}

/**
 * HTTP client role: `fn(req: Request, resp: Response)`, once the response
 * status/headers arrive - `resp.body` then streams the rest as it comes in.
 * Unlike `fetch()` (lib/fetch.js), redirects are handed to `fn` as plain 3xx
 * responses rather than being followed automatically.
 */
export class HttpClientProtocol {
  #fn;
  #onError;
  #pending;
  #sessions = new WeakMap();

  constructor(fn, onError) {
    this.#fn = fn;
    this.#onError = onError;
  }

  /**
   * Starts a client HTTP request on `ctx` and returns the wsi. `options` is
   * the same shape `Request`'s constructor and `LWSContext#clientConnect`
   * both accept (method, headers, body, ...).
   */
  connect(ctx, url, options = {}) {
    const req = new Request(url, options);
    let controller;
    const resp = new Response(new ReadableStream({ start: c => (controller = c) }), {});

    this.#pending = { req, resp, controller };

    return ctx.clientConnect(req.url, { method: req.method, protocol: 'http', localProtocolName: 'http', ...options });
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

  onClientAppendHandshakeHeader = (wsi, buf, len) => {
    const session = this.#session(wsi);

    if(session) for(const [name, value] of session.req.headers) wsi.addHeader(name, value, buf, len);
  };

  onEstablishedClientHttp = (wsi, status) => {
    const session = this.#session(wsi);
    if(!session) return;

    session.resp.status = status;
    session.resp.headers = new Headers(wsi.headers);
    session.established = true;
    this.#fn(session.req, session.resp);
  };

  onReceiveClientHttp = wsi => {
    const session = this.#session(wsi);
    if(!session) return;

    const buf = new ArrayBuffer(0xff0 * 16);
    let n;

    try {
      n = wsi.httpClientRead(buf);
    } catch(e) {
      return;
    }

    if(n) session.controller.enqueue(new Uint8Array(buf));
  };

  onCompletedClientHttp = wsi => {
    const session = this.#session(wsi);
    if(session) {
      session.completed = true;
      session.controller.close();
    }
  };

  onClosedClientHttp = wsi => {
    const session = this.#session(wsi);
    this.#sessions.delete(wsi);

    if(!session) return;

    if(!session.established) this.#onError?.(session.req, new Error('closed'));
    else if(!session.completed)
      try {
        session.controller.error(new Error('closed'));
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

export const http = fn => new HttpProtocol(fn);
export const httpClient = (fn, onError) => new HttpClientProtocol(fn, onError);
export const ws = handlers => new WsProtocol(handlers);
export const client = handlers => new WsClientProtocol(handlers);
export const raw = handlers => new RawProtocol(handlers);
