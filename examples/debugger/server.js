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
import { LLL_ERR, LLL_WARN, LLL_USER, LLL_DEBUG, logLevel, toString, createServer, LWSMPRO_FILE, LWSMPRO_NO_MOUNT, LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG } from 'lws';
import { exec, pipe, setReadHandler, read } from 'os';
import { TextEncoder } from 'textcode';

logLevel(LLL_ERR | LLL_USER);

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

        if(!target) {
          console.log('browser connected, launching target...');
          launchTarget();
        } else console.log('browser connected');
      },
      onClosed() {
        browser = null;
        console.log('browser disconnected');
      },
      onReceive(wsi, data) {
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
        browser?.write(data);
      },
    },
  ],
});

function launchTarget(script = 'target.js') {
  let [out_r, out_w] = pipe();
  let [err_r, err_w] = pipe();

  let ret = exec(['env', `QUICKJS_DEBUG_ADDRESS=127.0.0.1:${PORT}`, `qjs`, script], { block: false, stdout: out_w, stderr: err_w });

  [
    [out_r, 1],
    [err_r, 2],
  ].map(([fd, id]) => {
    const rbuf = new ArrayBuffer(1024 + 9);

    setReadHandler(fd, () => {
      const r = read(fd, rbuf, 9, 1024);
      //console.log(`readable fd=${fd}, r=${r}`);

      const u8 = new Uint8Array(rbuf);
      const lenstr = (r ^ (id << 30)).toString(16).padStart(8, '0') + '\n';

      u8.set(new TextEncoder().encode(lenstr), 0);

      const payload = u8.subarray(0, 9 + r);

      console.log('browser.write', escape(new TextDecoder().decode(payload)));
      browser?.write(payload.buffer);
    });
  });

  console.log('launchTarget', { ret });
}

console.log(`open http://localhost:${PORT}/`);
console.log(`then:  QUICKJS_DEBUG_ADDRESS=127.0.0.1:${PORT} qjs target.js`);
