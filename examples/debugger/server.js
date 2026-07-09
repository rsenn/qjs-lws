/**
 * Forwards bytes between a QuickJS debug target (raw TCP, quickjs-debugger.c
 * protocol) and a browser tab (WebSocket). This server does not speak the
 * debugger protocol at all — it is a dumb byte pipe. demo.js implements the
 * protocol client-side.
 *
 * Wire protocol on the WebSocket (each WS message is one unit, framing is
 * free courtesy of the transport):
 *   - a message starting with '{' is a debug-wire JSON message
 *   - a message starting with a byte < 0x20 is streamed target I/O: that
 *     first byte is a channel number (1 = stdout, 2 = stderr), the rest is
 *     raw output text
 *
 * The debug target itself speaks quickjs-debugger.c's own framing on its raw
 * TCP socket ("%08x '\n' <json> '\n'", the 8-hex-digit length counting json
 * + the trailing '\n'); server.js translates between that and the WS
 * protocol above.
 *
 * Run:
 *   qjs server.js
 *   (open http://localhost:9229/)
 *   QUICKJS_DEBUG_ADDRESS=127.0.0.1:9229 qjs target.js
 */
import { LLL_ERR, LLL_WARN, LLL_USER, LLL_DEBUG, logLevel, toString, createServer, LWSMPRO_FILE, LWSMPRO_NO_MOUNT, LWS_WRITE_BINARY, LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG, } from 'lws';
import { exec, pipe, setReadHandler, read, close } from 'os';
import { TextEncoder, TextDecoder } from 'textcode';

logLevel(LLL_ERR | LLL_USER);

const PORT = 9229;

const compose = (f, g) => x => g(f(x));

// bytes (or null on EOF) -> decoded, trailing-newline-stripped text
const toText = compose(
  bytes => bytes && new TextDecoder().decode(bytes),
  text => (text?.endsWith('\n') ? text.slice(0, -1) : text),
);

// Bridges the push-driven onRawRx callback into pull-style reads, so the
// frame decoder below can be written top-to-bottom like a synchronous
// parser (mirrors readFully()'s contract: resolves the requested number of
// bytes, or null once closed).
class ByteQueue {
  #buf = new Uint8Array(0);
  #closed = false;
  #waiting = null; // { n, resolve }

  feed(chunk) {
    const add = new Uint8Array(chunk);
    const buf = new Uint8Array(this.#buf.length + add.length);
    buf.set(this.#buf, 0);
    buf.set(add, this.#buf.length);
    this.#buf = buf;
    this.#check();
  }

  close() {
    this.#closed = true;
    this.#check();
  }

  read(n) {
    return new Promise(resolve => {
      this.#waiting = { n, resolve };
      this.#check();
    });
  }

  #check() {
    if(!this.#waiting) return;

    const { n, resolve } = this.#waiting;

    if(this.#buf.length >= n) {
      resolve(this.#buf.slice(0, n));
      this.#buf = this.#buf.subarray(n);
      this.#waiting = null;
    } else if(this.#closed) {
      resolve(null);
      this.#waiting = null;
    }
  }
}

let browser = null; // wsi of the connected browser tab (WebSocket)
let target = null; // wsi of the connected debug target (raw TCP)
let targetQueue = null; // ByteQueue accumulating bytes from `target` until full frames are available

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
          launchTarget();
          console.log('browser connected, launching target...');
        } else console.log('browser connected');
      },
      onClosed() {
        browser = null;
        console.log('browser disconnected');
      },
      onReceive(wsi, data) {
        // debugger commands from the demo UI always arrive as a bare JSON
        // message (ws.send(string) => a WS text frame => data is a string)
        const json = typeof data == 'string' ? data : new TextDecoder().decode(data);
        const body = new TextEncoder().encode(json);
        const header = new TextEncoder().encode((body.length + 1).toString(16).padStart(8, '0') + '\n');
        const frame = new Uint8Array(header.length + body.length + 1);

        frame.set(header, 0);
        frame.set(body, header.length);
        frame[frame.length - 1] = 0x0a;

        target?.write(frame.buffer);
      },
    },

    // debug target <-> here, over a plain TCP socket
    {
      name: 'target',
      onRawAdopt(wsi) {
        target = wsi;
        console.log('debug target connected');

        const queue = (targetQueue = new ByteQueue());
        const readText = n => queue.read(n).then(toText);

        async function decodeFrame() {
          const header = await readText(9); // 8 hex digits + '\n'
          if(header == null) return null;

          return readText(+('0x' + header)); // payload, length includes its own trailing '\n'
        }

        (async () => {
          for(;;) {
            const json = await decodeFrame();
            if(json == null) break; // target closed mid-frame or cleanly
            browser?.write(json);
          }
        })();
      },
      onRawClose() {
        target = null;
        targetQueue?.close();
        targetQueue = null;
        console.log('debug target disconnected');
      },
      onRawRx(wsi, data) {
        targetQueue?.feed(data);
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

  for(const [fd, channel] of [
    [out_r, 1],
    [err_r, 2],
  ]) {
    const rbuf = new ArrayBuffer(1 + 1024);
    const u8 = new Uint8Array(rbuf);
    u8[0] = channel;

    setReadHandler(fd, () => {
      const r = read(fd, rbuf, 1, 1024);

      if(r <= 0) {
        setReadHandler(fd, null);
        close(fd);
        return;
      }

      browser?.write(rbuf, 1 + r, LWS_WRITE_BINARY);
    });
  }

  console.log('launchTarget', { pid, in_w });
  return in_w;
}

console.log(`open http://localhost:${PORT}/`);
console.log(`then:  QUICKJS_DEBUG_ADDRESS=127.0.0.1:${PORT} qjs target.js`);
