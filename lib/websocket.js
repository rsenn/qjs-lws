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

    this.constructor.#create(this, (this.constructor.#ctx ??= this.constructor.#createContext()), url, protocols);
  }

  static #create(ws, ctx, url, protocols) {
    ws.readyState = CONNECTING;

    ws.#wsi = ctx.clientConnect(url, {
      protocol: Array.isArray(protocols) ? protocols.join(',') : 'ws',
      localProtocolName: 'ws',
    });

    const act = {
      state: s => ((ws.readyState = s), act),
      event: (type, props = {}) => (ws.dispatchEvent(type, { type, target: null, ...props }), act),
    };

    this.#act(ws.#wsi, act);
    this.#lws(ws, ws.#wsi);
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

  get extensions() {
    const { extensions } = this.#wsi;

    return Array.isArray(extensions) ? extensions.join(',') : '';
  }

  static #ctx;
  static #lws = (WebSocket.lws = mapper());
  static #act = (WebSocket.act = mapper());

  static #createContext() {
    return new LWSContext({
      asyncDnsServers: ['8.8.8.8', '8.8.4.4', '4.2.2.1'],
      options: LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT | LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX | LWS_SERVER_OPTION_IGNORE_MISSING_CERT | LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED,
      clientSslCa: 'ca.crt',
      clientSslCert: 'localhost.crt',
      clientSslPrivateKey: 'localhost.key',
      protocols: [
        {
          name: 'ws',
          onClientEstablished: wsi => (this.#act(wsi).state(OPEN).event('open'), 0),
          onClientConnectionError: (wsi, error) => (this.#act(wsi).state(CLOSING).event('error', { message: error }), 0),
          onWsPeerInitiatedClose: (wsi, code, reason) => (Object.assign(this.#act(wsi), { code, reason }), 0),
          onClientClosed: (wsi, code = this.#act(wsi).code, reason = this.#act(wsi).reason) => (this.#act(wsi).state(CLOSED).event('close', { code, reason }), 0),
          onClientReceive: (wsi, data, size) => (this.#act(wsi).event('message', { data, size }), 0),
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
define(WebSocket.prototype, { ...states, [Symbol.toStringTag]: 'WebSocket' });
define(WebSocket.prototype, { binaryType: 'arraybuffer' }, { writable: true });
define(WebSocket.prototype, { readyState: 'WebSocket' }, { writable: true, enumerable: true });

function define(obj, props, opts = {}) {
  for(let prop in props) Object.defineProperty(obj, prop, { value: props[prop], ...opts });
  return obj;
}

function mapper(target = new WeakMap()) {
  return (...args) => (args.length > 1 ? target.set(...args) : target.get(...args));
}
