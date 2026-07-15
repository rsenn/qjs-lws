/**
 * Express-style middleware chain on top of qjs-lws.
 *
 * Minimal surface — just enough to host a real app:
 *
 *   const app = new App();
 *   app.use(json());
 *   app.use(cors({ origin: '*' }));
 *   app.get('/users/:id', (req, res) => res.json({ id: req.params.id }));
 *   app.listen({ port: 8080 });
 *
 * A handler is `(req, res, next)` or `(err, req, res, next)`. Return a
 * promise (or use async) and await `next()` to chain. Throwing inside a
 * handler is equivalent to calling `next(err)`.
 */

import { LWSContext, LWSMPRO_CALLBACK, LWS_WRITE_HTTP, LWS_WRITE_HTTP_FINAL, toString } from 'lws.so';
import { Headers } from './headers.js';
import { ReadableStream } from './streams.js';

/* ---------------------------------------------------------------- *
 * path matching
 * ---------------------------------------------------------------- */

/**
 * Compile a path pattern into a regex + the list of capture names.
 *
 * - `:name` captures a path segment.
 * - `*` at the end captures the rest.
 * - When `end` is false (mount prefixes), the regex anchors at a `/`
 *   boundary instead of EOL, so `app.use('/api', …)` matches both
 *   `/api` and `/api/users/42`.
 */
export function compilePath(pattern, end = true) {
  if(pattern === '*' || pattern === '/*') return { regex: /^.*/, keys: [] };
  if(pattern === '/' || pattern === '') return { regex: end ? /^\/?$/ : /^\//, keys: [] };

  const keys = [];
  const parts = pattern.split('/').map(seg => {
    if(seg === '') return '';
    if(seg.startsWith(':')) {
      keys.push(seg.slice(1).replace(/[^a-zA-Z0-9_]/g, ''));
      return '([^/]+)';
    }
    if(seg === '*') return '.*';
    return seg.replace(/[.+?^=!${}()|[\]\\]/g, '\\$&');
  });

  const body = parts.join('/');
  const suffix = end ? '/?$' : '(?:/|$)';

  return { regex: new RegExp('^' + body + suffix), keys };
}

/* ---------------------------------------------------------------- *
 * request / response wrappers
 * ---------------------------------------------------------------- */

const decoder = (() => {
  // Stay friendly to qjs builds without TextDecoder.
  try {
    return new TextDecoder('utf-8');
  } catch {
    return null;
  }
})();

function decodeBuf(buf) {
  if(decoder)
    try {
      return decoder.decode(buf);
    } catch {}
  return toString(buf);
}

/**
 * Server-side request. Wraps an `LWSSocket` and exposes:
 *
 *   method, url, originalUrl, path, query, headers, cookies,
 *   params (populated by the matcher), body / rawBody (populated by
 *   body parser middleware), wsi (escape hatch).
 */
export class ServerRequest {
  #cookies;
  #query;
  #bodyPromise;
  #bodyResolve;
  #bodyReject;
  #bodyChunks = [];
  #stream;
  #streamController;

  constructor(wsi) {
    this.wsi = wsi;
    this.method = wsi.method || 'GET';
    this.originalUrl = wsi.uri || '/';

    const q = this.originalUrl.indexOf('?');

    this.path = q < 0 ? this.originalUrl : this.originalUrl.slice(0, q);
    this.url = this.originalUrl;
    this.params = Object.setPrototypeOf({}, null);
    this.headers = wsi.headers || {};

    /* `body` is set by parser middleware; `rawBody` is the buffered bytes. */
    this.body = undefined;
    this.rawBody = undefined;

    this.#bodyPromise = new Promise((resolve, reject) => {
      this.#bodyResolve = resolve;
      this.#bodyReject = reject;
    });
  }

  /** Lazily decoded `?a=1&b=2` query string. */
  get query() {
    if(this.#query) return this.#query;

    const out = Object.setPrototypeOf({}, null);
    const q = this.originalUrl.indexOf('?');

    if(q < 0) return (this.#query = out);

    for(const part of this.originalUrl.slice(q + 1).split('&')) {
      if(!part) continue;

      const eq = part.indexOf('=');
      const k = decodeURIComponent((eq < 0 ? part : part.slice(0, eq)).replace(/\+/g, ' '));
      const v = eq < 0 ? '' : decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' '));

      if(k in out) out[k] = [].concat(out[k], v);
      else out[k] = v;
    }

    return (this.#query = out);
  }

  /** Parsed `Cookie:` header. */
  get cookies() {
    if(this.#cookies) return this.#cookies;

    const out = Object.setPrototypeOf({}, null);
    const h = this.headers['cookie'];

    if(h)
      for(const part of h.split(';')) {
        const eq = part.indexOf('=');
        if(eq < 0) continue;
        const name = part.slice(0, eq).trim();
        const value = part
          .slice(eq + 1)
          .trim()
          .replace(/^"|"$/g, '');
        if(!name || name in out) continue;
        try {
          out[name] = decodeURIComponent(value);
        } catch {
          out[name] = value;
        }
      }

    return (this.#cookies = out);
  }

  /**
   * Resolve with a concatenated ArrayBuffer of the upload body once it
   * has finished arriving. Honour the `limit` (bytes) so the middleware
   * can reject oversized uploads. Used internally by json() / urlencoded().
   */
  readBody(limit = 1 << 20) {
    return this.#bodyPromise.then(() => {
      let total = 0;
      for(const c of this.#bodyChunks) total += c.byteLength;
      if(total > limit) throw new TypeError(`request body exceeds limit of ${limit} bytes`);

      const out = new Uint8Array(total);
      let offset = 0;
      for(const c of this.#bodyChunks) {
        out.set(new Uint8Array(c), offset);
        offset += c.byteLength;
      }
      return (this.rawBody = out.buffer);
    });
  }

  readText(limit) {
    return this.readBody(limit).then(decodeBuf);
  }
  readJson(limit) {
    return this.readText(limit).then(s => (s ? JSON.parse(s) : null));
  }

  /**
   * A `ReadableStream` of the raw body, enqueuing each chunk as it arrives
   * (LWS_CALLBACK_HTTP_BODY) instead of buffering the whole body first like
   * readBody()/readText()/readJson() do - the first chunk is visible as
   * soon as it's read off the socket, not only once the upload completes.
   * Safe to call at any point in the request's lifetime: chunks already
   * buffered (for readBody()'s sake - both share the same underlying
   * `_appendBody()` feed) are replayed first, then it continues live.
   * Only one stream is ever created per request; repeat calls return the
   * same one.
   */
  stream() {
    if(this.#stream) return this.#stream;

    this.#stream = new ReadableStream({
      start: controller => {
        for(const chunk of this.#bodyChunks) controller.enqueue(new Uint8Array(chunk));

        this.#streamController = controller;

        this.#bodyPromise.then(
          () => {
            this.#streamController?.close();
            this.#streamController = undefined;
          },
          err => {
            this.#streamController?.error(err);
            this.#streamController = undefined;
          },
        );
      },
    });

    return this.#stream;
  }

  /* Wired up by App from onHttpBody / onHttpBodyCompletion. */
  _appendBody(buf) {
    if(buf && buf.byteLength) {
      this.#bodyChunks.push(buf);
      this.#streamController?.enqueue(new Uint8Array(buf));
    }
  }
  _closeBody() {
    this.#bodyResolve();
  }
  _failBody(err) {
    this.#bodyReject(err);
  }
}

/**
 * Server-side response. Buffers headers and status until `.end()` /
 * `.send()` / `.json()` flushes them to `wsi.respond(...)` and writes
 * the body via `wsi.write(...)`.
 *
 * After flushing, `headersSent` is true and further header mutations
 * throw.
 */
export class ServerResponse {
  #wsi;
  #headers = new Headers();
  #status = 200;
  #ended = false;
  #headersSent = false;

  constructor(wsi) {
    this.#wsi = wsi;
  }

  get wsi() {
    return this.#wsi;
  }
  get statusCode() {
    return this.#status;
  }
  get headersSent() {
    return this.#headersSent;
  }
  get sent() {
    return this.#ended;
  }
  get headers() {
    return this.#headers;
  }

  status(code) {
    this.#status = code;
    return this;
  }
  set(name, value) {
    this.#assertOpen();
    this.#headers.set(name, value);
    return this;
  }
  append(name, value) {
    this.#assertOpen();
    this.#headers.append(name, value);
    return this;
  }
  setHeader(name, value) {
    return this.set(name, value);
  }
  getHeader(name) {
    return this.#headers.get(name);
  }
  removeHeader(name) {
    this.#assertOpen();
    this.#headers.delete(name);
    return this;
  }
  type(contentType) {
    return this.set('content-type', contentType);
  }

  cookie(name, value, opts = {}) {
    this.#assertOpen();
    const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`];

    if(opts.maxAge != null) parts.push(`Max-Age=${opts.maxAge | 0}`);
    if(opts.domain) parts.push(`Domain=${opts.domain}`);
    if(opts.path) parts.push(`Path=${opts.path}`);
    if(opts.expires) parts.push(`Expires=${(opts.expires instanceof Date ? opts.expires : new Date(opts.expires)).toUTCString()}`);
    if(opts.httpOnly) parts.push('HttpOnly');
    if(opts.secure) parts.push('Secure');
    if(opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);

    this.#headers.append('set-cookie', parts.join('; '));
    return this;
  }

  clearCookie(name, opts = {}) {
    return this.cookie(name, '', { ...opts, expires: new Date(0), maxAge: 0 });
  }

  /** 301/302/303/307/308 redirect. Defaults to 302. */
  redirect(...args) {
    let status = 302;
    let url = args[0];
    if(args.length > 1) {
      status = args[0];
      url = args[1];
    }
    return this.status(status).set('location', url).end();
  }

  json(data) {
    if(!this.#headers.has('content-type')) this.type('application/json; charset=utf-8');
    return this.send(JSON.stringify(data));
  }

  /** Convenience: status + body in one call (string, ArrayBuffer, object, …). */
  send(body) {
    if(this.#ended) return this;

    if(body == null) return this.end();

    if(typeof body === 'object' && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) return this.json(body);

    if(!this.#headers.has('content-type')) this.type(typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/octet-stream');

    return this.end(body);
  }

  /** Stream a chunk. Headers flush on first call. */
  write(chunk) {
    this.#flushHeaders();
    if(chunk != null) this.#wsi.write(chunk, LWS_WRITE_HTTP);
    return this;
  }

  /** Finish the response, optionally with one last body chunk. */
  end(chunk) {
    if(this.#ended) return this;

    this.#flushHeaders();

    if(chunk != null) this.#wsi.write(chunk, LWS_WRITE_HTTP_FINAL);
    else this.#wsi.write('', LWS_WRITE_HTTP_FINAL);

    this.#ended = true;
    return this;
  }

  #flushHeaders() {
    if(this.#headersSent) return;
    this.#headersSent = true;
    this.#wsi.respond(this.#status, this.#headers.toObject());
  }

  #assertOpen() {
    if(this.#headersSent) throw new Error('headers already sent');
  }
}

/* ---------------------------------------------------------------- *
 * the chain itself
 * ---------------------------------------------------------------- */

/* HTTP verbs we expose as shorthand methods. */
const METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'];

class Layer {
  constructor({ method, prefix, regex, keys, handler }) {
    this.method = method; // null for use(), 'GET' etc. otherwise
    this.prefix = prefix; // for stripping mount paths (sub-routers)
    this.regex = regex;
    this.keys = keys;
    this.handler = handler;
    this.isError = handler.length === 4;
  }
}

/**
 * App / Router. Both expose `use`, `get`, `post`, etc. Mount a sub-router
 * with `app.use('/api', router)`.
 */
export class App {
  layers = [];

  use(arg, ...rest) {
    let path = '/',
      handlers = rest;

    if(typeof arg === 'string') {
      path = arg;
    } else {
      handlers = [arg, ...rest];
    }

    for(const h of handlers.flat()) {
      if(h instanceof App) {
        const { regex, keys } = compilePath(path, false);
        this.layers.push(
          new Layer({
            method: null,
            prefix: path,
            regex,
            keys,
            handler: (req, res, next) => {
              const saved = req.path;
              req.path = req.path.slice(path.length) || '/';
              return h
                .dispatch(req, res)
                .then(handled => {
                  req.path = saved;
                  if(!handled) next();
                })
                .catch(err => {
                  req.path = saved;
                  next(err);
                });
            },
          }),
        );
      } else if(typeof h === 'function') {
        const { regex, keys } = compilePath(path, false);
        this.layers.push(new Layer({ method: null, prefix: path, regex, keys, handler: h }));
      }
    }

    return this;
  }

  /**
   * Internal: register a method+path handler.
   */
  _route(method, path, handlers) {
    const { regex, keys } = compilePath(path, true);
    for(const h of handlers.flat()) if(typeof h === 'function') this.layers.push(new Layer({ method, prefix: '/', regex, keys, handler: h }));
    return this;
  }

  /**
   * Run the chain. Resolves to `true` if a handler responded, `false`
   * otherwise — App.listen()'s onHttp uses the latter to emit a 404.
   */
  async dispatch(req, res) {
    const layers = this.layers;
    let i = 0,
      responded = false;

    const next = err => run(err);

    const run = async err => {
      while(i < layers.length) {
        const layer = layers[i++];

        if(layer.method && layer.method !== req.method) continue;

        const m = layer.regex.exec(req.path);
        if(!m) continue;

        for(let k = 0; k < layer.keys.length; k++) req.params[layer.keys[k]] = decodeURIComponent(m[k + 1]);

        if(err && !layer.isError) continue;
        if(!err && layer.isError) continue;

        try {
          let advanced = false;
          const localNext = e => {
            advanced = true;
            return run(e);
          };

          if(err) await layer.handler(err, req, res, localNext);
          else await layer.handler(req, res, localNext);

          if(advanced) return; /* handler chained — run() recursed */
          responded = true; /* handler owned the response */
          return;
        } catch(e) {
          return run(e);
        }
      }

      /* Stack drained. */
      if(err) {
        responded = true;
        if(!res.headersSent)
          res
            .status(500)
            .type('text/plain')
            .end(String(err.stack || err.message || err));
      }
    };

    await run();
    return responded || res.sent;
  }

  /**
   * Spin up an LWSContext, register an `'http'` protocol that pipes
   * onHttp/onHttpBody/onHttpBodyCompletion into the chain, and return
   * the context.
   *
   * `opts` is forwarded to LWSContext (port, vhostName, tls, options,
   * extra mounts, …). Pass `protocols: […]` to register additional
   * non-HTTP protocols (e.g. WebSocket) alongside the chain.
   */
  listen(opts = {}) {
    const requests = new WeakMap();
    const { protocols = [], mounts = [], ...rest } = opts;
    const app = this;

    const ctx = new LWSContext({
      ...rest,
      mounts: [...mounts, { mountpoint: '/', protocol: '__app', originProtocol: LWSMPRO_CALLBACK }],
      protocols: [
        ...protocols,
        {
          name: '__app',
          onHttp: wsi => {
            const req = new ServerRequest(wsi);
            const res = new ServerResponse(wsi);

            req.app = app;

            requests.set(wsi, req);

            /* Synchronously dispatch — for GET requests with no body the
               chain runs immediately; for bodied methods it'll await
               req.readBody() / req.readJson() which is closed below. */
            app
              .dispatch(req, res)
              .then(handled => {
                if(!handled && !res.headersSent) res.status(404).type('text/plain').end('Not Found');
              })
              .catch(err => {
                if(!res.headersSent) {
                  try {
                    res
                      .status(500)
                      .type('text/plain')
                      .end(String(err.stack || err));
                  } catch {}
                }
              });
          },
          onHttpBody: (wsi, buf) => requests.get(wsi)?._appendBody(buf),
          onHttpBodyCompletion: wsi => requests.get(wsi)?._closeBody(),
          onClosedHttp: wsi => requests.delete(wsi),
        },
      ],
    });

    /* Expose the underlying context so middleware (e.g. session) can
       reach LWSContext-level helpers like getRandom(). */
    this.context = ctx;
    return ctx;
  }
}

/* Sugar: app.get / app.post / ... */
for(const m of METHODS)
  App.prototype[m] = function(path, ...handlers) {
    return this._route(m.toUpperCase(), path, handlers);
  };

App.prototype.all = function(path, ...handlers) {
  for(const m of METHODS) this._route(m.toUpperCase(), path, handlers);
  return this;
};

/** Router is just an App without listen() — same surface. */
export const Router = App;
