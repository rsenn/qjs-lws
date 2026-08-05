import createContext, { ContextRefCounter } from './lws/context.js';
import { EventTargetProperties } from './lws/events.js';
import { raw } from './lws/protocols.js';
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

  /** Bun `Socket#end()`-compatible alias for close() - graceful vs. forced
      close aren't distinguished at the wsi level here, so both just close. */
  end(code) {
    return this.close(code);
  }

  send(data) {
    return this.#wsi.write(data);
  }

  /** Bun `Socket#write()`-compatible alias for send(). */
  write(data) {
    return this.send(data);
  }

  static #ctx;
  static #sockets;
  /* Only outbound (connectFn-created) sockets hold a ref on the shared
     context (see #create below) - releasing the last one tears it down so
     a script with no other pending work can exit. Once .listen() has ever
     called markServer(), auto-destroy is disabled for good: a listening
     socket doesn't keep its own #wsi (see #create), so there's no reliable
     "server closed" signal to resume counting from - a server is expected
     to run until something explicitly calls .close()/.destroy() on it. */
  static #ref = new ContextRefCounter(() => {
    TCPSocket.#ctx?.destroy();
    TCPSocket.#ctx = undefined;
    TCPSocket.#sockets = undefined;
  });

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

    if(connectFn) {
      const wsi = connectFn(this.#ctx);

      this.#ref.add(wsi);
      sockets(wsi, s);
      return wsi;
    }

    this.#ref.markServer();
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

  /**
   * `Bun.listen()`-compatible: https://bun.com/docs/runtime/networking/tcp
   * Starts a raw TCP listener and returns a `TCPSocketListener` (`.stop()`/
   * `.unref()`/`.ref()`), same shape Bun's own `Bun.listen()` returns.
   *
   * Deliberately does NOT go through `new TCPSocket()` + instance
   * `.bind()`/`.listen()` (unlike `connect()` below) - those share one
   * `LWSContext` across every `TCPSocket` in the process (`#ctx`/`#ref`,
   * see `#create()`), which has no way to tear down just one listener:
   * the only teardown available is `LWSContext#destroy()`, and calling
   * that on the shared context would also kill every other listener AND
   * every open client connection sharing it. `.stop()` needs to affect
   * only *this* listener, so this builds its own private `LWSContext`
   * instead (same 'raw' protocol/role wiring `#create()` uses) and
   * destroys that.
   *
   * Only TCP (`hostname`/`port`) is supported - this project's raw role
   * has no UNIX-domain-socket wiring, so `unix` isn't accepted. `tls` is
   * passed through to the underlying `createContext()` call (see
   * `lib/lws/context.js`'s own `tls` handling) but, unlike `fetch()`, this
   * class doesn't yet set the per-connection `ssl_connection` flags TLS
   * needs on top of that - plain TCP only, for now.
   *
   * @param  {object}   options
   * @param  {string}   [options.hostname]  Address to bind
   * @param  {number}   options.port
   * @param  {object}   [options.socket]    `{ open, data, close, error,
   *                                         drain }`, each `(socket, ...)`
   *                                         - matches Bun's handler names;
   *                                         `drain` isn't wired (use the
   *                                         existing `TCPSocket.waitWrite()`
   *                                         instead if you need it).
   * @return {{ stop: Function, unref: Function, ref: Function }}
   */
  static listen({ hostname, port, socket: handlers = {}, ...rest } = {}) {
    const { open, data, close, error } = handlers;
    const sockets = mapper();

    const ctx = createContext({
      ...rest,
      address: hostname,
      port,
      listenAcceptRole: 'raw-skt',
      listenAcceptProtocol: 'raw',
      options: (rest.options ?? 0) | LWS_SERVER_OPTION_ONLY_RAW | LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG,
      protocols: [
        {
          name: 'raw',
          ...raw({
            open: wsi => {
              const s = TCPSocket.#accept(wsi);

              sockets(wsi, s);
              s.addEventListener('message', e => data?.(s, e.data));
              s.addEventListener('close', () => close?.(s));
              s.addEventListener('error', e => error?.(s, new Error(e.message)));
              open?.(s);
            },
            message: (wsi, d, size) => sockets(wsi)?.dispatchEvent({ type: 'message', target: sockets(wsi), data: d, size }),
            close: wsi => {
              const s = sockets(wsi);

              if(s) {
                s.readyState = CLOSED;
                s.dispatchEvent({ type: 'close', target: s });
              }
            },
          }),
        },
      ],
    });

    return {
      stop: () => ctx.destroy(),
      unref() {},
      ref() {},
    };
  }

  /**
   * `Bun.connect()`-compatible: https://bun.com/docs/runtime/networking/tcp
   * Opens a raw TCP client connection and resolves once connected, to the
   * `TCPSocket` itself (which already carries Bun's `write()`/`end()`/
   * `.data`/`remoteAddress`/`localPort` surface - see those members
   * above) - built on the same `new TCPSocket(host, port)` connect path,
   * just entered through Bun's config-object shape and a Promise instead
   * of the 'open'/'error' events.
   *
   * Same TCP-only/no-`unix`/best-effort-`tls` caveats as `listen()` above.
   *
   * @param  {object} options
   * @param  {string} options.hostname
   * @param  {number} options.port
   * @param  {object} [options.socket]  `{ open, data, close, error,
   *                                    connectError, drain, end, timeout }`
   *                                    - `data`/`close`/`error` wired same
   *                                    as listen(); `connectError` fires
   *                                    (in addition to `error`) for a
   *                                    failed connect specifically;
   *                                    `drain`/`end`/`timeout` aren't
   *                                    wired (no underlying signal for
   *                                    them here yet).
   * @return {Promise<TCPSocket>}
   */
  static connect({ hostname, port, socket: handlers = {}, ...rest } = {}) {
    const { open, data, close, error, connectError } = handlers;

    return new Promise((resolve, reject) => {
      const s = new TCPSocket({ address: hostname, port, ...rest });

      s.addEventListener('message', e => data?.(s, e.data));
      s.addEventListener('close', () => close?.(s));

      s.addEventListener('open', () => {
        open?.(s);
        resolve(s);
      });

      s.addEventListener('error', e => {
        const err = new Error(e.message);

        error?.(s, err);

        if(s.readyState === CONNECTING) connectError?.(s, err);

        reject(err);
      });
    });
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

/** Bun `Socket#data`-compatible: arbitrary caller-attached per-socket
    context (e.g. a session id), unused internally. */
define(TCPSocket.prototype, { data: undefined }, { writable: true, enumerable: true });
