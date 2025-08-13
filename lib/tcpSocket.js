import { EventTarget, EventTargetProperties } from './lws/events.js';
import { define, mapper, actor, states, verbose } from './lws/util.js';
import createContext from './lws/context.js';
export { CONNECTING, OPEN, CLOSING, CLOSED } from './lws/util.js';
import { LWS_SERVER_OPTION_ONLY_RAW, LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG, getCallbackName } from 'lws';

export class TCPSocket extends EventTargetProperties(['accept', 'open', 'error', 'message', 'close']) {
  #wsi;
  #options;

  constructor(options = {}) {
    super();

    const { host, address, port, ...rest } = (this.#options = options);

    if((host || address) && port !== undefined) {
      this.readyState = CONNECTING;

      this.#wsi = TCPSocket.#create(this, ctx => ctx.clientConnect({ host, address, port, method: 'RAW', protocol: 'raw' }));
    }
  }

  bind(address, port) {
    this.#options ??= {};
    Object.assign(this.#options, { address, port });
    return this;
  }

  listen() {
    this.#options.options ??= 0;
    this.#options.options |= LWS_SERVER_OPTION_ONLY_RAW | LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG;

    TCPSocket.#create(this);
  }

  close(code) {
    return this.#wsi.close(code);
  }

  send(data) {
    return this.#wsi.write(data);
  }

  static #ctx;
  static #act;

  static lws(ws) {
    return ws.#wsi;
  }

  static #create(ws, connectFn) {
    const act = (this.#act ??= mapper());

    this.#ctx ??= createContext({
      ...ws.#options,
      listenAcceptRole: 'raw-skt',
      listenAcceptProtocol: 'raw',
      protocols: [
        {
          name: 'raw',
          onRawAdopt: wsi => {
            const socket = new TCPSocket();
            socket.#wsi = wsi;
            socket.readyState = OPEN;
            act(wsi, actor(socket));
            ws.dispatchEvent({ type: 'accept', socket });
          },
          onRawConnected: wsi => act(wsi).state(OPEN).event('open'),
          onRawClose: wsi => act(wsi).state(CLOSED).event('close'),
          onRawRx: (wsi, data, size) => act(wsi).event('message', { data, size }),
          callback(wsi, reason, ...args) {
            verbose(getCallbackName(reason), wsi, args);
          },
        },
      ],
    });

    if(connectFn) {
      const wsi = connectFn(this.#ctx);

      act(wsi, actor(ws, verbose));
      return wsi;
    }
  }

  static waitWrite(ws) {
    return new Promise((resolve, reject) => ws.#wsi.wantWrite(resolve));
  }
}

define(TCPSocket, states);
define(TCPSocket.prototype, states);

TCPSocket.prototype[Symbol.toStringTag] = 'TCPSocket';

define(TCPSocket.prototype, { binaryType: 'arraybuffer' }, { writable: true });
define(TCPSocket.prototype, { readyState: undefined }, { writable: true, enumerable: true });
