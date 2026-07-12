import createContext from './lws/context.js';
import { httpClient } from './lws/protocols.js';
import { ConnectionError, debug } from './lws/util.js';
import {
  LCCSCF_ALLOW_SELFSIGNED,
  LCCSCF_H2_PRIOR_KNOWLEDGE,
  LCCSCF_HTTP_MULTIPART_MIME,
  LCCSCF_PIPELINE,
  LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT,
  LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX,
  LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT,
  LWS_SERVER_OPTION_IGNORE_MISSING_CERT,
  LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED,
  LWS_SERVER_OPTION_REDIRECT_HTTP_TO_HTTPS,
} from 'lws.so';

const log = debug;

/*
 * One context (and the single 'http' protocol registered on it) is reused
 * across calls by default, so LCCSCF_PIPELINE can actually queue (h1) or
 * mux (h2) repeat requests onto an existing connection instead of always
 * opening a new one - the point of a crawler doing many requests to the
 * same host.
 */
let sharedContext;

/*
 * HttpClientProtocol (lib/lws/protocols.js) has no context-specific state of
 * its own - just JS-side WeakMaps keyed by wsi, which are unique regardless
 * of which LWSContext they belong to - so one instance backs every context,
 * shared or not. `settled` maps each call's `req` (the one thing `adapter`'s
 * own callbacks get handed back) to that call's resolve/reject.
 */
const settled = new WeakMap();

const adapter = httpClient(
  (req, resp) => {
    log('established', req.url, resp.status);
    settled.get(req)?.resolve(resp);
  },
  {
    error: (req, err) => {
      log('error', req?.url, err.message);
      if(req) settled.get(req)?.reject(new ConnectionError(err.message));
    },
  },
);

function buildContext(tls) {
  return createContext({
    options: tls
      ? LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT |
        LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX |
        LWS_SERVER_OPTION_IGNORE_MISSING_CERT |
        ('rejectUnauthorized' in tls && !tls.rejectUnauthorized ? LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED | LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT | LWS_SERVER_OPTION_REDIRECT_HTTP_TO_HTTPS : 0)
      : LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT | LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX | LWS_SERVER_OPTION_IGNORE_MISSING_CERT,
    clientSslCa: tls?.ca,
    clientSslCert: tls?.cert,
    clientSslPrivateKey: tls?.key,
    protocols: [{ name: 'http', ...adapter }],
  });
}

/**
 * fetch(url, options) - WHATWG-shaped. `options.keepAlive` (default true)
 * reuses a single shared LWSContext/vhost across calls so LCCSCF_PIPELINE
 * can queue/mux onto an existing connection; pass `keepAlive: false` or a
 * custom `tls` to get an isolated one-off context instead (the previous
 * per-call behaviour). 3xx redirects are followed automatically (see
 * HttpClientProtocol). `options.pwsi(wsi)`, if given, is called once the
 * wsi exists - an escape hatch for inspecting the low-level connection.
 */
export function fetch(url, options = {}) {
  const { tls, keepAlive = true, signal, ...rest } = options;

  const shared = keepAlive && !tls;
  const ctx = shared ? (sharedContext ??= buildContext()) : buildContext(tls);

  rest.ssl_connection ??= 0;
  rest.ssl_connection |= LCCSCF_ALLOW_SELFSIGNED;
  if(keepAlive) rest.ssl_connection |= LCCSCF_PIPELINE;
  if(rest.h2) rest.ssl_connection |= LCCSCF_H2_PRIOR_KNOWLEDGE;
  if((rest.method ?? (rest.body != null ? 'POST' : 'GET')).toUpperCase() == 'POST') rest.ssl_connection |= LCCSCF_HTTP_MULTIPART_MIME;
  rest.alpn ??= rest.h2 === false ? 'http/1.1' : 'h2,http/1.1';

  log('rest', rest);

  return new Promise((resolve, reject) => {
    adapter.connect(ctx, url, rest).then(({ req, wsi }) => {
      settled.set(req, { resolve, reject });
      rest.pwsi?.(wsi);

      if(signal) signal.onabort = () => wsi.close();
    }, reject);
  });
}
