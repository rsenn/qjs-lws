import { LWSContext, LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT, LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX, LWS_SERVER_OPTION_IGNORE_MISSING_CERT, LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED } from 'lws';
import { EventTarget } from './events.js';

export const CONNECTING = 0;
export const OPEN = 1;
export const CLOSING = 2;
export const CLOSED = 3;

export class WebSocket extends EventTarget {
  #wsi = null;

  constructor(url, protocols) {
    super();

    this.readyState = CONNECTING;

    this.#wsi = (WebSocket.#ctx ??= WebSocket.#createContext()).clientConnect(url, {
      protocol: Array.isArray(protocols) ? protocols.join(',') : 'ws',
      localProtocolName: 'ws',
    });

    const act = {
      state: s => ((this.readyState = s), act),
      event: (type, props = {}) => (this.dispatchEvent(type, { type, target: null, ...props }), act),
    };

    const ctor = WebSocket;

    ctor.#act(this.#wsi, act);
    ctor.#lws(this, this.#wsi);
  }

  close(code, reason) {
    return this.#wsi.close(code, reason);
  }

  send(data) {
    return this.#wsi.write(data);
  }

  get protocol() {
    const { headers } = this.#wsi;

    return headers?.['sec-websocket-protocol'] ?? headers?.[''];
  }

  static #ctx;
  static #lws = mapper();
  static #act = mapper();

  static #createContext(act = wsi => this.#act(wsi)) {
    return new LWSContext({
      asyncDnsServers: ['8.8.8.8', '8.8.4.4', '4.2.2.1'],
      options: LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT | LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX | LWS_SERVER_OPTION_IGNORE_MISSING_CERT | LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED,
      clientSslCa: 'ca.crt',
      clientSslCert: 'localhost.crt',
      clientSslPrivateKey: 'localhost.key',
      protocols: [
        {
          name: 'ws',
          onClientEstablished: wsi => (act(wsi).state(OPEN).event('open'), 0),
          onClientConnectionError: (wsi, error) => (act(wsi).state(CLOSING).event('error', { message: error }), 0),
          onWsPeerInitiatedClose: (wsi, code, reason) => (Object.assign(act(wsi), { code, reason }), 0),
          onClientClosed: (wsi, code = act(wsi).code, reason = act(wsi).reason) => (act(wsi).state(CLOSED).event('close', { code, reason }), 0),
          onClientReceive: (wsi, data, size) => (act(wsi).event('message', { data, size }), 0),
        },
      ],
    });
  }

  static waitWrite(ws) {
    return new Promise((resolve, reject) => this.#lws(ws).wantWrite(resolve));
  }
}

const states = { CONNECTING, OPEN, CLOSING, CLOSED };

define(WebSocket, states);
define(WebSocket.prototype, states);
define(WebSocket.prototype, { binaryType: 'arraybuffer' }, { writable: true });

WebSocket.prototype[Symbol.toStringTag] = 'WebSocket';
WebSocket.prototype.readyState = -1;

function define(obj, props, opts = {}) {
  for(let prop in props) Object.defineProperty(obj, prop, { value: props[prop], ...opts });
  return obj;
}

function mapper(target = new WeakMap()) {
  return (...args) => (args.length > 1 ? target.set(...args) : target.get(...args));
}
