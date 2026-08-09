import createContext from './lws/context.js';
import { httpClient } from './lws/protocols.js';
import { tlsConnectFlags } from './lws/tls.js';
import { ConnectionError } from './lws/util.js';
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
      if(req) settled.get(req)?.reject(new ConnectionError(err.message));
    },
  },
);

function buildContext(tls) {
  return createContext({
    ...(tls ? { tls } : { options: LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT | LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX | LWS_SERVER_OPTION_IGNORE_MISSING_CERT }),
    protocols: [{ name: 'http', ...adapter }],
  });
}

export function fetch(url, options = {}) {
  const { tls, keepAlive = true, signal, credentials, ...rest } = options;
  const shared = keepAlive && !tls;
  const ctx = shared ? (sharedContext ??= buildContext()) : buildContext(tls);

  rest.ssl_connection ??= 0;
  rest.ssl_connection |= tlsConnectFlags(tls);
  if(keepAlive) rest.ssl_connection |= LCCSCF_PIPELINE;
  if(rest.h2) rest.ssl_connection |= LCCSCF_H2_PRIOR_KNOWLEDGE;
  rest.alpn ??= rest.h2 === false ? 'http/1.1' : 'h2,http/1.1';

  if(credentials === 'include' && cookies.size > 0) {
    const cookieStr = Array.from(cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    rest.headers = rest.headers || {};
    if(typeof rest.headers.append === 'function') {
      rest.headers.append('Cookie', cookieStr);
    } else {
      rest.headers['Cookie'] = rest.headers['Cookie'] ? `${rest.headers['Cookie']}; ${cookieStr}` : cookieStr;
    }
  }

  return new Promise((resolve, reject) => {
    adapter.connect(ctx, url, rest).then(({ req, wsi }) => {
      settled.set(req, { resolve, reject, include: credentials === 'include' });
      rest.pwsi?.(wsi);
      if(signal) signal.onabort = () => wsi.close();
    }, reject);
  });
}
