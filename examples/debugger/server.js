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
import { exec, pipe, setReadHandler, read, write, close } from 'os';
import { TextEncoder, TextDecoder } from 'textcode';

logLevel(LLL_ERR | LLL_USER);

const PORT = 9229;

let browser = null; // wsi of the connected browser tab (WebSocket)
let target = null; // wsi of the connected debug target (raw TCP)
let stdin = -1;

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
          stdin = launchTarget();
          console.log(`browser connected, launching target... (stdin = ${stdin})`);
        } else console.log('browser connected');
      },
      onClosed() {
        browser = null;
        console.log('browser disconnected');
      },
      onReceive(wsi, data) {
        const text = new TextDecoder().decode(data.slice(0, 9));

        const len = parseInt(text.slice(1), 16);
        const id = parseInt(text.slice(0, 1), 16);

        //console.log('onReceive', console.config({ compact: true, maxStringLength: 32 }), { data: new TextDecoder().decode(data), text });

        let written;

        if(id) {
          written = write(stdin, data, 9, len);
        } else {
          written = target?.write(data);
        }

        console.log('onReceive', console.config({ compact: true }), { written, len, id });
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
  const [in_r, in_w] = pipe();
  const [out_r, out_w] = pipe();
  const [err_r, err_w] = pipe();

  const pid = exec(['env', `QUICKJS_DEBUG_ADDRESS=127.0.0.1:${PORT}`, `qjs`, script], { block: false, stdin: in_r, stdout: out_w, stderr: err_w });

  close(out_w);
  close(err_w);
  close(in_r);

  [
    [out_r, 1],
    [err_r, 2],
  ].forEach(([fd, id]) => {
    const rbuf = new ArrayBuffer(1024 + 9);

    setReadHandler(fd, () => {
      const r = read(fd, rbuf, 9, 1024);

      console.log('readable', console.config({ compact: true }), { pid, in_w, r });

      const u8 = new Uint8Array(rbuf);
      const lenstr = id.toString(16) + r.toString(16).padStart(7, '0') + '\n';

      u8.set(new TextEncoder().encode(lenstr), 0);

      const payload = u8.subarray(0, 9 + r);
      browser?.write(payload.buffer);
    });
  });

  console.log('launchTarget', { pid, in_w });
  return in_w;
}

console.log(`open http://localhost:${PORT}/`);
console.log(`then:  QUICKJS_DEBUG_ADDRESS=127.0.0.1:${PORT} qjs target.js`);
