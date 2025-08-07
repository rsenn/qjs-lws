import { LWSContext, LLL_USER, logLevel, LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT, LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX, LWS_SERVER_OPTION_IGNORE_MISSING_CERT, LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED, getCallbackName, } from 'lws';
import { EventTarget } from './events.js';

//logLevel((LLL_USER << 1) - 1);

export const CONNECTING = 0;
export const OPEN = 1;
export const CLOSING = 2;
export const CLOSED = 3;

function Mapper(target = new WeakMap()) {
  return define((...args) => (args.length <= 1 ? target.get(...args) : target.set(...args)), { target, set: (k, v) => target.set(k, v), get: k => target.get(k) });
}

export class WebSocket extends EventTarget {
  #wsi = null;

  static wsi = Mapper();

  constructor(url, protocols) {
    super();

    const ctx = (WebSocket.#ctx ??= WebSocket.#createContext());

    this.readyState = CONNECTING;

    this.#wsi = ctx.clientConnect(url, {
      protocol: Array.isArray(protocols) ? protocols.join(',') : 'ws',
      localProtocolName: 'ws',
    });

    const act = {};

    act.state = s => ((this.readyState = s), act);
    act.event = (type, props = {}) => (this.dispatchEvent(type, { type, target: null, ...props }), act);

    WebSocket.map.set(this.#wsi, act);
    WebSocket.wsi.set(this, this.#wsi);

    console.log('WebSocket', { '#wsi': this.#wsi });
  }

  close(code, reason) {
    return this.#wsi.close(code, reason);
  }

  send(data) {
    return this.#wsi.write(data);
  }

  get protocol() {
    const { headers } = this.#wsi;
    return headers?.[''] ?? headers?.['sec-websocket-protocol'];
  }

  static #ctx = null;
  static map = new WeakMap();

  static #createContext(act = wsi => this.map.get(wsi)) {
    return new LWSContext({
      asyncDnsServers: ['8.8.8.8', '8.8.4.4', '4.2.2.1'],
      options: LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT | LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX | LWS_SERVER_OPTION_IGNORE_MISSING_CERT | LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED,
      cientSslCaFilepath: 'ca.crt',
      clientSslCertFilepath: 'localhost.crt',
      clientSslPrivateKeyFilepath: 'localhost.key',
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
}

const states = { CONNECTING, OPEN, CLOSING, CLOSED };

define(WebSocket, states);
define(WebSocket.prototype, states);
Object.defineProperties(WebSocket.prototype, { binaryType: { value: 'arraybuffer', writable: true, configurale: true } });

WebSocket.prototype[Symbol.toStringTag] = 'WebSocket';
WebSocket.prototype.readyState = -1;

function define(obj, ...args) {
  for(let props of args) for (let prop in props) Object.defineProperty(obj, prop, { value: props[prop], configurable: true });
  return obj;
}

function DEBUG(n, ...args) {
  console.log(`\x1b[1;33m${n}\x1b[0m`, console.config({ compact: true, maxArrayLength: 32 }), ...args);
}
