import createContext from './lws/context.js';
import { httpClient } from './lws/protocols.js';
import { tlsConnectFlags } from './lws/tls.js';
import { ConnectionError } from './lws/util.js';
import { Request } from './lws/request.js';
import { LCCSCF_H2_PRIOR_KNOWLEDGE, LCCSCF_PIPELINE, LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX, LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT, LWS_SERVER_OPTION_IGNORE_MISSING_CERT } from 'lws.so';

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
    ...(tls ? { tls } : { options: LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT | LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX | LWS_SERVER_OPTION_IGNORE_MISSING_CERT }),
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

    if(typeof rest.headers.append === 'function')
      rest.headers.append('Cookie', cookieStr);
     else
      rest.headers['Cookie'] = rest.headers['Cookie'] ? `${rest.headers['Cookie']}; ${cookieStr}` : cookieStr;
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
