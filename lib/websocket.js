import createContext, { ContextRefCounter } from './lws/context.js';
import { EventTargetProperties } from './lws/events.js';
import { client, ws as wsServer } from './lws/protocols.js';
import { define, mapper, states, CONNECTING, OPEN, CLOSING, CLOSED } from './lws/util.js';
import { toArrayBuffer } from 'lws.so';

export { CONNECTING, OPEN, CLOSING, CLOSED } from './lws/util.js';

const ALLOWED_PROTOCOLS = ['ws:', 'wss:', 'http:', 'https:'];

function messageByteLength(message) {
  return typeof message === 'string' ? toArrayBuffer(message).byteLength : message.byteLength;
}

/**
 * Server-wide topic -> subscriber registry backing `WebSocket#subscribe()`/
 * `#unsubscribe()`/`#publish()` and `Server#publish()` (lib/serve.js) -
 * Bun's `ws.subscribe(topic)`/`server.publish(topic, message)` pub/sub,
 * without the app having to track its own list of live sockets. One
 * instance per `WebSocket.protocol()` registration (i.e. per server's WS
 * mountpoint) - topics don't cross servers, matching Bun's own per-server
 * scope.
 */
class TopicRegistry {
  #topics = new Map(); // topic -> Set<WebSocket>
  #subscriptions = new WeakMap(); // WebSocket -> Set<topic>

  subscribe(ws, topic) {
    let subs = this.#topics.get(topic);
    if(!subs) this.#topics.set(topic, (subs = new Set()));
    subs.add(ws);

    let topics = this.#subscriptions.get(ws);
    if(!topics) this.#subscriptions.set(ws, (topics = new Set()));
    topics.add(topic);
  }

  unsubscribe(ws, topic) {
    this.#topics.get(topic)?.delete(ws);
    this.#subscriptions.get(ws)?.delete(topic);
  }

  isSubscribed(ws, topic) {
    return this.#topics.get(topic)?.has(ws) ?? false;
  }

  /** Sends `message` to every subscriber of `topic` except `exclude` (a
      `ws.publish()` call excludes itself; `Server#publish()` excludes
      nothing). Returns the total bytes handed to `wsi.write()` across all
      recipients - lws doesn't expose a per-write backpressure/bytes-sent
      result to check against, so this is "bytes attempted", not a
      confirmed-delivered count. */
  publish(topic, message, exclude) {
    const subs = this.#topics.get(topic);
    if(!subs || !subs.size) return 0;

    const len = messageByteLength(message);
    let sent = 0;

    for(const ws of subs) {
      if(ws === exclude) continue;
      ws.send(message);
      sent += len;
    }

    return sent;
  }

  /** Drops every subscription `ws` still has - called once, on close. */
  cleanup(ws) {
    const topics = this.#subscriptions.get(ws);
    if(!topics) return;

    for(const topic of topics) this.#topics.get(topic)?.delete(ws);
    this.#subscriptions.delete(ws);
  }
}

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
  /* WebSocket has no listen()/bind() equivalent - the static #ctx here is
     only ever used for outbound clientConnect()s (server-accepted sockets
     go through .protocol()'s own, separate context, below) - so a plain
     ContextRefCounter is enough, no markServer() carve-out needed like
     TCPSocket's. */
  static #ref = new ContextRefCounter(() => {
    WebSocket.#ctx?.destroy();
    WebSocket.#ctx = undefined;
    WebSocket.#sockets = undefined;
  });

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
            error: (wsi, message) => ((sockets(wsi).readyState = CLOSING), fire(wsi, 'error', { message }), this.#ref.release(wsi)),
            close: (wsi, code, reason) => ((sockets(wsi).readyState = CLOSED), fire(wsi, 'close', { code, reason }), this.#ref.release(wsi)),
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

      this.#ref.add(wsi);
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
   *                              `protocols` array - also carries a
   *                              `publish(topic, message)` (server-wide,
   *                              excludes nobody) that `serve()` exposes as
   *                              `server.publish()`
   */
  static protocol(name, callback) {
    const sockets = new WeakMap();
    const topics = new TopicRegistry();

    const descriptor = {
      name,
      ...wsServer({
        open: wsi => {
          const socket = WebSocket.#accept(wsi);

          socket.subscribe = topic => topics.subscribe(socket, topic);
          socket.unsubscribe = topic => topics.unsubscribe(socket, topic);
          socket.isSubscribed = topic => topics.isSubscribed(socket, topic);
          socket.publish = (topic, message) => topics.publish(topic, message, socket);

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
            topics.cleanup(socket);
            socket.readyState = CLOSED;
            socket.dispatchEvent({ type: 'close', target: socket, code, reason });
          }
        },
      }),
    };

    descriptor.publish = (topic, message) => topics.publish(topic, message);

    return descriptor;
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
