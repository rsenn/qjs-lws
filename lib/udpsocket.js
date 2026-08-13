import createContext, { ContextRefCounter } from './lws/context.js';
import { EventTargetProperties } from './lws/events.js';
import { raw } from './lws/protocols.js';
import { define, mapper, states, CONNECTING, OPEN, CLOSED } from './lws/util.js';
import { LWSSockAddr46 } from 'lws.so';

export { CONNECTING, OPEN, CLOSING, CLOSED } from './lws/util.js';

/**
 * UDP is connectionless: unlike `TCPSocket`, there is no listener wsi that
 * spawns one child wsi per peer - a single wsi either sends/receives with
 * one fixed remote peer ("connected", `wsi.client` semantics don't apply
 * here - see lws-context.c's METHOD_CREATE_UDP) or is bound to a local
 * address and fields datagrams from any peer ("bound"/server). Either way,
 * the wsi handed back by `createUdp()` *is* this socket, so there is no
 * separate accept/adopt step - `open` fires directly on `this`.
 */
export class UDPSocket extends EventTargetProperties(['open', 'error', 'message', 'close']) {
  #wsi;
  #options;

  constructor(...args) {
    super();

    let options;

    if(args.length >= 2 && typeof args[1] != 'object') {
      options = args[2] ?? {};
      options.host = args[0];
      options.port = args[1];
    } else {
      options = args[0] ?? {};
    }

    const { host, address, port, protocol = 'raw', bind, broadcast, ...rest } = options;

    this.#options = rest;

    if(port !== undefined) this.#connect({ address: address ?? host, port, protocol, bind, broadcast });
  }

  /**
   * Binds to a local address/port, receiving datagrams from any peer.
   * Replies must go through `send(data, peer)` with the `peer` a `message`
   * event handed you - see METHOD_SEND_TO's comment in lws-socket.c for why
   * a plain `send(data)` isn't safe for a bound socket serving many peers.
   */
  bind(address, port) {
    return this.#connect({ address, port, bind: true });
  }

  #connect({ address, port, protocol = 'raw', bind, broadcast }) {
    const isServer = !!(bind || !address);

    this.readyState = CONNECTING;
    this.#wsi = UDPSocket.#create(this, ctx => ctx.createUdp({ address, port, protocol, bind: isServer, broadcast }), isServer);
    return this;
  }

  close(code) {
    return this.#wsi.close(code);
  }

  /**
   * Sends a datagram. Supports multiple signatures for compatibility:
   *
   * - `send(data, port, address)` - Bun.js signature: send to port/address
   * - `send(data, peer)` - Current signature: send to sockaddr46 peer object
   * - `send(data)` - Send to connected socket's default peer
   *
   * For bound sockets serving many peers, use the explicit peer signatures.
   * For connected sockets (one fixed peer), plain `send(data)` is fine.
   */
  send(data, portOrPeer, address) {
    // Bun.js signature: send(data, port, address)
    if(typeof portOrPeer === 'number' && typeof address === 'string') {
      const peer = new LWSSockAddr46(address, portOrPeer);
      return this.#wsi.write(data, peer);
    }
    
    // Current signature: send(data, peer)
    if(portOrPeer !== undefined) {
      return this.#wsi.write(data, portOrPeer);
    }
    
    // Connected socket: send(data)
    return this.#wsi.write(data);
  }

  /**
   * Sends to an explicit peer (a `sockaddr46` from a `message` event's
   * `peer`). For bound sockets serving many peers, use this instead of
   * plain `send(data)` to ensure the reply goes to the correct peer.
   */
  sendTo(data, peer) {
    return this.#wsi.write(data, peer);
  }

  static #ctx;
  static #sockets;
  static #pending;
  /* Only sockets created through #connect() (outbound "connected" or bound
     "server" - UDP has no separate accept step, see class doc above) hold a
     ref, except bind()'d ones: those call markServer() instead, same
     reasoning as TCPSocket.#ref - a bound socket is expected to run until
     something explicitly closes it. */
  static #ref = new ContextRefCounter(() => {
    UDPSocket.#ctx?.destroy();
    UDPSocket.#ctx = undefined;
    UDPSocket.#sockets = undefined;
  });

  static lws(s) {
    return s.#wsi;
  }

  static #create(s, connectFn, isServer) {
    const sockets = (this.#sockets ??= mapper());

    /* lws_create_adopt_udp() (unlike TCP's clientConnect()) fires its open
       callback synchronously, before connectFn() below even returns the
       wsi - so `sockets(wsi, s)` can't run first. #pending bridges that one
       synchronous window: whichever socket is currently being created is
       the only one that can possibly be adopting right now (JS is
       single-threaded, so no other #create() call can be interleaved). */
    const resolve = wsi => {
      let socket = sockets(wsi);

      if(!socket) sockets(wsi, (socket = this.#pending));

      return socket;
    };

    const fire = (wsi, type, props) => resolve(wsi).dispatchEvent({ type, target: resolve(wsi), ...props });

    this.#ctx ??= createContext({
      ...s.#options,
      protocols: [
        {
          name: 'raw',
          ...raw({
            open: wsi => {
              const socket = resolve(wsi);

              /* Set here, not by #connect()'s caller: open fires
                 synchronously from inside connectFn() (see #create's
                 #pending comment), before #connect() gets `wsi` back to
                 assign - an `open` listener calling send() needs #wsi to
                 already be in place. */
              socket.#wsi ??= wsi;
              socket.readyState = OPEN;
              fire(wsi, 'open');
            },
            message: (wsi, data, size, peer) => fire(wsi, 'message', { data, size, peer }),
            close: wsi => {
              resolve(wsi).readyState = CLOSED;
              fire(wsi, 'close');
              this.#ref.release(wsi);
            },
            error: (wsi, message) => {
              fire(wsi, 'error', { message });
              this.#ref.release(wsi);
            },
          }),
        },
      ],
    });

    this.#pending = s;

    const wsi = connectFn(this.#ctx);

    this.#pending = undefined;
    sockets(wsi, s);

    if(isServer) this.#ref.markServer();
    else this.#ref.add(wsi);

    return wsi;
  }

  /**
   * Synthesizes a `createServer()`-compatible protocol descriptor: every
   * wsi opened under it (typically via `ctx.createUdp({ protocol: name })`,
   * on a context/vhost shared with other protocols) is wrapped as a
   * `UDPSocket` and handed to `callback` once, on open. Mirrors
   * `WebSocketStream.protocol()` (see lib/websocketstream.js) and
   * `TCPSocket.protocol()`.
   *
   * @param  {string}   name      Protocol name (matches `createUdp()`'s
   *                              `protocol` option / a mount's `protocol`)
   * @param  {Function} callback  `(socket: UDPSocket) => void`, called once
   *                              per opened wsi
   * @return {object}             A protocol descriptor for `createServer()`'s
   *                              (or `createContext()`'s) `protocols` array
   */
  static protocol(name, callback) {
    const adapters = new WeakMap();

    const wrap = wsi => {
      const socket = new UDPSocket();

      socket.#wsi = wsi;
      socket.readyState = OPEN;
      return socket;
    };

    return {
      name,
      ...raw({
        open: wsi => {
          const socket = wrap(wsi);

          adapters.set(wsi, socket);
          callback(socket);
        },
        message: (wsi, data, size, peer) => {
          const socket = adapters.get(wsi);

          socket?.dispatchEvent({ type: 'message', target: socket, data, size, peer });
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

define(UDPSocket, states);
define(UDPSocket.prototype, states);

UDPSocket.prototype[Symbol.toStringTag] = 'UDPSocket';

define(UDPSocket.prototype, { binaryType: 'arraybuffer' }, { writable: true });
define(UDPSocket.prototype, { readyState: undefined }, { writable: true, enumerable: true });
