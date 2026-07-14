import createContext from './lws/context.js';
import { raw, stream } from './lws/protocols.js';
import { tlsConnectFlags } from './lws/tls.js';
import { LCCSCF_USE_SSL, LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX, LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT, LWS_SERVER_OPTION_IGNORE_MISSING_CERT } from 'lws.so';

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
  constructor(options = {}) {
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
}

TCPSocketStream.prototype[Symbol.toStringTag] = 'TCPSocketStream';
