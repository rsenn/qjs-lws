import { Body } from './body.js';
import { Headers } from './headers.js';
import { MultipartMixin } from './multipart.js';
import { readableStreamSink } from './stream-utils.js';
import { toString } from 'lws.so';

/**
 * Parses a raw `Cookie:` header value into a null-prototype object mapping
 * name -> decoded value. Repeated names keep the first value (matches
 * express/fastify behaviour). Shared by `Request.cookies` and
 * `ServerRequest.cookies` below - they differ only in how they get the raw
 * header string (a `Headers` instance vs. a plain object).
 */
function parseCookieHeader(header) {
  const out = Object.setPrototypeOf({}, null);

  if(!header) return out;

  for(const part of header.split(';')) {
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

  return out;
}

// HTTP methods whose capitalization should be normalized.
const methods = ['CONNECT', 'DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT', 'TRACE'];

function normalizeMethod(method) {
  const upcased = method.toUpperCase();

  return methods.indexOf(upcased) > -1 ? upcased : method;
}

export class Request extends Body {
  #cookies;

  constructor(input, options = {}) {
    let body = options.body;

    if(input instanceof Request) {
      if(input.bodyUsed) throw new TypeError('Already read');

      // Inherit the original body if the caller didn't override it.
      if(body == null && input._bodyInit != null) {
        body = input._bodyInit;
        input.bodyUsed = true;
      }
    }

    super(body);

    if(input instanceof Request) {
      this.url = input.url;
      this.credentials = input.credentials;

      if(!options.headers) this.headers = new Headers(input.headers);

      this.method = input.method;
      this.mode = input.mode;

      if('signal' in input) this.signal = input.signal;
    } else {
      this.url = String(input);
    }

    this.credentials = options.credentials || this.credentials || 'same-origin';

    if(options.headers || !this.headers) this.headers = new Headers(options.headers);

    // A body carrying its own `.contentType` (e.g. MultipartFormData,
    // ./multipart.js) sets Content-Type automatically, same as a browser
    // does for a FormData body - only when the caller didn't already set
    // one explicitly.
    if(body && typeof body.contentType === 'string' && !this.headers.has('content-type')) this.headers.set('content-type', body.contentType);

    this.method = normalizeMethod(options.method || this.method || 'GET');
    this.mode = options.mode || this.mode || null;
    this.signal = options.signal || this.signal /*|| new AbortController().signal*/;
    this.referrer = null;

    const getOrHead = this.method == 'GET' || this.method == 'HEAD';

    if(getOrHead && body) throw new TypeError(`Failed to construct 'Request': Request with ${this.method} method cannot have body`);

    if(getOrHead) {
      if(options.cache == 'no-store' || options.cache == 'no-cache') {
        // Search for a '_' parameter in the query string
        const reParamSearch = /([?&])_=[^&]*/;

        if(reParamSearch.test(this.url)) {
          // If it already exists then set the value with the current time
          this.url = this.url.replace(reParamSearch, '$1_=' + new Date().getTime());
        } else {
          // Otherwise add a new '_' parameter to the end with the current time
          const reQueryString = /\?/;

          this.url += (reQueryString.test(this.url) ? '&' : '?') + '_=' + new Date().getTime();
        }
      }
    }
  }

  clone() {
    return new Request(this, { body: this._bodyInit ?? this.body });
  }

  /**
   * Parsed `Cookie:` header. Lazily computed on first access and cached.
   * Returns a null-prototype object mapping name → decoded value.
   */
  get cookies() {
    return (this.#cookies ??= parseCookieHeader(this.headers?.get?.('cookie')));
  }
}

Request.prototype[Symbol.toStringTag] = 'Request';

/**
 * Server-side request. Wraps an `LWSSocket` and exposes:
 *
 *   method, url, originalUrl, path, query, headers, cookies,
 *   params (populated by the matcher), wsi (escape hatch).
 *
 * Extends `Body` via `MultipartMixin` (./multipart.js), so
 * `.arrayBuffer()`/`.text()`/`.json()`/`.blob()`/`.formData()` all work
 * directly on the raw request body - `.formData()` transparently handles
 * multipart/form-data too, once `HttpProtocol` (./protocols.js) has called
 * `_startMultipart()` for a request that needs it. `.body` starts out as
 * the raw `ReadableStream`, exactly `Request.body` above, WHATWG-shaped.
 * Body-parser middleware (see middleware.js) then reassigns `.body` to the
 * parsed value once it's read the stream, Express-style; `Body`'s own
 * `.body` is writable for exactly this reason.
 */
export class ServerRequest extends MultipartMixin(Body) {
  #cookies;
  #query;
  #sink;

  constructor(wsi) {
    const [stream, sink] = readableStreamSink();

    super(stream);

    this.#sink = sink;

    this.wsi = wsi;
    this.method = normalizeMethod(wsi.method || 'GET');
    this.headers = wsi.headers || {};

    /* lws splits the request line's URI at '?' itself - wsi.uri is only
       ever the path; the query string arrives separately as the
       synthetic 'uri-args' entry lwsjs_socket_headers() (lws-socket.c)
       folds into wsi.headers. Recombine here so .originalUrl/.query see
       the query string at all. */
    const uriArgs = this.headers['uri-args'];

    this.originalUrl = (wsi.uri || '/') + (uriArgs ? '?' + uriArgs : '');

    const q = this.originalUrl.indexOf('?');

    this.path = q < 0 ? this.originalUrl : this.originalUrl.slice(0, q);
    this.url = this.originalUrl;
    this.params = Object.setPrototypeOf({}, null);

    /* Buffered bytes, once read via readBody()/middleware. */
    this.rawBody = undefined;
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
    return (this.#cookies ??= parseCookieHeader(this.headers['cookie']));
  }

  /**
   * Resolve with a concatenated ArrayBuffer of the upload body once it
   * has finished arriving. Honour the `limit` (bytes) so the middleware
   * can reject oversized uploads. Used internally by json() / urlencoded().
   */
  async readBody(limit = 1 << 20) {
    const buf = await this.arrayBuffer();

    if(buf.byteLength > limit) throw new TypeError(`request body exceeds limit of ${limit} bytes`);

    return (this.rawBody = buf);
  }

  /* Decodes via toString() (native, 'lws.so') - the same primitive Body's
     own .text() uses, rather than a second, parallel TextDecoder path. */
  readText(limit) {
    return this.readBody(limit).then(toString);
  }
  readJson(limit) {
    return this.readText(limit).then(s => (s ? JSON.parse(s) : null));
  }

  /* Wired up by http() (lib/lws/protocols.js) from onHttpBody / onHttpBodyCompletion. */
  _appendBody(buf) {
    if(buf && buf.byteLength) this.#sink.write(buf);
  }
  _closeBody() {
    this.#sink.close();
  }
  _failBody(err) {
    this.#sink.error(err);
  }
}

ServerRequest.prototype[Symbol.toStringTag] = 'ServerRequest';
