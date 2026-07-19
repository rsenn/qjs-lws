import { Body } from './body.js';
import { Headers } from './headers.js';
import { LWS_WRITE_HTTP, LWS_WRITE_HTTP_FINAL, toArrayBuffer } from 'lws.so';

const redirectStatuses = [301, 302, 303, 307, 308];

/**
 * Builds a `Set-Cookie` header value. Shared by `Response.cookie()` and
 * `ServerResponse.cookie()` below - they differ only in *when* they're
 * allowed to append it (`ServerResponse` refuses once headers are sent).
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

export class Response extends Body {
  constructor(body, options = {}) {
    super(body);

    this.type = 'default';
    this.status = options.status === undefined ? 200 : options.status;

    if(this.status < 200 || this.status > 599) throw new RangeError('The status provided (0) is outside the range [200, 599].');

    this.ok = this.status >= 200 && this.status < 300;
    this.statusText = options.statusText === undefined ? '' : '' + options.statusText;
    this.headers = new Headers(options.headers);
    this.redirected = options.redirected === undefined ? false : !!options.redirected;

    if('url' in options) this.url = options.url;
  }

  static error() {
    const response = new Response(null, { status: 200, statusText: '' });

    response.ok = false;
    response.status = 0;
    response.type = 'error';

    return response;
  }

  static redirect(url, status = 302) {
    if(redirectStatuses.indexOf(status) == -1) throw new RangeError('Invalid status code');

    return new Response(null, { status, headers: { location: url } });
  }

  /**
   * Build a JSON response.
   * Matches the WHATWG `Response.json(data, init)` static.
   *
   * @param  {*}      data    Value to JSON-encode as the body
   * @param  {object} [init]  Same shape as the Response constructor's options
   * @return {Response}
   */
  static json(data, init = {}) {
    const headers = new Headers(init.headers);

    if(!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8');

    return new Response(JSON.stringify(data), { ...init, headers });
  }

  /**
   * Append a Set-Cookie header.
   *
   * @param  {string} name
   * @param  {string} value
   * @param  {object} [opts]   { maxAge, domain, path, expires, httpOnly,
   *                             secure, sameSite }
   * @return {Response}        `this`, for chaining
   */
  cookie(name, value, opts = {}) {
    this.headers.append('set-cookie', buildSetCookie(name, value, opts));
    return this;
  }

  /**
   * Append a Set-Cookie header that expires the named cookie immediately.
   * Forward `path` / `domain` via `opts` so the browser matches the original
   * cookie; `expires` and `maxAge` are forced.
   *
   * @param  {string} name
   * @param  {object} [opts]
   * @return {Response}
   */
  clearCookie(name, opts = {}) {
    return this.cookie(name, '', { ...opts, expires: new Date(0), maxAge: 0 });
  }

  clone() {
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
 * A zero-length chunk is a no-op - it would be indistinguishable from the
 * terminating `0\r\n\r\n` marker, which `ServerResponse.end()` writes
 * separately once the response is actually done.
 */
function writeChunk(wsi, chunk) {
  const len = chunkByteLength(chunk);

  if(len === 0) return;

  wsi.write(`${len.toString(16)}\r\n`, LWS_WRITE_HTTP);
  wsi.write(chunk, LWS_WRITE_HTTP);
  wsi.write('\r\n', LWS_WRITE_HTTP);
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
  #chunked = false;

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

  /**
   * Append a Set-Cookie header.
   *
   * @param  {string} name
   * @param  {string} value
   * @param  {object} [opts]   { maxAge, domain, path, expires, httpOnly,
   *                             secure, sameSite }
   * @return {ServerResponse}  `this`, for chaining
   */
  cookie(name, value, opts = {}) {
    this.#assertOpen();
    this.#headers.append('set-cookie', buildSetCookie(name, value, opts));
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

  /**
   * Stream a chunk. Headers flush on first call - if the body's total
   * length isn't already known at that point (`content-length` not
   * already set), switches to `Transfer-Encoding: chunked` instead, since
   * a genuinely streamed response (more than one `write()` before `end()`)
   * has no length to declare upfront. Without either, a client has no way
   * to detect the end of the response short of the connection closing -
   * see `end()`'s own doc comment for why that's a real problem here.
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
   * Finish the response, optionally with one last body chunk.
   *
   * When nothing was written before this call, the whole body is known
   * upfront - declare Content-Length so HTTP/1.1 clients can tell where
   * the body ends. Without it (and without chunked encoding), a client
   * has no way to detect the end of the response other than the
   * connection closing, which - for a response sent asynchronously,
   * outside of lws's own HTTP callback - can take a long time to happen,
   * making the request appear to hang even though the server already
   * wrote everything.
   *
   * If `write()` already switched to chunked encoding, this last chunk
   * (if any) is framed the same way, followed by the terminating
   * `0\r\n\r\n` marker.
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
   * lws's own lws_add_http_common_headers() (native `wsi.respond()`) only
   * keeps the connection alive for another request when it's given a
   * definite content length up front - without one, it hard-codes
   * `Connection: close` (and marks the wsi accordingly) regardless of what
   * ends up in the headers object below. So the already-known
   * content-length has to be passed as its own numeric argument, not just
   * baked into the headers object, or HTTP/1.1 keep-alive never applies to
   * any response. A response with no content-length yet (the chunked path,
   * ServerResponse.write()) still has none to give it - lws closes the
   * connection after those regardless of any of this.
   */
  #flushHeaders() {
    if(this.#headersSent) return;
    this.#headersSent = true;
    const contentLength = this.#headers.get('content-length');
    this.#wsi.respond(this.#status, contentLength != null ? Number(contentLength) : undefined, this.#headers.toObject());
  }

  #assertOpen() {
    if(this.#headersSent) throw new Error('headers already sent');
  }
}

ServerResponse.prototype[Symbol.toStringTag] = 'ServerResponse';
