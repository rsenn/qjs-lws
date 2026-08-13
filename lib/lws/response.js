import { Body } from './body.js';
import { Headers } from './headers.js';
import { LWS_WRITE_HTTP, LWS_WRITE_HTTP_FINAL, toArrayBuffer } from 'lws.so';

const redirectStatuses = [301, 302, 303, 307, 308];

/**
 * Builds a `Set-Cookie` header value. Used by ServerResponse.cookie().
 */
function buildSetCookie(name, value, opts = {}) {
  const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`];

  if(opts.maxAge != null) parts.push(`Max-Age=${opts.maxAge | 0}`);
  if(opts.domain) parts.push(`Domain=${opts.domain}`);
  if(opts.path) parts.push(`Path=${opts.path}`);
  if(opts.expires) parts.push(`Expires=${(opts.expires instanceof Date ? opts.expires : new Date(opts.expires)).toUTCString()}`);
  if(opts.httpOnly) parts.push('HttpOnly');
  if(opts.secure) parts.push('Secure');
  if(opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);

  return parts.join('; ');
}

/**
 * WHATWG Response - immutable, declarative, fetch-oriented.
 * Used by fetch() clients and serve() fetch handlers.
 * Follows the Fetch API spec: https://fetch.spec.whatwg.org/#response-class
 */
export class Response extends Body {
  #status;
  #statusText;
  #headers;
  #type;
  #url;
  #redirected;

  constructor(body, options = {}) {
    super(body);

    this.#type = 'default';
    const status = options.status === undefined ? 200 : options.status;

    // Allow status 0 for Response.error() (network error)
    if(status !== 0 && (status < 200 || status > 599)) throw new RangeError(`The status provided (${status}) is outside the range [200, 599].`);

    this.#status = status;
    this.#statusText = options.statusText === undefined ? '' : '' + options.statusText;
    this.#headers = new Headers(options.headers);
    this.#redirected = options.redirected === undefined ? false : !!options.redirected;
    this.#url = options.url === undefined ? '' : options.url;
  }

  // Readonly properties per WHATWG spec
  get type() {
    return this.#type;
  }
  get url() {
    return this.#url;
  }
  get redirected() {
    return this.#redirected;
  }
  get status() {
    return this.#status;
  }
  get ok() {
    return this.#status >= 200 && this.#status < 300;
  }
  get statusText() {
    return this.#statusText;
  }
  get headers() {
    return this.#headers;
  }

  /**
   * @deprecated Use `status` instead. Kept for backward compatibility.
   */
  get statusCode() {
    return this.#status;
  }

  static error() {
    const response = new Response(null, { status: 0, statusText: '' });
    // Network error response has type 'error' per WHATWG spec
    // We need to set this after construction since type is normally readonly
    response.#type = 'error';
    return response;
  }

  static redirect(url, status = 302) {
    if(redirectStatuses.indexOf(status) == -1) throw new RangeError('Invalid status code');
    return new Response(null, { status, headers: { location: url } });
  }

  static json(data, init = {}) {
    const headers = new Headers(init.headers);
    if(!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(data), { ...init, headers });
  }

  clone() {
    if(this.bodyUsed) throw new TypeError('Body already used');
    const { status, statusText, headers, url, redirected, _bodyInit } = this;
    return new Response(_bodyInit, {
      status,
      statusText,
      headers: new Headers(headers),
      url,
      redirected,
    });
  }
}

Response.prototype[Symbol.toStringTag] = 'Response';

function chunkByteLength(chunk) {
  return typeof chunk === 'string' ? toArrayBuffer(chunk).byteLength : chunk.byteLength;
}

/**
 * Writes one HTTP chunked-encoding segment (`<hex-length>\r\n<data>\r\n`).
 */
function writeChunk(wsi, chunk) {
  const len = chunkByteLength(chunk);
  if(len === 0) return;
  wsi.write(`${len.toString(16)}\r\n`, LWS_WRITE_HTTP);
  wsi.write(chunk, LWS_WRITE_HTTP);
  wsi.write('\r\n', LWS_WRITE_HTTP);
}

/**
 * ServerResponse - mutable, imperative, streaming-oriented.
 * Used by Express-style middleware (app.js, middleware.js).
 * Follows Express API conventions with chainable methods.
 * 
 * Does NOT extend Response. Instead, serve.js's flush() bridges between
 * the two: fetch handlers return Response, middleware uses ServerResponse.
 */
export class ServerResponse {
  #wsi;
  #headers = new Headers();
  #status = 200;
  #ended = false;
  #headersSent = false;
  #chunked = false;

  constructor(wsi) {
    this.#wsi = wsi;
  }

  // Property accessors
  get wsi() {
    return this.#wsi;
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

  /**
   * HTTP status code. Getter/setter for the numeric value.
   * Use `status(code)` method for chainable setting.
   */
  get statusCode() {
    return this.#status;
  }
  set statusCode(value) {
    this.#status = value;
  }

  /**
   * Set the status code. Chainable, Express-style.
   * @param  {number}   code
   * @return {ServerResponse} `this`, for chaining
   */
  status(code) {
    this.#status = code;
    return this;
  }

  /**
   * Set a header. Chainable.
   */
  set(name, value) {
    this.#assertOpen();
    this.#headers.set(name, value);
    return this;
  }

  /**
   * Append to a header. Chainable.
   */
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

  /**
   * Set Content-Type header. Chainable.
   */
  type(contentType) {
    return this.set('content-type', contentType);
  }

  /**
   * Append a Set-Cookie header. Chainable.
   */
  cookie(name, value, opts = {}) {
    this.#assertOpen();
    this.#headers.append('set-cookie', buildSetCookie(name, value, opts));
    return this;
  }

  /**
   * Append a Set-Cookie header that expires the named cookie immediately. Chainable.
   */
  clearCookie(name, opts = {}) {
    return this.cookie(name, '', { ...opts, expires: new Date(0), maxAge: 0 });
  }

  /**
   * 301/302/303/307/308 redirect. Defaults to 302. Chainable.
   */
  redirect(...args) {
    let status = 302;
    let url = args[0];
    if(args.length > 1) {
      status = args[0];
      url = args[1];
    }
    return this.status(status).set('location', url).end();
  }

  /**
   * Send JSON response. Chainable.
   */
  json(data) {
    if(!this.#headers.has('content-type')) this.type('application/json; charset=utf-8');
    return this.send(JSON.stringify(data));
  }

  /**
   * Convenience: status + body in one call. Chainable.
   */
  send(body) {
    if(this.#ended) return this;
    if(body == null) return this.end();
    if(typeof body === 'object' && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) return this.json(body);
    if(!this.#headers.has('content-type')) this.type(typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/octet-stream');
    return this.end(body);
  }

  /**
   * Stream a chunk. Chainable.
   * Headers flush on first call - switches to chunked encoding if no content-length.
   */
  write(chunk) {
    if(!this.#headersSent && !this.#headers.has('content-length') && !this.#headers.has('transfer-encoding')) {
      this.#chunked = true;
      this.#headers.set('transfer-encoding', 'chunked');
    }

    this.#flushHeaders();

    if(chunk != null) {
      if(this.#chunked) writeChunk(this.#wsi, chunk);
      else this.#wsi.write(chunk, LWS_WRITE_HTTP);
    }

    return this;
  }

  /**
   * Finish the response, optionally with one last body chunk. Chainable.
   */
  end(chunk) {
    if(this.#ended) return this;

    if(!this.#headersSent && !this.#headers.has('content-length')) {
      const len = chunk == null ? 0 : chunkByteLength(chunk);
      this.#headers.set('content-length', String(len));
    }

    this.#flushHeaders();

    if(this.#chunked) {
      if(chunk != null) writeChunk(this.#wsi, chunk);
      this.#wsi.write('0\r\n\r\n', LWS_WRITE_HTTP_FINAL);
    } else if(chunk != null) {
      this.#wsi.write(chunk, LWS_WRITE_HTTP_FINAL);
    } else {
      this.#wsi.write('', LWS_WRITE_HTTP_FINAL);
    }

    this.#ended = true;
    return this;
  }

  /**
   * Flush headers to the underlying wsi.
   * Called automatically by write() and end().
   */
  #flushHeaders() {
    if(this.#headersSent) return;
    this.#headersSent = true;
    const contentLength = this.#headers.get('content-length');
    const headers = this.#headers.toObject();

    // Remove content-length from headers object - lws_add_http_common_headers writes it
    if(contentLength != null) delete headers['content-length'];

    // Pass status and content-length (if known) to wsi.respond
    if(contentLength != null) this.#wsi.respond(this.#status, Number(contentLength), headers);
    else this.#wsi.respond(this.#status, headers);
  }

  #assertOpen() {
    if(this.#headersSent) throw new Error('headers already sent');
  }
}

ServerResponse.prototype[Symbol.toStringTag] = 'ServerResponse';
