import { Body } from './body.js';
import { Headers } from './headers.js';

const redirectStatuses = [301, 302, 303, 307, 308];

export class Response extends Body {
  constructor(body, options = {}) {
    super(body);

    this.type = 'default';
    this.status = options.status === undefined ? 200 : options.status;

    if(this.status < 200 || this.status > 599) throw new RangeError('The status provided (0) is outside the range [200, 599].');

    this.ok = this.status >= 200 && this.status < 300;
    this.statusText = options.statusText === undefined ? '' : '' + options.statusText;
    this.headers = new Headers(options.headers);

    if('url' in options) this.url = options.url;
  }

  static error() {
    const response = new Response(null, { status: 200, statusText: '' });

    response.ok = false;
    response.status = 0;
    response.type = 'error';

    return response;
  }

  static redirect(url, status) {
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
    const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`];

    if(opts.maxAge != null) parts.push(`Max-Age=${opts.maxAge | 0}`);
    if(opts.domain)         parts.push(`Domain=${opts.domain}`);
    if(opts.path)           parts.push(`Path=${opts.path}`);
    if(opts.expires)        parts.push(`Expires=${(opts.expires instanceof Date ? opts.expires : new Date(opts.expires)).toUTCString()}`);
    if(opts.httpOnly)       parts.push('HttpOnly');
    if(opts.secure)         parts.push('Secure');
    if(opts.sameSite)       parts.push(`SameSite=${opts.sameSite}`);

    this.headers.append('set-cookie', parts.join('; '));
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
    const { status, statusText, headers, url, _bodyInit } = this;

    return new Response(_bodyInit, {
      status,
      statusText,
      headers: new Headers(headers),
      url,
    });
  }
}

Response.prototype[Symbol.toStringTag] = 'Response';
