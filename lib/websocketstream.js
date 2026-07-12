import createContext from './lws/context.js';
import { client as wsClient, ws as wsServer, stream } from './lws/protocols.js';

const ALLOWED_PROTOCOLS = ['ws:', 'wss:', 'http:', 'https:'];

/* Sentinel first-argument that only this module can produce, so the one
   public constructor can also serve WebSocketStream.protocol()'s internal
   "wrap an already-established wsi" case without a second class. */
const SERVER = Symbol('WebSocketStream.server');

function protocolOf(wsi) {
  const { headers } = wsi;

  return headers?.['sec-websocket-protocol'] ?? headers?.[''];
}

function extensionsOf(wsi) {
  const { extensions } = wsi;

  return Array.isArray(extensions) ? extensions.join(',') : '';
}

const wsExtra = wsi => ({ protocol: protocolOf(wsi), extensions: extensionsOf(wsi) });
const wsCloseInfo = (wsi, code, reason) => ({ closeCode: code, reason });

/**
 * An interface for handling WebSocket connections using streams.
 *
 * For more information, see: https://developer.mozilla.org/en-US/docs/Web/API/WebSocketStream
 *
 * Independent of the evented `WebSocket` class (lib/websocket.js) - built
 * directly on lib/lws/protocols.js's `client()`/`ws()` role adapters and its
 * `StreamAdapter`, with its own client connect context.
 */
export class WebSocketStream {
  #url;
  #wsi;
  #opened;
  #closed;

  static #ctx;
  static #adapter;

  constructor(url, options = {}) {
    if(url === SERVER) {
      const { wsi, session, uri } = options;

      this.#wsi = wsi;
      this.#url = uri ?? '';
      this.#opened = session.opened;
      this.#closed = session.closed;
      return;
    }

    if(!ALLOWED_PROTOCOLS.find(p => url.toString().startsWith(p)))
      throw new SyntaxError(`Failed to create WebSocketStream. Cause: Invalid URL protocol. Possible values are: ${ALLOWED_PROTOCOLS.map(protocol => `"${protocol}"`).join(', ')}.`);

    const { signal, protocols } = Array.isArray(options) ? { protocols: options } : options;

    signal?.addEventListener('abort', () => this.close(), { once: true });

    this.#url = String(url);

    const adapter = (WebSocketStream.#adapter ??= stream({ extra: wsExtra, closeInfo: wsCloseInfo }));

    WebSocketStream.#ctx ??= createContext({ protocols: [{ name: 'ws', ...wsClient(adapter) }] });

    const session = adapter.session();

    this.#wsi = WebSocketStream.#ctx.clientConnect(url, { protocol: protocols ? protocols.toString() : 'ws', localProtocolName: 'ws' });

    this.#opened = session.opened;
    this.#closed = session.closed;
  }

  /**
   * A promise that resolves when the WebSocket connection is opened. Among other features, this object contains a
   * ReadableStream and a WritableStream instance for receiving and sending data on the connection.
   */
  get opened() {
    return this.#opened;
  }

  /**
   * A promise that resolves when the WebSocket connection is closed, providing the close code and reason.
   */
  get closed() {
    return this.#closed;
  }

  /**
   * The URL of the WebSocket connection.
   */
  get url() {
    return this.#url;
  }

  /**
   * Closes the WebSocket connection.
   */
  close({ closeCode, reason } = {}) {
    this.#wsi.close(closeCode, reason);
  }

  /**
   * Synthesizes a `createServer()`-compatible protocol object that adapts
   * every connection accepted under it into a `WebSocketStream`, handed to
   * `callback` once established.
   *
   * ```js
   * createServer({
   *   port: 8080,
   *   mounts: [{ mountpoint: '/chat', protocol: 'chat', originProtocol: LWSMPRO_NO_MOUNT }],
   *   protocols: [WebSocketStream.protocol('chat', async wss => {
   *     const { readable, writable } = await wss.opened;
   *     const writer = writable.getWriter();
   *     for await(const chunk of readable) await writer.write(chunk); // echo
   *   })],
   * });
   * ```
   *
   * There is no URL to dial server-side - the connection already exists by
   * the time a protocol handler sees it - so this wraps the already-
   * established `wsi` directly via `StreamAdapter#session(wsi)` (see
   * lib/lws/protocols.js), whose `opened` resolves immediately rather than
   * waiting for an `open` event that already happened.
   *
   * @param  {string}   name      Protocol name (matches `mounts[].protocol`
   *                              / the negotiated `Sec-WebSocket-Protocol`)
   * @param  {Function} callback  `(wss: WebSocketStream) => void`, called
   *                              once per established connection
   * @return {object}             A protocol descriptor for `createServer()`'s
   *                              `protocols` array
   */
  static protocol(name, callback) {
    const adapter = stream({ extra: wsExtra, closeInfo: wsCloseInfo });

    return {
      name,
      ...wsServer({
        open: wsi => callback(new WebSocketStream(SERVER, { wsi, session: adapter.session(wsi), uri: wsi.uri })),
        message: adapter.message,
        close: adapter.close,
      }),
    };
  }
}

WebSocketStream.prototype[Symbol.toStringTag] = 'WebSocketStream';
