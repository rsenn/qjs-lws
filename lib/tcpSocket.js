import createContext from './lws/context.js';
import { EventTargetProperties } from './lws/events.js';
import { raw, stream } from './lws/protocols.js';
import { define, mapper, states, CONNECTING, OPEN, CLOSED } from './lws/util.js';
import { LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG } from 'lws.so';
import { LWS_SERVER_OPTION_ONLY_RAW } from 'lws.so';

export { CONNECTING, OPEN, CLOSING, CLOSED } from './lws/util.js';

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
      options = args[0] ?? {};
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
  static #sockets;

  static lws(s) {
    return s.#wsi;
  }

  static #accept(wsi) {
    const socket = new TCPSocket();

    socket.#wsi = wsi;
    socket.readyState = OPEN;
    return socket;
  }

  static #create(s, connectFn) {
    const sockets = (this.#sockets ??= mapper());
    const fire = (wsi, type, props) => sockets(wsi).dispatchEvent({ type, target: sockets(wsi), ...props });

    this.#ctx ??= createContext({
      ...s.#options,
      listenAcceptRole: 'raw-skt',
      listenAcceptProtocol: 'raw',
      protocols: [
        {
          name: 'raw',
          ...raw({
            open: wsi => {
              if(wsi.client) {
                sockets(wsi).readyState = OPEN;
                fire(wsi, 'open');
              } else {
                const socket = TCPSocket.#accept(wsi);

                sockets(wsi, socket);
                s.dispatchEvent({ type: 'accept', target: s, socket });
              }
            },
            message: (wsi, data, size) => fire(wsi, 'message', { data, size }),
            close: wsi => {
              sockets(wsi).readyState = CLOSED;
              fire(wsi, 'close');
            },
            error: (wsi, message) => fire(wsi, 'error', { message }),
          }),
        },
      ],
    });

    if(connectFn) {
      const wsi = connectFn(this.#ctx);

      sockets(wsi, s);
      return wsi;
    }
  }

  /**
   * Synthesizes a `createServer()`-compatible protocol descriptor that adapts
   * every raw connection accepted under it into a `TCPSocket`, handed to
   * `callback` once accepted. Mirrors `WebSocketStream.protocol()` (see
   * lib/websocketstream.js).
   *
   * @param  {string}   name      Protocol name (matches `mounts[].protocol` /
   *                              `listenAcceptProtocol`)
   * @param  {Function} callback  `(socket: TCPSocket) => void`, called once
   *                              per accepted connection
   * @return {object}             A protocol descriptor for `createServer()`'s
   *                              `protocols` array
   */
  static protocol(name, callback) {
    const adapters = new WeakMap();

    return {
      name,
      ...raw({
        open: wsi => {
          const socket = TCPSocket.#accept(wsi);

          adapters.set(wsi, socket);
          callback(socket);
        },
        message: (wsi, data, size) => {
          const socket = adapters.get(wsi);

          socket?.dispatchEvent({ type: 'message', target: socket, data, size });
        },
        close: wsi => {
          const socket = adapters.get(wsi);

          if(socket) {
            socket.readyState = CLOSED;
            socket.dispatchEvent({ type: 'close', target: socket });
          }
        },
      }),
    };
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

const rawExtra = wsi => ({
  remoteAddress: wsi.peer?.host,
  remotePort: wsi.peer?.port,
  localAddress: wsi.local?.host,
  localPort: wsi.local?.port,
});

/**
 * An interface for handling TCPSocket connections using streams.
 *
 * Independent of the evented `TCPSocket` class above - built directly on
 * lib/lws/protocols.js's `raw()` role adapter and its `StreamAdapter`, with
 * its own client connect context.
 */
export class TCPSocketStream {
  #wsi;
  #opened;
  #closed;

  static #ctx;
  static #adapter;

  constructor(options = {}) {
    const { signal, host, address, port, ...rest } = options;

    signal?.addEventListener('abort', () => this.close(), { once: true });

    const adapter = (TCPSocketStream.#adapter ??= stream({ extra: rawExtra, closeInfo: () => undefined }));

    TCPSocketStream.#ctx ??= createContext({ protocols: [{ name: 'raw', ...raw(adapter) }] });

    const session = adapter.session();

    this.#wsi = TCPSocketStream.#ctx.clientConnect({ host, address, port, method: 'RAW', protocol: 'raw', ...rest });

    this.#opened = session.opened;
    this.#closed = session.closed;
  }

  /**
   * A promise that resolves when the TCPSocket connection is opened. Among other features, this object contains a
   * ReadableStream and a WritableStream instance for receiving and sending data on the connection.
   */
  get opened() {
    return this.#opened;
  }

  /**
   * A promise that resolves when the TCPSocket connection is closed.
   */
  get closed() {
    return this.#closed;
  }

  /**
   * Closes the TCPSocket connection.
   */
  close() {
    this.#wsi.close();
  }
}

TCPSocketStream.prototype[Symbol.toStringTag] = 'TCPSocketStream';
