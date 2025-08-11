import { getCallbackName, LWS_SERVER_OPTION_ONLY_RAW, LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT, LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX, LWS_SERVER_OPTION_IGNORE_MISSING_CERT, LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED, LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT, LCCSCF_USE_SSL, LCCSCF_ALLOW_SELFSIGNED, LCCSCF_SKIP_SERVER_CERT_HOSTNAME_CHECK, LCCSCF_ALLOW_EXPIRED, LCCSCF_ALLOW_INSECURE, } from 'lws';
import createContext from './lws/context.js';
import { EventTarget } from './lws/events.js';

let ctx;

export function TCPSocket(options = {}) {
  const { hostname, port, ...rest } = options;

  let wsi;

  /** @see: https://bun.com/docs/api/fetch#tls */
  const { ca: sslCa, cert: sslCert, key: sslPrivateKey } = tls ?? {};

  ctx ??= createContext({
    options:
      LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT |
      LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX |
      LWS_SERVER_OPTION_IGNORE_MISSING_CERT |
      (tls && 'rejectUnauthorized' in tls && !tls.rejectUnauthorized
        ? LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED | LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT | LWS_SERVER_OPTION_REDIRECT_HTTP_TO_HTTPS
        : 0) |
      LWS_SERVER_OPTION_ONLY_RAW,
    /**/
    sslCa,
    sslCert,
    sslPrivateKey,
    protocols: [
      {
        name: 'tcp',

        callback(wsi, reason, ...args) {
          verbose('\x1b[1;35mtcp\x1b[0m ' + getCallbackName(reason), wsi, args);
        },
      },
    ],
  });

  rest.ssl_connection ??= 0;
  if(tls) rest.ssl_connection |= LCCSCF_USE_SSL;

  wsi = ctx.clientConnect(rest);

  verbose('rest', rest);
}

Object.setPrototypeOf(TCPSocket.prototype, EventTarget.prototype);

function verbose(name, ...args) {
  console.log('\x1b[2K\r' + name.padEnd(32), console.config({ compact: true }), ...args);
}
