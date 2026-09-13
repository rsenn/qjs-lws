import { IdSequencer, codecs, createMessageUnframer, frameMessage } from './common.js';

/**
 * Handles one incoming JSON-RPC response, resolving/rejecting the matching
 * pending call in `pending` (id -> { resolve, reject }).
 *
 * @param  {Map} pending
 * @param  {object} codec  wire codec (./common.js's `codecs`)
 * @return {Function}     The message() handler
 */
export function createSocketClientOnMessage(pending, codec) {
  return function(wsi, data) {
    let response;

    try {
      response = codec.decode(data);
    } catch(error) {
      return;
    }

    const resolvers = pending.get(response.id);
    if(!resolvers) return;

    pending.delete(response.id);

    if(response.error) {
      const error = new Error(response.error.message);
      error.code = response.error.code;
      error.data = response.error.data;
      resolvers.reject(error);
    } else {
      resolvers.resolve(response.result);
    }
  };
}

/** Shared `call()`/`notify()` pair, parameterized only by how a request gets written. */
function createCaller(pending, seq, write) {
  function call(method, params) {
    const id = seq();
    const request = { jsonrpc: '2.0', method, params, id };

    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      write(request);
    });
  }

  function notify(method, params) {
    write({ jsonrpc: '2.0', method, params });
  }

  return { call, notify };
}

/**
 * Builds the `{ open, message, close, call, notify }` object a JSON-RPC 2.0
 * client needs, minus anything WS/raw-socket-specific - shared by
 * createWsClientHandlers()/createRawClientHandlers() below and by
 * createWebSocketClient(), parameterized only by how a request gets
 * written (`write`) and, for reading, whether replies need unframing
 * (`framed`).
 *
 * @param  {object} codec
 * @param  {(request: object) => void} write
 * @param  {boolean} framed
 * @return {{ open(wsi): void, message: Function, close(): void, call: Function, notify: Function }}
 */
function createSocketClientHandlers(codec, write, framed) {
  const pending = new Map();
  const seq = IdSequencer();
  let wsi;

  const onMessage = createSocketClientOnMessage(pending, codec);

  return {
    open(w) {
      wsi = w;
    },
    message: framed ? createMessageUnframer(onMessage) : onMessage,
    close() {
      wsi = undefined;
      for(const resolvers of pending.values()) resolvers.reject(new Error('closed'));
      pending.clear();
    },
    ...createCaller(pending, seq, request => {
      // wsi is cleared on close() - without this check, a call() issued after
      // disconnect (or before the first connect) reuses a stale/absent wsi
      // and reaches wsi.write() natively instead of failing in JS (confirmed
      // directly: a stale wsi crashed with "InternalError: lwsjs_socket_write:
      // s->wsi == NULL" instead of a clean rejection).
      if(!wsi) throw new Error('not connected');
      write(wsi, request);
    }),
  };
}

/**
 * Returns the `{ open, message, close, call, notify }` handlers for making
 * JSON-RPC 2.0 calls over WebSocket. This file has no dependency on
 * ../lws/protocols.js or lws.so at all (that's the point - a browser can
 * load it) - constructing the actual `WsClientProtocol` from these
 * handlers, and connecting it, is entirely up to the caller:
 *
 *   import { WsClientProtocol } from '../lws/protocols.js';
 *   const handlers = createWsClientHandlers();
 *   const protocol = new WsClientProtocol({
 *     name: 'jsonrpc',
 *     ...handlers,
 *     open(wsi) { handlers.open(wsi); resolveOpen(); },  // layer in your own
 *     error(wsi, msg) { rejectOpen(new Error(msg)); },
 *   });
 *   const ctx = new LWSContext({ protocols: [protocol] });
 *   protocol.connect(ctx, url, { protocols: 'jsonrpc' });
 *
 * @param  {{ codec?: object }} [rpcOptions]  wire codec (./common.js's
 *   `codecs`); defaults to `codecs.json()`
 * @return {{ open(wsi): void, message: Function, close(): void, call: Function, notify: Function }}
 */
export function createWsClientHandlers(rpcOptions = null) {
  const codec = rpcOptions?.codec ?? codecs.json();

  return createSocketClientHandlers(codec, (wsi, request) => wsi.write(codec.encode(request)), false);
}

/**
 * Returns the `{ open, message, close, call, notify }` handlers for making
 * JSON-RPC 2.0 calls over a raw/TCP socket - messages are length-prefix
 * framed (frameMessage()/createMessageUnframer(), ./common.js) since raw
 * sockets, unlike WS, have no built-in message boundary. Like
 * createWsClientHandlers() above, this has no dependency on
 * ../lws/protocols.js - construct the `RawProtocol` from these handlers
 * yourself:
 *
 *   import { RawProtocol } from '../lws/protocols.js';
 *   const handlers = createRawClientHandlers();
 *   const protocol = new RawProtocol({ name: 'jsonrpc', ...handlers, ... });
 *   const ctx = new LWSContext({ protocols: [protocol] });
 *   ctx.clientConnect({ host, port, method: 'RAW', protocol: 'jsonrpc' });
 *
 * @param  {{ codec?: object }} [rpcOptions]  wire codec (./common.js's
 *   `codecs`); defaults to `codecs.json()`
 * @return {{ open(wsi): void, message: Function, close(): void, call: Function, notify: Function }}
 */
export function createRawClientHandlers(rpcOptions = null) {
  const codec = rpcOptions?.codec ?? codecs.json();

  return createSocketClientHandlers(codec, (wsi, request) => wsi.write(frameMessage(codec.encode(request))), true);
}

/**
 * Makes JSON-RPC 2.0 calls over an already-constructed, standard
 * event-based WebSocket - the browser's own `WebSocket`, or this project's
 * lib/websocket.js `WebSocket` (deliberately built to match it). Needs no
 * lws.so-specific class, just `.send()` and `addEventListener('message' |
 * 'close', ...)`, so this (unlike createWsClientHandlers() above) is the
 * one to call from a browser - pair it with remote-object-factory.js's
 * createRemoteObjectFactory() there.
 *
 * `ws` must already be open (or about to be) - wait for its 'open' event
 * yourself before calling call()/notify().
 *
 * @param  {WebSocket} ws
 * @param  {{ codec?: object }} [rpcOptions]  wire codec (./common.js's
 *   `codecs`); defaults to `codecs.json()`
 * @return {{ call: Function, notify: Function }}
 */
export function createWebSocketClient(ws, rpcOptions = null) {
  const pending = new Map();
  const seq = IdSequencer();
  const codec = rpcOptions?.codec ?? codecs.json();
  const onMessage = createSocketClientOnMessage(pending, codec);

  ws.addEventListener('message', e => onMessage(ws, e.data));
  ws.addEventListener('close', () => {
    for(const resolvers of pending.values()) resolvers.reject(new Error('closed'));
    pending.clear();
  });

  return createCaller(pending, seq, request => ws.send(codec.encode(request)));
}
