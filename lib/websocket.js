import createContext from './lws/context.js';
import { EventTargetProperties } from './lws/events.js';
import { client, ws as wsServer } from './lws/protocols.js';
import { define, mapper, states, CONNECTING, OPEN, CLOSING, CLOSED } from './lws/util.js';

export { CONNECTING, OPEN, CLOSING, CLOSED } from './lws/util.js';

const ALLOWED_PROTOCOLS = ['ws:', 'wss:', 'http:', 'https:'];

export class WebSocket extends EventTargetProperties(['open', 'error', 'message', 'close']) {
  #wsi = null;

  constructor(url, options_or_protocols) {
    super();

    if(url) {
      if(!ALLOWED_PROTOCOLS.find(p => url.toString().startsWith(p)))
        throw new SyntaxError(`Failed to create WebSocketStream. Cause: Invalid URL protocol. Possible values are: ${ALLOWED_PROTOCOLS.map(protocol => `"${protocol}"`).join(', ')}.`);

      if(typeof options_or_protocols == 'string') options_or_protocols = [options_or_protocols];

      const options = Array.isArray(options_or_protocols) ? {} : options_or_protocols;
      const protocols = Array.isArray(options_or_protocols) ? options_or_protocols : options_or_protocols?.protocols;

      this.readyState = CONNECTING;

      this.#wsi = WebSocket.#create(this, options, ctx =>
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
  static #sockets;

  static lws(ws) {
    return ws.#wsi;
  }

  static #accept(wsi) {
    const socket = new WebSocket();

    socket.#wsi = wsi;
    socket.readyState = OPEN;
    return socket;
  }

  static #create(ws, options, connectFn) {
    const sockets = (this.#sockets ??= mapper());
    const fire = (wsi, type, props) => sockets(wsi).dispatchEvent({ type, target: sockets(wsi), ...props });

    this.#ctx ??= createContext({
      ...options,
      protocols: [
        {
          name: 'ws',
          ...client({
            open: wsi => ((sockets(wsi).readyState = OPEN), fire(wsi, 'open')),
            error: (wsi, message) => ((sockets(wsi).readyState = CLOSING), fire(wsi, 'error', { message })),
            close: (wsi, code, reason) => ((sockets(wsi).readyState = CLOSED), fire(wsi, 'close', { code, reason })),
            /* `frame` (only present for multi-fragment messages, per
               LWS_CALLBACK_CLIENT_RECEIVE's doc) would in principle let us
               reassemble here, but lws_is_final_fragment() has been observed
               to report true for every fragment of a manually- or
               internally-split large WS message in this build, making that
               reassembly unreliable - callers needing to handle large
               payloads robustly should frame them explicitly at the
               application level instead (see examples/debugger/server.js +
               demo.js for the pattern) rather than relying on WS message
               boundaries. */
            message: (wsi, data, size) => fire(wsi, 'message', { data, size }),
          }),
        },
      ],
    });

    if(connectFn) {
      const wsi = connectFn(this.#ctx);

      sockets(wsi, ws);
      return wsi;
    }
  }

  /**
   * Synthesizes a `createServer()`-compatible protocol descriptor that adapts
   * every WS connection accepted under it into a `WebSocket`, handed to
   * `callback` once established. Mirrors `TCPSocket.protocol()`
   * (lib/tcpsocket.js) and `WebSocketStream.protocol()`
   * (lib/websocketstream.js).
   *
   * @param  {string}   name      Protocol name (matches `mounts[].protocol`
   *                              / the negotiated `Sec-WebSocket-Protocol`)
   * @param  {Function} callback  `(ws: WebSocket) => void`, called once per
   *                              established connection
   * @return {object}             A protocol descriptor for `createServer()`'s
   *                              `protocols` array
   */
  static protocol(name, callback) {
    const sockets = new WeakMap();

    return {
      name,
      ...wsServer({
        open: wsi => {
          const socket = WebSocket.#accept(wsi);

          sockets.set(wsi, socket);
          callback(socket);
        },
        message: (wsi, data, size) => {
          const socket = sockets.get(wsi);

          socket?.dispatchEvent({ type: 'message', target: socket, data, size });
        },
        close: (wsi, code, reason) => {
          const socket = sockets.get(wsi);

          if(socket) {
            socket.readyState = CLOSED;
            socket.dispatchEvent({ type: 'close', target: socket, code, reason });
          }
        },
      }),
    };
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
