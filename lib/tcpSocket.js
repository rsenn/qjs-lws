import { EventTarget, EventTargetProperties } from './lws/events.js';
import { define, mapper, actor, states, verbose } from './lws/util.js';
import createContext from './lws/context.js';
export { CONNECTING, OPEN, CLOSING, CLOSED } from './lws/util.js';
import { LWS_SERVER_OPTION_ONLY_RAW, LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG, getCallbackName } from 'lws';
import { ReadableStream, WritableStream } from './lws/streams.js';

export class TCPSocket extends EventTargetProperties(['accept', 'open', 'error', 'message', 'close']) {
  #wsi;
  #options;

  constructor(...args) {
    super();

    let options;

    if(args.length >= 2) {
      options = args[2] ?? {};
      options.host = args[0];
      options.port = args[1];
    } else {
      [options] = args;
    }

    const { host, address, port, ...rest } = options;

    this.#options = rest;

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

  static lws(s) {
    return s.#wsi;
  }

  static #create(s, connectFn) {
    const act = (this.#act ??= mapper());

    this.#ctx ??= createContext({
      ...s.#options,
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
            s.dispatchEvent({ type: 'accept', socket });
          },
          onRawConnected: wsi => act(wsi).state(OPEN).event('open'),
          onRawWriteable: wsi => {},
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

      act(wsi, actor(s, verbose));
      return wsi;
    }
  }

  static waitWrite(s) {
    return new Promise((resolve, reject) => s.#wsi.wantWrite(resolve));
  }

  /* prettier-ignore */ get remoteAddress() { return this.#wsi.peer?.host; }
  /* prettier-ignore */ get remotePort() { return this.#wsi.peer?.port; }
  /* prettier-ignore */ get localAddress() { return this.#wsi.local?.host; }
  /* prettier-ignore */ get localPort() { return this.#wsi.local?.port; }
}

define(TCPSocket, states);
define(TCPSocket.prototype, states);

TCPSocket.prototype[Symbol.toStringTag] = 'TCPSocket';

define(TCPSocket.prototype, { binaryType: 'arraybuffer' }, { writable: true });
define(TCPSocket.prototype, { readyState: undefined }, { writable: true, enumerable: true });

/**
 * An interface for handling TCPSocket connections using streams.
 */
export class TCPSocketStream {
  #sock;

  constructor(options = {}) {
    const { signal, ctor = TCPSocket } = options;

    signal?.addEventListener('abort', () => this.close(), {
      once: true,
    });

    this.#sock = new ctor(options);
    this.#sock.binaryType = 'arraybuffer';

    define(this, {
      /**
       * A promise that resolves when the TCPSocket connection is opened. Among other features, this object contains a
       * ReadableStream and a WritableStream instance for receiving and sending data on the connection.
       */
      opened: new Promise((resolve, reject) => {
        this.#sock.addEventListener('open', () =>
          resolve({
            remoteAddress: this.#sock.remoteAddress,
            remotePort: this.#sock.remotePort,
            localAddress: this.#sock.localAddress,
            localPort: this.#sock.localPort,
            readable: new ReadableStream({
              start: controller => {
                this.#sock.addEventListener('message', event => controller.enqueue(event.data));
                this.#sock.addEventListener('close', () => {
                  try {
                    controller.close();
                  } catch {}
                });
              },
              cancel: () => this.#sock.close(),
            }),
            writable: new WritableStream({
              start: controller => this.#sock.addEventListener('close', () => controller.error()),
              write: async chunk => {
                await ctor.waitWrite(this.#sock);

                return this.#sock.send(chunk);
              },
              close: () => this.#sock.close(),
              abort: () => this.#sock.close(),
            }),
          }),
        );
        this.#sock.addEventListener('error', err => reject(new Error('TCPSocketStream error: ' + err.message)));
      }),
      /**
       * A promise that resolves when the TCPSocket connection is closed, providing the close code and reason.
       */
      closed: new Promise(resolve => this.#sock.addEventListener('close', event => resolve())),
    });
  }

  static socket(ss) {
    return ss.#sock;
  }

  /**
   * Closes the WebSocket connection.
   */
  close() {
    this.#sock.close();
  }
}

TCPSocketStream.prototype[Symbol.toStringTag] = 'TCPSocketStream';
