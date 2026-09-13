#!/usr/bin/env qjsm
/**
 * Demo program (not a unit test) for the lib/rpc/ stack: serves a
 * JsonRpcHandler wrapping createRemoteObjectEndpoint({ Array, Map, Set,
 * Date, Uint32Array }) over WebSocket (lib/rpc/socket-server.js), plus a
 * browser playground (tests/jsonrpc-ws-playground/) that loads
 * lib/rpc/socket-client.js and lib/rpc/remote-object-factory.js directly
 * as ES modules - via createWebSocketClient(), socket-client.js's
 * browser-WebSocket-compatible entry point - to instantiate, invoke, and
 * inspect those classes remotely from the browser.
 *
 * Keeps running until interrupted (Ctrl+C) - point a browser at the
 * printed URL. Run from the repo root: qjsm tests/test-jsonrpc-ws.js
 * (mount origins below are relative to the repo root).
 */
import { createServer, LWSContext, LWSMPRO_FILE, LWSMPRO_NO_MOUNT } from 'lws.so';
import { WsProtocol, WsClientProtocol } from '../lib/lws/protocols.js';
import { JsonRpcHandler } from '../lib/rpc/json-rpc-handler.js';
import { createRemoteObjectEndpoint, TEARDOWN } from '../lib/rpc/remote-object-endpoint.js';
import { createRemoteObjectFactory } from '../lib/rpc/remote-object-factory.js';
import { createWsServerHandlers, createWebSocketServer } from '../lib/rpc/socket-server.js';
import { createWsClientHandlers } from '../lib/rpc/socket-client.js';
import { WebSocket } from '../lib/websocket.js';

const port = 19731;

const remoteObjectMethods = createRemoteObjectEndpoint({ Array, Map, Set, Date, Uint32Array });
const rpc = new JsonRpcHandler({ methods: remoteObjectMethods });

/* Reversed-roles endpoint at /rpc-reverse: the browser dials out (it can
   only ever be the WS transport *client*) and, once connected, plays the
   JSON-RPC *server* via createWebSocketServer() (socket-server.js) - this
   process, despite accepting the connection (WS transport *server*), plays
   the JSON-RPC *client* via createWsClientHandlers() (socket-client.js),
   wired into an accepting WsProtocol instead of the usual WsClientProtocol -
   that handlers object only needs open(wsi)/wsi.write(), which an accepting
   protocol's wsi supports exactly the same as a connecting one. */
const reverseClient = createWsClientHandlers();

let resolveReverseOpen;
const reverseOpened = new Promise(resolve => (resolveReverseOpen = resolve));

const server = createServer({
  port,
  vhostName: 'localhost',
  mounts: [
    { mountpoint: '/rpc', protocol: 'jsonrpc', originProtocol: LWSMPRO_NO_MOUNT },
    { mountpoint: '/rpc-reverse', protocol: 'jsonrpc-reverse', originProtocol: LWSMPRO_NO_MOUNT },
    { mountpoint: '/lib', origin: './lib', originProtocol: LWSMPRO_FILE, protocol: 'http' },
    { mountpoint: '/', origin: './tests/jsonrpc-ws-playground', def: 'index.html', originProtocol: LWSMPRO_FILE, protocol: 'http' },
  ],
  protocols: [
    { name: 'http' },
    new WsProtocol({
      name: 'jsonrpc',
      ...createWsServerHandlers(rpc),
      close() {
        remoteObjectMethods[TEARDOWN]();
      },
    }),
    new WsProtocol({
      name: 'jsonrpc-reverse',
      ...reverseClient,
      open(wsi) {
        reverseClient.open(wsi);
        resolveReverseOpen();
      },
    }),
  ],
});

console.log(`playground:   http://localhost:${port}/`);
console.log(`RPC endpoint: ws://localhost:${port}/rpc`);

/* Quick self-test through the exact same client stack the browser uses
   (createWsClientHandlers()/createRemoteObjectFactory()), so a startup
   failure here is caught immediately instead of only surfacing once
   someone opens the playground. Its own connection is torn down right
   after - only `server` stays up for the browser. */
let resolveOpen, rejectOpen;
const opened = new Promise((resolve, reject) => {
  resolveOpen = resolve;
  rejectOpen = reject;
});

const client = createWsClientHandlers();

const protocol = new WsClientProtocol({
  name: 'jsonrpc',
  ...client,
  open(wsi) {
    client.open(wsi);
    resolveOpen();
  },
  error(wsi, msg) {
    rejectOpen(new Error(msg));
  },
});

const selfTestCtx = new LWSContext({ protocols: [protocol] });
protocol.connect(selfTestCtx, `ws://localhost:${port}/rpc`, { protocols: 'jsonrpc' });
await opened;

const factory = createRemoteObjectFactory(client.call);
const arr = await factory.new('Array', 1, 2, 3);
await arr.push(4);
console.log('self-test: new Array(1, 2, 3), .push(4) -> length', await arr.length);
await factory.delete(arr);

selfTestCtx.destroy();

/* Reversed-roles self-test: lib/websocket.js's WebSocket class is built to
   match the browser's own exactly (see its header comment), so it stands in
   for a browser page here - it dials out to /rpc-reverse and serves a tiny
   JsonRpcHandler via createWebSocketServer(), the same call a real browser
   page would make. `reverseClient` (registered on the accepting side above)
   is the one making the JSON-RPC call despite being the WS transport
   *server*. */
const reverseRpc = new JsonRpcHandler({ methods: { ping: () => 'pong' } });
const reverseWs = new WebSocket(`ws://localhost:${port}/rpc-reverse`, 'jsonrpc-reverse');

await new Promise((resolve, reject) => {
  reverseWs.addEventListener('open', () => resolve(), { once: true });
  reverseWs.addEventListener('error', () => reject(new Error('WebSocket error')), { once: true });
});
createWebSocketServer(reverseWs, reverseRpc);
await reverseOpened;

console.log("self-test (reversed roles): reverseClient.call('ping') ->", await reverseClient.call('ping', []));

reverseWs.close();

/* Interactive REPL, if this qjsm build has qjs-modules' 'repl' module (same
   optional-dependency situation as 'textcode'/'bjson' elsewhere in this
   project - not every qjsm binary is built with it) - lets a person at the
   terminal drive `reverseClient.call()`/`.notify()` (the JSON-RPC *client*
   half of the reversed-roles /rpc-reverse endpoint above) by hand, to send
   commands to whatever's currently connected there acting as the JSON-RPC
   *server* (a real browser tab, once the playground opens that connection -
   see tests/jsonrpc-ws-playground/client.js). The REPL evaluates typed
   input as plain JS in the global scope, so `call`/`notify` are exposed as
   globals rather than the module-scope `const`s above. */
try {
  const { REPL } = await import('repl');

  globalThis.call = reverseClient.call;
  globalThis.notify = reverseClient.notify;
  globalThis.factory = createRemoteObjectFactory(reverseClient.call);

  const repl = new REPL('rpc', true);
  repl.historyLoad();

  console.log(`REPL ready - factory.new(className, ...args)/.list()/.delete(obj)/.id(obj) drive the createRemoteObjectEndpoint() a browser page serves over ws://localhost:${port}/rpc-reverse (see tests/jsonrpc-ws-playground/client.js); call('method', [params])/notify(...) send a raw JSON-RPC request there instead`);
  repl.run();
} catch(error) {
  // 'repl' module not built into this qjsm - no interactive REPL, demo still runs headless
}
