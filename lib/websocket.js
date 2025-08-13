import { EventTarget, EventTargetProperties } from './lws/events.js';
import { define, mapper, actor, states } from './lws/util.js';
import createContext from './lws/context.js';
export { CONNECTING, OPEN, CLOSING, CLOSED } from './lws/util.js';

export class WebSocket extends EventTargetProperties(['open', 'error', 'message', 'close']) {
  #wsi = null;

  constructor(url, options_or_protocols) {
    super();

    if(url) {
      const options = Array.isArray(options_or_protocols) ? {} : options_or_protocols;
      const protocols = Array.isArray(options_or_protocols) ? options_or_protocols : options_or_protocols?.protocols;

      this.readyState = CONNECTING;

      this.#wsi = WebSocket.#create(this, ctx =>
        ctx.clientConnect(url, {
          protocol: protocols ? protocols.toString() : 'ws',
          localProtocolName: 'ws',
        }),
      );
    }
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
  static #act;

  static lws(ws) {
    return ws.#wsi;
  }

  static #create(ws, connectFn) {
    const act = (this.#act ??= mapper());

    this.#ctx ??= createContext({
      ...options,
      protocols: [
        {
          name: 'ws',
          onClientEstablished: wsi => act(wsi).state(OPEN).event('open'),
          onClientConnectionError: (wsi, error) => act(wsi).state(CLOSING).event('error', { message: error }),
          onWsPeerInitiatedClose: (wsi, code, reason) => (Object.assign(act(wsi), { code, reason }), 0),
          onClientClosed: (wsi, code = act(wsi).code, reason = act(wsi).reason) => act(wsi).state(CLOSED).event('close', { code, reason }),
          onClientReceive: (wsi, data, size) => act(wsi).event('message', { data, size }),
        },
      ],
    });

    if(connectFn) {
      const wsi = connectFn(this.#ctx);

      act(wsi, actor(ws));
      return wsi;
    }
  }

  static waitWrite(ws) {
    return new Promise((resolve, reject) => ws.#wsi.wantWrite(resolve));
  }
}

define(WebSocket, states);
define(WebSocket.prototype, states);

WebSocket.prototype[Symbol.toStringTag] = 'WebSocket';

define(WebSocket.prototype, { binaryType: 'arraybuffer' }, { writable: true });
define(WebSocket.prototype, { readyState: undefined }, { writable: true, enumerable: true });
