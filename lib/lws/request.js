import { Body } from './body.js';
import { Headers } from './headers.js';

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
   * Repeated `Cookie:` entries with the same name keep the first value
   * (matches express / fastify behaviour).
   */
  get cookies() {
    if(this.#cookies) return this.#cookies;

    const out = Object.setPrototypeOf({}, null);
    const header = this.headers?.get?.('cookie');

    if(header)
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

    return (this.#cookies = out);
  }
}

Request.prototype[Symbol.toStringTag] = 'Request';

// HTTP methods whose capitalization should be normalized.
const methods = ['CONNECT', 'DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT', 'TRACE'];

function normalizeMethod(method) {
  const upcased = method.toUpperCase();

  return methods.indexOf(upcased) > -1 ? upcased : method;
}
