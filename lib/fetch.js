import createContext from './lws/context.js';
import { httpClient } from './lws/protocols.js';
import { tlsConnectFlags } from './lws/tls.js';
import { ConnectionError } from './lws/util.js';
import { Request } from './lws/request.js';
import {
  LCCSCF_H2_PRIOR_KNOWLEDGE,
  LCCSCF_PIPELINE,
  LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX,
  LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT,
  LWS_SERVER_OPTION_H2_JUST_FIX_WINDOW_UPDATE_OVERFLOW,
  LWS_SERVER_OPTION_IGNORE_MISSING_CERT,
  runEventLoop,
} from 'lws.so';

let sharedContext;
const cookies = new Map();
const settled = new WeakMap();

const adapter = httpClient(
  (req, resp) => {
    const record = settled.get(req);
    if(record?.include) {
      const setCookie = typeof resp.headers?.get === 'function' ? resp.headers.get('set-cookie') : resp.headers?.['set-cookie'] || resp.headers?.['Set-Cookie'];
      if(setCookie) {
        (Array.isArray(setCookie) ? setCookie : setCookie.split(/,(?=[^;]+(?:;|$))/)).forEach(h => {
          const eq = h.split(';')[0].indexOf('=');
          if(eq !== -1) cookies.set(h.slice(0, eq).trim(), h.slice(eq + 1).trim());
        });
      }
    }
    record?.resolve(resp);
  },
  {
    error: (req, err) => {
      if(req) {
        const record = settled.get(req);
        if(record) {
          // AbortSignal should throw AbortError, not ConnectionError
          const isAbort = record.abortController && record.abortController.signal.aborted;
          if(isAbort) {
            const abortError = new Error('The operation was aborted');
            abortError.name = 'AbortError';
            record.reject(abortError);
          } else {
            // Network errors should be TypeError per WHATWG spec
            const typeError = new TypeError(err.message);
            record.reject(typeError);
          }
        }
      }
    },
  },
);

function buildContext(tls) {
  return createContext({
    ...(tls
      ? { tls }
      : {
          /* Some real servers (confirmed: unpkg.com over h2) send a WINDOW_UPDATE
             whose increment, added to our already-large initial tx credit, exceeds
             HTTP/2's 31-bit max - lws's default response is to RST_STREAM/GOAWAY
             the connection instead of clamping it (http2.c's own WINDOW_UPDATE
             handler), closing every h2 request to such a server. This vhost option
             is lws's own documented opt-in fix: clamp the credit to 0x7fffffff
             instead of erroring. See BUGS: h2-window-update-overflow-closes-connection.

             `+`, not `|`: this flag is bit 31 (1n << 31 == 2147483648), past
             JS's 32-bit bitwise-operator range - `|` first ToInt32()s it to
             -2147483648, and OR-ing that in sign-extends every bit from 31
             up through 63 once it's read back out as an int64 on the native
             side, corrupting the whole options value (confirmed: this
             actually broke plain https fetches entirely, "connect SYSCALL
             9"/EBADF, until switched to `+` here - the flags below don't
             overlap so addition is equivalent to OR without the 32-bit
             truncation). */
          options:
            LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT +
            LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX +
            LWS_SERVER_OPTION_IGNORE_MISSING_CERT +
            LWS_SERVER_OPTION_H2_JUST_FIX_WINDOW_UPDATE_OVERFLOW,
        }),
    protocols: [{ name: 'http', ...adapter }],
  });
}

export function fetch(input, options = {}) {
  // Support Request objects as first argument per WHATWG spec
  let url, requestOptions;
  if(input instanceof Request) {
    url = input.url;
    // Merge Request properties with options (options take precedence)
    requestOptions = {
      method: input.method,
      headers: input.headers,
      body: input._bodyInit,
      credentials: input.credentials,
      mode: input.mode,
      signal: input.signal,
      ...options,
    };
  } else {
    url = input;
    requestOptions = options;
  }

  const { tls, keepAlive = true, signal, credentials, pctx, ...rest } = requestOptions;
  const shared = keepAlive && !tls;
  const ctx = shared ? (sharedContext ??= buildContext()) : buildContext(tls);

  if(typeof pctx === 'function') pctx(ctx);

  rest.sslConnection ??= 0;
  rest.sslConnection |= tlsConnectFlags(tls);
  if(keepAlive) rest.sslConnection |= LCCSCF_PIPELINE;
  if(rest.h2) rest.sslConnection |= LCCSCF_H2_PRIOR_KNOWLEDGE;
  rest.alpn ??= rest.h2 === false ? 'http/1.1' : 'h2,http/1.1';

  if(credentials === 'include' && cookies.size > 0) {
    const cookieStr = Array.from(cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    rest.headers = rest.headers || {};

    if(typeof rest.headers.append === 'function') rest.headers.append('Cookie', cookieStr);
    else rest.headers['Cookie'] = rest.headers['Cookie'] ? `${rest.headers['Cookie']}; ${cookieStr}` : cookieStr;
  }

  return new Promise((resolve, reject) => {
    // Check if signal is already aborted before making request
    if(signal && signal.aborted) {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      reject(abortError);
      return;
    }

    adapter.connect(ctx, url, rest).then(({ req, wsi }) => {
      const record = { resolve, reject, include: credentials === 'include' };
      settled.set(req, record);
      rest.pwsi?.(wsi);

      // Use addEventListener instead of overwriting onabort
      if(signal) {
        const abortController = { signal };
        record.abortController = abortController;
        const abortHandler = () => {
          wsi.close();
          const abortError = new Error('The operation was aborted');
          abortError.name = 'AbortError';
          reject(abortError);
        };
        signal.addEventListener('abort', abortHandler, { once: true });
        record.abortHandler = abortHandler;
      }
    }, reject);
  });
}

/**
 * Blocking variant of fetch() that returns the response body text directly,
 * for call sites that can't await a Promise - e.g. a moduleLoader() "loader"
 * hook (see qjs-modules/lib/module.js), which runs synchronously during
 * `import` resolution, before the runtime's own event loop is pumping.
 *
 * Drives the runtime's event loop itself (via lws.so's runEventLoop(), see
 * its doc comment in lws.c) until the request settles - runEventLoop() only
 * returns once *everything* registered with that event loop has drained,
 * not just this request, so this explicitly destroy()s its own private
 * LWSContext (captured via `pctx`) once settled, rather than leaving it for
 * GC: an LWSContext's internal "system" vhost (async DNS, netlink route
 * monitoring - see createContext()'s doc in lib/lws/context.js) keeps its
 * own sockets and a periodic service tick alive indefinitely on its own,
 * which would otherwise keep runEventLoop() from ever returning even after
 * this one request finishes (confirmed: the request completed in ~60ms but
 * the process hung afterward until destroy() was added here).
 *
 * @param {string} url
 * @param {object} [options] Same options as fetch(), minus keepAlive (always off).
 * @returns {string} Response body text.
 */
export function fetchSync(url, options = {}) {
  let error, text, ctx;

  fetch(url, { ...options, keepAlive: false, pctx: c => (ctx = c) })
    .then(res => {
      if(!res.ok) throw new Error(`fetchSync: HTTP ${res.status} for ${url}`);
      return res.text();
    })
    .then(t => (text = t), e => (error = e))
    .then(() => ctx?.destroy());

  runEventLoop();

  if(error) throw error;
  return text;
}
