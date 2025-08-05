import { Body } from './body.js';
import { Headers } from './headers.js';

const redirectStatuses = [301, 302, 303, 307, 308];

export class Response extends Body {
  constructor(bodyInit, options = {}) {
    super();

    this.type = 'default';
    this.status = options.status === undefined ? 200 : options.status;

    if(this.status < 200 || this.status > 599) throw new RangeError('The status provided (0) is outside the range [200, 599].');

    this.ok = this.status >= 200 && this.status < 300;
    this.statusText = options.statusText === undefined ? '' : '' + options.statusText;
    this.headers = new Headers(options.headers);
    this.url = options.url || '';

    Body.init(this, bodyInit);
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
