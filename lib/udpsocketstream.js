import createContext, { ContextRefCounter } from './lws/context.js';
import { raw, stream } from './lws/protocols.js';
import {
  LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX,
  LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT,
  LWS_SERVER_OPTION_IGNORE_MISSING_CERT 
} from 'lws.so';

/* Sentinel first-argument that only this module can produce, so the one
   public constructor can also serve UDPSocketStream.protocol()'s internal
   "wrap an already-established wsi" case without a second class. */
const SERVER = Symbol('UDPSocketStream.server');

const rawExtra = wsi => ({
  remoteAddress: wsi.peer?.host,
  remotePort: wsi.peer?.port,
  localAddress: wsi.local?.host,
  localPort: wsi.local?.port,
});

/**
 * An interface for handling UDPSocket connections using streams.
 *
 * Independent of the evented `UDPSocket` class (lib/udpsocket.js) - built
 * directly on lib/lws/protocols.js's `raw()` role adapter and its
 * `StreamAdapter`, with its own client connect context.
 */
export class UDPSocketStream {
  #wsi;
  #opened;
  #closed;

  static #ctx;
  static #adapter;
  static #ref = new ContextRefCounter(() => {
    UDPSocketStream.#ctx?.destroy();
    UDPSocketStream.#ctx = undefined;
    UDPSocketStream.#adapter = undefined;
  });

  /**
   * @param  {object}       options
   * @param  {string}       [options.host]
   * @param  {string}       [options.address]
   * @param  {number}       options.port
   * @param  {boolean}      [options.bind=false]
   * @param  {boolean}      [options.broadcast=false]
   */
  constructor(options = {}, serverOptions) {
    if (options === SERVER) {
      const { wsi, session } = serverOptions;

      this.#wsi = wsi;
      this.#opened = session.opened;
      this.#closed = session.closed;
      return;
    }

    const { signal, host, address, port, bind = false, broadcast = false, ...rest } = options;

    signal?.addEventListener('abort', () => this.close(), { once: true });

    const adapter = (UDPSocketStream.#adapter ??= stream({ extra: rawExtra, closeInfo: () => undefined }));

    UDPSocketStream.#ctx ??= createContext({
      options: LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT | LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX | LWS_SERVER_OPTION_IGNORE_MISSING_CERT,
      protocols: [{ name: 'raw', ...raw(adapter) }],
    });

    const session = adapter.session();

    // Use LWSContext.createUdp instead of clientConnect for UDP socket adoption
    this.#wsi = UDPSocketStream.#ctx.createUdp({
      address: address || host,
      port,
      protocol: 'raw',
      bind,
      broadcast,
      ...rest,
    });

    this.#opened = session.opened;
    this.#closed = session.closed;

    UDPSocketStream.#ref.track(this, this.#opened, this.#closed);
  }

  /**
   * A promise that resolves when the UDPSocket connection is opened.
   */
  get opened() {
    return this.#opened;
  } 

  /**
   * A promise that resolves when the UDPSocket connection is closed.
   */
  get closed() {
    return this.#closed;
  } 

  /**
   * Closes the UDPSocket connection.
   */
  close() {
    this.#wsi?.close();
  } 

  /**
   * Synthesizes a `createServer()`-compatible protocol descriptor.
   */
  static protocol(name, callback) {
    const adapter = stream({ extra: rawExtra, closeInfo: () => undefined });

    return {
      name,
      ...raw({
        open: wsi => callback(new UDPSocketStream(SERVER, { wsi, session: adapter.session(wsi) })),
        message: adapter.message,
        close: adapter.close,
      }),
    };
  } 
}   

UDPSocketStream.prototype[Symbol.toStringTag] = 'UDPSocketStream';
