/**
 * Built-in middleware for App / Router from app.js.
 *
 * Each export is a factory that returns an async (req, res, next) handler.
 * Compose freely:
 *
 *   app.use(logger());
 *   app.use(cors({ origin: '*' }));
 *   app.use(json({ limit: 1 << 16 }));
 *   app.use(urlencoded());
 */

/* ---------------------------------------------------------------- *
 * JSON body parser
 * ---------------------------------------------------------------- */

/**
 * Populates `req.body` with the parsed JSON value when the request
 * Content-Type matches. Bodies above `opts.limit` (default 1 MiB) reject
 * with HTTP 413.
 *
 * @param  {object} [opts]   { limit, type, strict }
 *   - limit: maximum body size in bytes
 *   - type:  RegExp matched against Content-Type (default /^application\/(?:.+\+)?json/i)
 *   - strict: require body to start with `{` or `[` (default true)
 */
export function json(opts = {}) {
  const limit = opts.limit ?? 1 << 20;
  const re = opts.type ?? /^application\/(?:.+\+)?json/i;
  const strict = opts.strict !== false;

  return async function jsonBody(req, res, next) {
    const ct = req.headers['content-type'] || '';
    if(!re.test(ct)) return next();

    try {
      const text = await req.readText(limit);
      if(!text) {
        req.body = null;
        return next();
      }

      if(strict) {
        const first = text.trimStart()[0];
        if(first !== '{' && first !== '[') throw new SyntaxError('strict JSON: body must start with { or [');
      }

      req.body = JSON.parse(text);
    } catch(e) {
      if(/limit/.test(e.message)) {
        res.status(413).type('text/plain').end('Payload Too Large');
        return;
      }
      res.status(400).type('text/plain').end(`Bad JSON: ${e.message}`);
      return;
    }

    return next();
  };
}

/* ---------------------------------------------------------------- *
 * application/x-www-form-urlencoded
 * ---------------------------------------------------------------- */

/**
 * Populates `req.body` with parsed form fields. Repeated keys become
 * arrays. Use `extended` to allow `?a[]=1&a[]=2` shaped keys (not yet
 * implemented — kept for express signature compatibility).
 *
 * @param  {object} [opts]   { limit, type }
 */
export function urlencoded(opts = {}) {
  const limit = opts.limit ?? 1 << 20;
  const re = opts.type ?? /^application\/x-www-form-urlencoded/i;

  return async function urlencodedBody(req, res, next) {
    const ct = req.headers['content-type'] || '';
    if(!re.test(ct)) return next();

    try {
      const text = await req.readText(limit);
      const out = Object.setPrototypeOf({}, null);

      if(text)
        for(const part of text.split('&')) {
          if(!part) continue;
          const eq = part.indexOf('=');
          const k = decodeURIComponent((eq < 0 ? part : part.slice(0, eq)).replace(/\+/g, ' '));
          const v = eq < 0 ? '' : decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' '));
          if(k in out) out[k] = [].concat(out[k], v);
          else out[k] = v;
        }

      req.body = out;
    } catch(e) {
      if(/limit/.test(e.message)) {
        res.status(413).type('text/plain').end('Payload Too Large');
        return;
      }
      res.status(400).type('text/plain').end(`Bad form data: ${e.message}`);
      return;
    }

    return next();
  };
}

/* ---------------------------------------------------------------- *
 * raw / text — convenience wrappers
 * ---------------------------------------------------------------- */

/** Buffer the body as an ArrayBuffer and expose as `req.body`. */
export function raw(opts = {}) {
  const limit = opts.limit ?? 1 << 20;
  const re = opts.type ?? /.*/;

  return async function rawBody(req, res, next) {
    const ct = req.headers['content-type'] || '';
    if(!re.test(ct)) return next();
    try {
      req.body = await req.readBody(limit);
    } catch(e) {
      res.status(413).type('text/plain').end('Payload Too Large');
      return;
    }
    return next();
  };
}

/** Buffer the body as text and expose as `req.body`. */
export function text(opts = {}) {
  const limit = opts.limit ?? 1 << 20;
  const re = opts.type ?? /^text\//i;

  return async function textBody(req, res, next) {
    const ct = req.headers['content-type'] || '';
    if(!re.test(ct)) return next();
    try {
      req.body = await req.readText(limit);
    } catch(e) {
      res.status(413).type('text/plain').end('Payload Too Large');
      return;
    }
    return next();
  };
}

/* ---------------------------------------------------------------- *
 * cookies — already lazy on ServerRequest, this is express compat
 * ---------------------------------------------------------------- */

/**
 * No-op kept for compatibility with code that explicitly mounts a
 * cookie-parser. `req.cookies` is populated lazily on first access
 * regardless of whether this middleware is installed.
 */
export function cookies() {
  return function cookieParser(req, res, next) {
    void req.cookies;
    return next();
  };
}

/* ---------------------------------------------------------------- *
 * CORS
 * ---------------------------------------------------------------- */

/**
 * CORS middleware.
 *
 * @param  {object} [opts]
 *   - origin:     string | string[] | RegExp | (origin, req) => string|true|false (default '*')
 *   - methods:    string | string[] (default 'GET,HEAD,PUT,PATCH,POST,DELETE')
 *   - allowedHeaders:  string | string[] (default mirrors Access-Control-Request-Headers)
 *   - exposedHeaders:  string | string[]
 *   - credentials:     boolean
 *   - maxAge:          number (seconds)
 *   - optionsSuccessStatus: number (default 204)
 */
export function cors(opts = {}) {
  const origin = opts.origin ?? '*';
  const methods = arr(opts.methods ?? 'GET,HEAD,PUT,PATCH,POST,DELETE').join(',');
  const allowedHeaders = opts.allowedHeaders ? arr(opts.allowedHeaders).join(',') : null;
  const exposedHeaders = opts.exposedHeaders ? arr(opts.exposedHeaders).join(',') : null;
  const credentials = opts.credentials === true;
  const maxAge = opts.maxAge != null ? String(opts.maxAge) : null;
  const okStatus = opts.optionsSuccessStatus ?? 204;

  return async function corsMiddleware(req, res, next) {
    const reqOrigin = req.headers['origin'];
    const allow = matchOrigin(origin, reqOrigin, req);

    if(allow !== false && allow !== null) {
      res.set('access-control-allow-origin', allow === true ? reqOrigin || '*' : allow);
      if(allow !== '*') res.append('vary', 'Origin');
      if(credentials) res.set('access-control-allow-credentials', 'true');
      if(exposedHeaders) res.set('access-control-expose-headers', exposedHeaders);
    }

    if(req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
      res.set('access-control-allow-methods', methods);
      const reqHeaders = allowedHeaders ?? req.headers['access-control-request-headers'];
      if(reqHeaders) res.set('access-control-allow-headers', reqHeaders);
      if(maxAge) res.set('access-control-max-age', maxAge);
      res.set('content-length', '0');
      res.status(okStatus).end();
      return;
    }

    return next();
  };
}

function matchOrigin(spec, reqOrigin, req) {
  if(spec === '*') return '*';
  if(spec === true) return reqOrigin || '*';
  if(spec === false || spec == null) return null;
  if(typeof spec === 'string') return spec === reqOrigin ? spec : false;
  if(Array.isArray(spec)) return spec.includes(reqOrigin) ? reqOrigin : false;
  if(spec instanceof RegExp) return spec.test(reqOrigin) ? reqOrigin : false;
  if(typeof spec === 'function') return spec(reqOrigin, req);
  return false;
}

function arr(v) {
  return Array.isArray(v) ? v : String(v).split(/\s*,\s*/);
}

/* ---------------------------------------------------------------- *
 * Logger (morgan-ish)
 * ---------------------------------------------------------------- */

/**
 * Request logger. Default format is morgan's `tiny`:
 *   "GET /foo 200 12 - 1.234 ms"
 *
 * Pass a function `(entry) => void` to capture entries programmatically
 * — `entry` has { method, url, status, length, durationMs, req, res }.
 *
 * @param  {string|Function} [format]   'tiny' | 'common' | sink fn
 */
export function logger(format = 'tiny') {
  const sink = typeof format === 'function' ? format : null;
  const fmt = sink ? null : format === 'common' ? formatCommon : formatTiny;

  return async function loggerMiddleware(req, res, next) {
    const t0 = Date.now();

    try {
      await next();
    } finally {
      const durationMs = Date.now() - t0;
      const length = Number(res.getHeader('content-length') || 0);
      const entry = { method: req.method, url: req.originalUrl, status: res.statusCode, length, durationMs, req, res };

      if(sink) sink(entry);
      else console.log(fmt(entry));
    }
  };
}

function formatTiny({ method, url, status, length, durationMs }) {
  return `${method} ${url} ${status} ${length || '-'} - ${durationMs.toFixed(3)} ms`;
}

function formatCommon({ method, url, status, length, req }) {
  const date = new Date().toISOString();
  const ip = req.wsi?.peer?.host || '-';
  return `${ip} - - [${date}] "${method} ${url} HTTP/1.1" ${status} ${length || '-'}`;
}

/* ---------------------------------------------------------------- *
 * Helmet-ish security headers
 * ---------------------------------------------------------------- */

/**
 * Set a sensible default bundle of security headers. Override or
 * disable individual headers by passing `false` / a custom value in
 * `opts`.
 *
 * @param  {object} [opts]
 */
export function secure(opts = {}) {
  const headers = {
    'x-content-type-options': opts['x-content-type-options'] ?? 'nosniff',
    'x-frame-options': opts['x-frame-options'] ?? 'SAMEORIGIN',
    'x-xss-protection': opts['x-xss-protection'] ?? '0',
    'referrer-policy': opts['referrer-policy'] ?? 'no-referrer',
    'strict-transport-security': opts['strict-transport-security'] ?? 'max-age=15552000; includeSubDomains',
  };

  return function secureMiddleware(req, res, next) {
    for(const [k, v] of Object.entries(headers)) if(v !== false && v != null && !res.headers.has(k)) res.set(k, v);
    return next();
  };
}
