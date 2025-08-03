import { EventTarget } from './events.js';
import { LWSContext, LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT, LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX, LWS_SERVER_OPTION_IGNORE_MISSING_CERT, LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED, getCallbackName, } from 'lws';

export class WebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static #context = null;
  static #mapper = (
    (map = new WeakMap()) =>
    (wsi, ws) =>
      ws ? (map.set(wsi, ws), ws) : map.get(wsi)
  )();

  #wsi = null;
  readyState = undefined;

  constructor(url, protocols = []) {
    super();

    const cx = (WebSocket.#context ??= WebSocket.#createContext());

    this.#wsi = cx.clientConnect(url, {
      protocol: Array.isArray(protocols) ? protocols.join(',') : protocols + '',
      localProtocolName: 'ws',
    });

    WebSocket.#mapper(this.#wsi, this);
  }

  close(...args) {
    return this.#wsi.close(...args);
  }
  send(...args) {
    return this.#wsi.write(...args);
  }

  static #createContext() {
    const map = WebSocket.#mapper;

    return new LWSContext({
      asyncDnsServers: ['8.8.8.8', '8.8.4.4', '4.2.2.1'],
      options: LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT | LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX | LWS_SERVER_OPTION_IGNORE_MISSING_CERT | LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED,
      cientSslCaFilepath: 'ca.crt',
      clientSslCertFilepath: 'localhost.crt',
      clientSslPrivateKeyFilepath: 'localhost.key',
      protocols: [
        {
          name: 'ws',
          onConnecting(wsi) {
            const ws = map(wsi);
            ws.readyState = WebSocket.CONNECTING;
          },
          onEstablishedClientHttp(wsi) {},
          onClientEstablished(wsi) {
            const ws = map(wsi);
            DEBUG('onClientEstablished', { wsi, ws });
            ws.readyState = WebSocket.OPEN;
            ws.dispatchEvent('open', { type: 'open', target: null });
          },
          onClientConnectionError(wsi, error) {
            const ws = map(wsi);
            DEBUG('onClientConnectionError', { wsi, ws }, error);
            ws.readyState = WebSocket.CLOSING;
            ws.dispatchEvent('error', { type: 'error', target: null, message: error });
          },
          onClientClosed(wsi, reason, status) {
            const ws = map(wsi);
            DEBUG('onClientClosed', { wsi, ws }, code, reason);
            ws.readyState = WebSocket.CLOSED;
            ws.dispatchEvent('close', { type: 'close', target: null, code, reason });
          },
          onClientReceive(wsi, data, size) {
            const ws = map(wsi);
            DEBUG('onClientReceive', { wsi, ws }, { data, size });
            ws.dispatchEvent('message', { type: 'message', target: null, data });
          },
          callback(wsi, reason, ...args) {
            const ws = map(wsi);
            DEBUG('ws ' + getCallbackName(reason), { wsi, ws }, args);
          },
        },
      ],
    });
  }
}

WebSocket.prototype[Symbol.toStringTag] = 'WebSocket';

function DEBUG(n, ...args) {
  /* const cc = n.indexOf(' ') == -1 ? 33 : 35;
  const colorize = s => `\x1b[1;${cc}m${s}\x1b[0m`;

  console.log(colorize(n), console.config({ compact: true, maxArrayLength: 32 }), ...args);*/
}
