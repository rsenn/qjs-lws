import { EventTarget } from './lws/events.js';
import { define, mapper } from './lws/util.js';
import createContext from './lws/context.js';

export const CONNECTING = 0;
export const OPEN = 1;
export const CLOSING = 2;
export const CLOSED = 3;

export class WebSocket extends EventTarget {
  #wsi = null;

  constructor(url, options_or_protocols) {
    super();

    const options = Array.isArray(options_or_protocols) ? {} : options_or_protocols;
    const protocols = Array.isArray(options_or_protocols) ? options_or_protocols : options_or_protocols?.protocols;

    this.readyState = CONNECTING;

    this.#wsi = WebSocket.#create(
      this,
      ctx =>
        ctx.clientConnect(url, {
          protocol: protocols ? protocols.toString() : 'ws',
          localProtocolName: 'ws',
        }),
      act =>
        createContext({
          ...options,
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
        }),
    );
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

  static lws(ws) {
    return ws.#wsi;
  }

  static #act = mapper();

  static #create(ws, conn, makeContext) {
    this.#ctx ??= makeContext(this.#act);

    const wsi = conn(this.#ctx);

    const act = {
      state: s => ((ws.readyState = s), act),
      event: (type, props = {}) => (ws.dispatchEvent({ type, target: null, ...props }), act),
    };

    this.#act(wsi, act);
    return wsi;
  }

  static waitWrite(ws) {
    return new Promise((resolve, reject) => ws.#wsi.wantWrite(resolve));
  }
}

const states = { CONNECTING, OPEN, CLOSING, CLOSED };

define(WebSocket, states);
define(WebSocket.prototype, states);

WebSocket.prototype[Symbol.toStringTag] = 'WebSocket';

define(WebSocket.prototype, { binaryType: 'arraybuffer' }, { writable: true });
define(WebSocket.prototype, { readyState: 'WebSocket' }, { writable: true, enumerable: true });
