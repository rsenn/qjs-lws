import createContext from './lws/context.js';
import { raw, stream } from './lws/protocols.js';
import { tlsConnectFlags } from './lws/tls.js';
import { LCCSCF_USE_SSL, LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX, LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT, LWS_SERVER_OPTION_IGNORE_MISSING_CERT } from 'lws';

/* Sentinel first-argument that only this module can produce, so the one
   public constructor can also serve TCPSocketStream.protocol()'s internal
   "wrap an already-established wsi" case without a second class. */
const SERVER = Symbol('TCPSocketStream.server');

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

  /**
   * @param  {object}       options
   * @param  {string}       options.host
   * @param  {number}       options.port
   * @param  {true|object}  [options.tls]  Wraps the connection in TLS - a
   *                        raw socket has no cert of its own to present
   *                        (that's the server's job), so this only
   *                        controls verification: `{ rejectUnauthorized }`
   *                        etc, same shape as lib/lws/tls.js's
   *                        tlsConnectFlags(). The singleton context below
   *                        is shared across every TCPSocketStream, so
   *                        there's no per-instance `ca` to pin - pass
   *                        `rejectUnauthorized: false` for a self-signed
   *                        server (this is a raw socket, there's no
   *                        hostname to verify against either way).
   */
  constructor(options = {}, serverOptions) {
    if(options === SERVER) {
      const { wsi, session } = serverOptions;

      this.#wsi = wsi;
      this.#opened = session.opened;
      this.#closed = session.closed;
      return;
    }

    const { signal, host, address, port, tls, ...rest } = options;

    signal?.addEventListener('abort', () => this.close(), { once: true });

    const adapter = (TCPSocketStream.#adapter ??= stream({ extra: rawExtra, closeInfo: () => undefined }));

    /* Always SSL-capable (matches lib/fetch.js's shared-context default),
       so any individual connect() can opt into TLS via `tls` below without
       that decision needing to be known back when this singleton context
       was first created by some earlier, possibly plain-TCP, instance. */
    TCPSocketStream.#ctx ??= createContext({
      options: LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT | LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX | LWS_SERVER_OPTION_IGNORE_MISSING_CERT,
      protocols: [{ name: 'raw', ...raw(adapter) }],
    });

    const session = adapter.session();

    this.#wsi = TCPSocketStream.#ctx.clientConnect({
      host,
      address,
      port,
      method: 'RAW',
      protocol: 'raw',
      ...rest,
      ssl_connection: (rest.ssl_connection ?? 0) | (tls ? LCCSCF_USE_SSL | tlsConnectFlags(tls) : 0),
    });

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

  /**
   * Synthesizes a `createServer()`-compatible protocol descriptor that adapts
   * every raw connection accepted under it into a `TCPSocketStream`, handed
   * to `callback` once accepted. Mirrors `WebSocketStream.protocol()` (see
   * lib/websocketstream.js) and `TCPSocket.protocol()` (lib/tcpsocket.js).
   *
   * There is no address/port to dial server-side - the connection already
   * exists by the time a protocol handler sees it - so this wraps the
   * already-adopted `wsi` directly via `StreamAdapter#session(wsi)` (see
   * lib/lws/protocols.js), whose `opened` resolves immediately rather than
   * waiting for an `open` event that already happened.
   *
   * @param  {string}   name      Protocol name (matches `mounts[].protocol` /
   *                              `listenAcceptProtocol`)
   * @param  {Function} callback  `(stream: TCPSocketStream) => void`, called
   *                              once per accepted connection
   * @return {object}             A protocol descriptor for `createServer()`'s
   *                              `protocols` array
   */
  static protocol(name, callback) {
    const adapter = stream({ extra: rawExtra, closeInfo: () => undefined });

    return {
      name,
      ...raw({
        open: wsi => callback(new TCPSocketStream(SERVER, { wsi, session: adapter.session(wsi) })),
        message: adapter.message,
        close: adapter.close,
      }),
    };
  }
}

TCPSocketStream.prototype[Symbol.toStringTag] = 'TCPSocketStream';
