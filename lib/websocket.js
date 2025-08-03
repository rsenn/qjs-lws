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

    const act = {};

    act.state = s => ((this.readyState = s), act);
    act.event = (type, props = {}) => (this.dispatchEvent(type, { type, target: null, ...props }), act);

    WebSocket.#mapper(this.#wsi, act);
  }

  close(...args) {
    return this.#wsi.close(...args);
  }
  send(...args) {
    return this.#wsi.write(...args);
  }

  static #createContext() {
    const WS = WebSocket.#mapper;

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
            WS(wsi).state(WebSocket.CONNECTING);
          },
          onEstablishedClientHttp(wsi) {},
          onClientEstablished(wsi) {
            DEBUG('onClientEstablished', wsi);

            WS(wsi).state(WebSocket.OPEN).event('open');
          },
          onClientConnectionError(wsi, error) {
            DEBUG('onClientConnectionError', wsi, error);

            WS(wsi).state(WebSocket.CLOSING).event('error', { message: error });
          },
          onClientClosed(wsi, reason, status) {
            DEBUG('onClientClosed', wsi, code, reason);

            WS(wsi).state(WebSocket.CLOSED).event('close', { code, reason });
          },
          onClientReceive(wsi, data, size) {
            DEBUG('onClientReceive', wsi, { data, size });

            WS(wsi).event('message', { data, size });
          },
          callback(wsi, reason, ...args) {
            DEBUG('ws ' + getCallbackName(reason), wsi, args);
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
