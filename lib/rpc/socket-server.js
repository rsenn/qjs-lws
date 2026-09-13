import { codecs, createMessageUnframer, frameMessage } from './common.js';

/* No dependency on 'lws.so'/'../lws/protocols.js' at the top level for the
   browser-loadable createWebSocketServer() below - createWsServerHandlers()
   is lws-only (never called from a browser), so it alone needs
   reassembleFragments() for WS's multi-callback large-message delivery (see
   lib/lws/protocols.js) - loaded with a dynamic import, gated the same way
   ./common.js gates toArrayBuffer/toString. */
const isBrowser = typeof globalThis.TextEncoder !== 'undefined' && typeof globalThis.TextDecoder !== 'undefined';

let reassembleFragments;
if(!isBrowser) ({ reassembleFragments } = await import('../lws/protocols.js'));

/**
 * Core per-message JSON-RPC server logic, parameterized by how a reply gets
 * written back (`write`) - shared by createSocketOnMessage() below (lws
 * wsi.write()) and createWebSocketServer() (browser ws.send()).
 *
 * @param  {JsonRpcHandler} rpc
 * @param  {object} codec
 * @param  {(wsi, value: object) => void} write
 * @return {(wsi, data) => Promise<void>}
 */
function createRpcMessageHandler(rpc, codec, write) {
  return async (wsi, data) => {
    let rpcRequest;

    try {
      rpcRequest = codec.decode(data);
    } catch(error) {
      write(wsi, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }

    const rpcResponse = await rpc.handleRequest(rpcRequest);

    if(rpcResponse !== undefined) write(wsi, rpcResponse);
  };
}

/**
 * Function that serves a transport-agnostic JsonRpcHandler over one message
 * per call. WS frames its own messages, so `framed` is false there; a
 * raw/TCP socket has no such framing, so `framed` wraps this in
 * createMessageUnframer() (./common.js) on the way in and writes replies
 * via frameMessage() on the way out, so the client's own unframer can find
 * message boundaries.
 *
 * @param  {JsonRpcHandler} rpc   The JsonRpcHandler service
 * @param  {object} codec         wire codec (./common.js's `codecs`)
 * @param  {boolean} [framed]     true for a raw/TCP socket, false for WS
 * @return {Function}             The message() handler
 */
export function createSocketOnMessage(rpc, codec, framed = false) {
  const write = (wsi, value) => wsi.write(framed ? frameMessage(codec.encode(value)) : codec.encode(value));
  const handleOne = createRpcMessageHandler(rpc, codec, write);

  return framed ? createMessageUnframer(handleOne) : handleOne;
}

/**
 * Creates and object { message(wsi, message) {} } that can be used
 * for serve({  websocket: {} }) or for WsProtocol/RawProtocol
 *
 * @param  {JsonRpcHandler} rpc   The JsonRpcHandler service
 * @param  {object} codec         wire codec (./common.js's `codecs`)
 * @param  {boolean} [framed]     true for a raw/TCP socket, false for WS
 * @return {object}
 */
export function createSocketHandler(rpc, codec, framed = false) {
  return {
    message: createSocketOnMessage(rpc, codec, framed),
  };
}

/**
 * Returns the `{ message }` handlers for serving `rpc` over WebSocket. This
 * file has no dependency on ../lws/protocols.js or lws.so at all (that's the
 * point - a browser can load it) - constructing the actual `WsProtocol` from
 * these handlers is entirely up to the caller:
 *
 *   import { WsProtocol } from '../lws/protocols.js';
 *   const protocol = new WsProtocol({ name: 'jsonrpc', ...createWsServerHandlers(rpc) });
 *
 * Wraps the message handler in reassembleFragments() (../lws/protocols.js)
 * so a WS message spilling across more than one native receive callback -
 * anything over the connection's ~4096-byte service buffer - is buffered
 * and delivered to `rpc` whole instead of each piece independently failing
 * to parse.
 *
 * @param  {JsonRpcHandler} rpc
 * @param  {{ codec?: object }} [options]  wire codec (./common.js's
 *   `codecs`); defaults to `codecs.json()`
 * @return {{ message: Function }}
 */
export function createWsServerHandlers(rpc, options = null) {
  const codec = options?.codec ?? codecs.json();
  const { message } = createSocketHandler(rpc, codec, false);
  return { message: reassembleFragments(message) };
}

/**
 * Returns the `{ message }` handlers for serving `rpc` over a raw/TCP socket -
 * messages are length-prefix framed (frameMessage()/createMessageUnframer(),
 * ./common.js) since raw sockets, unlike WS, have no built-in message
 * boundary. Like createWsServerHandlers() above, construct the `RawProtocol`
 * from these handlers yourself:
 *
 *   import { RawProtocol } from '../lws/protocols.js';
 *   const protocol = new RawProtocol({ name: 'jsonrpc', ...createRawServerHandlers(rpc) });
 *
 * @param  {JsonRpcHandler} rpc
 * @param  {{ codec?: object }} [options]  wire codec (./common.js's
 *   `codecs`); defaults to `codecs.json()`
 * @return {{ message: Function }}
 */
export function createRawServerHandlers(rpc, options = null) {
  const codec = options?.codec ?? codecs.json();
  return createSocketHandler(rpc, codec, true);
}

/**
 * Serves `rpc` over an already-constructed, standard event-based WebSocket -
 * the browser's own `WebSocket`, or this project's lib/websocket.js
 * `WebSocket` (deliberately built to match it). Needs no lws.so-specific
 * class, just `.send()` and `addEventListener('message', ...)`, so this
 * (unlike createWsServerHandlers() above) is the one to call from a browser -
 * it lets a page loaded over an outgoing WebSocket connection (a browser can
 * only ever be the WS transport *client*) act as the JSON-RPC *server*,
 * while whatever accepted that connection (the WS transport server) makes
 * the JSON-RPC calls instead, using createWsClientHandlers()
 * (./socket-client.js) wired into its own accepting `WsProtocol` - transport
 * client/server roles are independent of JSON-RPC client/server roles.
 *
 * `ws` must already be open (or about to be).
 *
 * @param  {WebSocket} ws
 * @param  {JsonRpcHandler} rpc
 * @param  {{ codec?: object }} [options]  wire codec (./common.js's
 *   `codecs`); defaults to `codecs.json()`
 * @return {void}
 */
export function createWebSocketServer(ws, rpc, options = null) {
  const codec = options?.codec ?? codecs.json();
  const handleOne = createRpcMessageHandler(rpc, codec, (_ws, value) => ws.send(codec.encode(value)));

  ws.addEventListener('message', e => handleOne(ws, e.data));
}
