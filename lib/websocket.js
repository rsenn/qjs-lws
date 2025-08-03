import { EventTarget } from './events.js';
import { LWSContext, LWSSocket, LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT, LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX, LWS_SERVER_OPTION_IGNORE_MISSING_CERT, LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED, LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT, getCallbackName, } from 'lws';

const mapper = (
  (map = new WeakMap()) =>
  (wsi, ws) =>
    ws ? (map.set(wsi, ws), ws) : map.get(wsi)
)();

export class WebSocket extends EventTarget {
  static #context = null;

  #wsi = null;

  constructor(url, protocols = []) {
    super();

    const ctx = (WebSocket.#context ??= createContext());

    const wsi = (this.#wsi = ctx.clientConnect(url));

    mapper(wsi, this);

    console.log('WebSocket.constructor', console.config({ compact: true }), { ctx, wsi });
  }

  close() {}
  send(data) {}
}

WebSocket.prototype[Symbol.toStringTag] = 'WebSocket';

function log(n, ...args) {
  const c = s => `\x1b[1;35m${s}\x1b[0m`;

  console.log(c(n), console.config({ compact: true, maxArrayLength: 32 }), ...args);
}

function createContext() {
  return new LWSContext({
    asyncDnsServers: ['8.8.8.8', '8.8.4.4', '4.2.2.1'],
    options:
      LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT |
      LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX |
      LWS_SERVER_OPTION_IGNORE_MISSING_CERT |
      LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED |
      LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT,
    cientSslCaFilepath: 'ca.crt',
    clientSslCertFilepath: 'localhost.crt',
    clientSslPrivateKeyFilepath: 'localhost.key',
    protocols: [
      {
        name: 'ws',
        onClientEstablished(wsi) {
          mapper(wsi).dispatchEvent('open', { type: 'open', target: null });
        },
        onClientConnectionError(wsi, error) {
          mapper(wsi).dispatchEvent('error', { type: 'error', target: null, message: error });
        },
        onClientClosed(wsi, reason, status) {
          mapper(wsi).dispatchEvent('close', { type: 'close', target: null, reason, status });
        },
        onClientReceive(wsi, data) {
          mapper(wsi).dispatchEvent('message', { type: 'message', target: null, data });
        },
        callback(wsi, reason, ...args) {
          globalThis.wsi = wsi;

          log('ws ' + getCallbackName(reason), wsi, args);

          // return 0;
        },
      },
    ],
  });
}
