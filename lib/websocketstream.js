import { ReadableStream, WritableStream } from './lws/streams.js';
import { EventTargetProperties } from './lws/events.js';
import { define, mapper, states, CONNECTING, OPEN, CLOSED } from './lws/util.js';
import { WebSocket } from './websocket.js';

/**
 * An interface for handling WebSocket connections using streams.
 *
 * For more information, see: https://developer.mozilla.org/en-US/docs/Web/API/WebSocketStream
 */
export class WebSocketStream {
  #ws;

  constructor(url, options = {}) {
    const { signal, protocols, ctor = WebSocket } = Array.isArray(options) ? { protocols: options } : options;

    signal?.addEventListener('abort', () => this.close(), {
      once: true,
    });

    this.#ws = new ctor(url, protocols);
    this.#ws.binaryType = 'arraybuffer';

    define(this, {
      /**
       * A promise that resolves when the WebSocket connection is opened. Among other features, this object contains a
       * ReadableStream and a WritableStream instance for receiving and sending data on the connection.
       */
      opened: new Promise((resolve, reject) => {
        this.#ws.addEventListener('open', () =>
          resolve({
            extensions: this.#ws.extensions,
            protocol: this.#ws.protocol,
            readable: new ReadableStream({
              start: controller => {
                this.#ws.addEventListener('message', event => controller.enqueue(event.data));
                this.#ws.addEventListener('close', () => {
                  try {
                    controller.close();
                  } catch {}
                });
              },
              cancel: () => this.#ws.close(),
            }),
            writable: new WritableStream({
              start: controller => this.#ws.addEventListener('close', () => controller.error()),
              write: async chunk => {
                await ctor.waitWrite(this.#ws);

                return this.#ws.send(chunk);
              },
              close: () => this.#ws.close(),
              abort: reason => this.#ws.close(undefined, reason),
            }),
          }),
        );
        this.#ws.addEventListener('error', err => reject(new Error('WebSocketStream error: ' + err.message)));
      }),
      /**
       * A promise that resolves when the WebSocket connection is closed, providing the close code and reason.
       */
      closed: new Promise(resolve => {
        this.#ws.addEventListener('close', event => {
          resolve({
            closeCode: event.code,
            reason: event.reason,
          });
        });
      }),
    });
  }

  /**
   * The URL of the WebSocket connection.
   */
  get url() {
    return this.#ws.url;
  }

  /**
   * Closes the WebSocket connection.
   */
  close({ closeCode, reason } = {}) {
    this.#ws.close(closeCode, reason);
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
   *     for await (const chunk of readable) await writer.write(chunk); // echo
   *   })],
   * });
   * ```
   *
   * There is no URL to dial server-side - the connection already exists by
   * the time a protocol handler sees it - so this doesn't go through
   * `WebSocket`'s client-only constructor. Instead it drives
   * `WebSocketStream`'s existing `ctor` constructor option with a minimal
   * adapter (`ServerWebSocketAdapter`, below) that wraps the
   * already-established `wsi` directly.
   *
   * @param  {string}   name      Protocol name (matches `mounts[].protocol`
   *                              / the negotiated `Sec-WebSocket-Protocol`)
   * @param  {Function} callback  `(wss: WebSocketStream) => void`, called
   *                              once per established connection
   * @return {object}             A protocol descriptor for `createServer()`'s
   *                              `protocols` array
   */
  static protocol(name, callback) {
    return {
      name,
      onEstablished(wsi) {
        callback(new WebSocketStream(wsi, { ctor: ServerWebSocketAdapter }));
      },
      onReceive(wsi, data, size) {
        wsiAdapters(wsi)?.dispatchEvent({ type: 'message', data, size });
      },
      onWsPeerInitiatedClose(wsi, code, reason) {
        const adapter = wsiAdapters(wsi);

        if(adapter) Object.assign(adapter, { peerCloseCode: code, peerCloseReason: reason });

        return 0;
      },
      onClosed(wsi, code, reason) {
        const adapter = wsiAdapters(wsi);

        if(adapter) {
          adapter.readyState = CLOSED;
          adapter.dispatchEvent({ type: 'close', code: code ?? adapter.peerCloseCode, reason: reason ?? adapter.peerCloseReason });
        }
      },
    };
  }
}

WebSocketStream.prototype[Symbol.toStringTag] = 'WebSocketStream';

/* wsi -> ServerWebSocketAdapter, so the createServer()-side protocol
   handlers (onReceive/onClosed/...) can route events to the right adapter
   instance without threading it through createServer()'s own callback
   signatures. */
const wsiAdapters = mapper();

/**
 * Minimal WebSocket-shaped wrapper around an already-established server-side
 * `wsi`, used only by `WebSocketStream.protocol()`. Provides just enough of
 * the real `WebSocket` surface (addEventListener/close/send/protocol/
 * extensions, plus the static `waitWrite`) for `WebSocketStream`'s
 * constructor to drive it exactly like a real client `WebSocket`.
 */
class ServerWebSocketAdapter extends EventTargetProperties(['open', 'error', 'message', 'close']) {
  #wsi;

  constructor(wsi) {
    super();

    this.#wsi = wsi;
    this.readyState = CONNECTING;

    wsiAdapters(wsi, this);

    /* The connection is already established by the time createServer()'s
       onEstablished(wsi) fires - but WebSocketStream's constructor (the
       caller of `new ctor(wsi)`) only attaches its own 'open' listener
       *after* this constructor returns. Defer to a microtask so that
       listener is in place before 'open' actually dispatches. */
    Promise.resolve().then(() => {
      this.readyState = OPEN;
      this.dispatchEvent({ type: 'open' });
    });
  }

  close(code, reason) {
    return this.#wsi.close(code, reason);
  }

  send(data) {
    return this.#wsi.write(data);
  }

  /* wsi.uri / wsi.headers are only populated after specific HTTP-phase
     callbacks (FILTER_HTTP_CONNECTION, HTTP, ...) - not ESTABLISHED, which
     is what onEstablished() fires on - so both of these are null/undefined
     in practice for a WS server connection. Left as-is rather than hooking
     an earlier callback to capture them, which is out of scope here. */
  get url() {
    return this.#wsi.uri;
  }

  get protocol() {
    const { headers } = this.#wsi;

    return headers?.['sec-websocket-protocol'] ?? headers?.[''];
  }

  get extensions() {
    const { extensions } = this.#wsi;

    return Array.isArray(extensions) ? extensions.join(',') : '';
  }

  static waitWrite(adapter) {
    return new Promise(resolve => adapter.#wsi.wantWrite(resolve));
  }
}

define(ServerWebSocketAdapter, states);
define(ServerWebSocketAdapter.prototype, states);

ServerWebSocketAdapter.prototype[Symbol.toStringTag] = 'WebSocket';

define(ServerWebSocketAdapter.prototype, { binaryType: 'arraybuffer' }, { writable: true });
