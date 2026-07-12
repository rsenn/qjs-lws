import createContext from './lws/context.js';
import { raw, stream } from './lws/protocols.js';

const rawExtra = wsi => ({
  remoteAddress: wsi.peer?.host,
  remotePort: wsi.peer?.port,
  localAddress: wsi.local?.host,
  localPort: wsi.local?.port,
});

/**
 * An interface for handling TCPSocket connections using streams.
 *
 * Independent of the evented `TCPSocket` class (lib/tcpsocket.js) - built
 * directly on lib/lws/protocols.js's `raw()` role adapter and its
 * `StreamAdapter`, with its own client connect context.
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
