/**
 * Forwards bytes between a QuickJS debug target (raw TCP, quickjs-debugger.c
 * protocol) and a browser tab (WebSocket). This server does not speak the
 * debugger protocol at all — it is a dumb byte pipe. demo.js implements the
 * protocol client-side.
 *
 * Run:
 *   qjs server.js
 *   (open http://localhost:9229/)
 *   QUICKJS_DEBUG_ADDRESS=127.0.0.1:9229 qjs target.js
 */
import { LLL_ERR, LLL_WARN, logLevel, createServer, LWSMPRO_FILE, LWSMPRO_NO_MOUNT, LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG } from 'lws';

logLevel(LLL_ERR, LLL_WARN);

const PORT = 9229;

let browser = null; // wsi of the connected browser tab (WebSocket)
let target = null; // wsi of the connected debug target (raw TCP)

createServer({
  port: PORT,
  vhostName: 'localhost',
  options: LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG,
  listenAcceptRole: 'raw-skt',
  listenAcceptProtocol: 'target',
  mounts: [
    { mountpoint: '/debug', protocol: 'browser', originProtocol: LWSMPRO_NO_MOUNT },
    { mountpoint: '/', origin: '.', def: 'demo.html', originProtocol: LWSMPRO_FILE, protocol: 'http' },
  ],
  protocols: [
    { name: 'http' },

    // browser <-> here, over WebSocket at /debug
    {
      name: 'browser',
      onEstablished(wsi) {
        browser = wsi;
        console.log('browser connected');
      },
      onClosed() {
        browser = null;
        console.log('browser disconnected');
      },
      onReceive(wsi, data) {
        console.log('tcp rx <- browser rx', data);
        target?.write(data);
      },
    },

    // debug target <-> here, over a plain TCP socket
    {
      name: 'target',
      onRawAdopt(wsi) {
        target = wsi;
        console.log('debug target connected');
      },
      onRawClose() {
        target = null;
        console.log('debug target disconnected');
      },
      onRawRx(wsi, data) {
        console.log('tcp rx -> browser tx', data);
        browser?.write(data);
      },
    },
  ],
});

console.log(`open http://localhost:${PORT}/`);
console.log(`then:  QUICKJS_DEBUG_ADDRESS=127.0.0.1:${PORT} qjs target.js`);
