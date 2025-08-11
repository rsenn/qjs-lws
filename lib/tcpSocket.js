import { getCallbackName, LWS_SERVER_OPTION_ONLY_RAW, LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT, LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX, LWS_SERVER_OPTION_IGNORE_MISSING_CERT, LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED, LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT, LCCSCF_USE_SSL, LCCSCF_ALLOW_SELFSIGNED, LCCSCF_SKIP_SERVER_CERT_HOSTNAME_CHECK, LCCSCF_ALLOW_EXPIRED, LCCSCF_ALLOW_INSECURE, } from 'lws';
import createContext from './lws/context.js';
import { verbose } from './lws/util.js';
import { EventTarget } from './lws/events.js';

let ctx;

export function TCPSocket(options = {}) {
  const { hostname: host, port, tls, ...rest } = options;

  let wsi;

  ctx ??= createContext(rest);

  rest.ssl_connection ??= 0;
  if(tls) rest.ssl_connection |= LCCSCF_USE_SSL;
  rest.host = host;
  rest.port = port;

  wsi = ctx.clientConnect(rest);

  verbose('rest', rest);

  const self = new.target ? this : Object.setPrototypeOf({}, TCPSocket.prototype);

  return self;
}

Object.setPrototypeOf(TCPSocket.prototype, EventTarget.prototype);

TCPSocket.prototype[Symbol.toStringTag] = 'TCPSocket';
