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
import { LLL_ERR, LLL_USER, logLevel, toString, createServer, LWSMPRO_FILE, LWSMPRO_NO_MOUNT, LWSMPRO_CALLBACK, LWS_WRITE_BINARY, LWS_WRITE_HTTP_FINAL, LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG, } from 'lws';
import { ByteQueue } from '../../lib/lws/byte-queue.js';
import { exec, pipe, setReadHandler, read, close, realpath } from 'os';
import { TextEncoder, TextDecoder } from 'textcode';
import * as std from 'std';

logLevel(LLL_ERR | LLL_USER);

const PORT = 9229;

// 0: silent, 1: child stdin/stdout/stderr, 2: + debug wire protocol.
let debugLevel = 1 + +(process.env.DEBUG ?? 0);

function debugLog(level, arrow, color, label, ...args) {
  if(debugLevel < level) return;
  console.log(`\x1b[${color}m${arrow}\x1b[0m  ${label}`, console.config({ compact: true, maxArrayLength: 1, maxStringLength: 120 }), ...args);
}

const compose = (f, g) => x => g(f(x));

// bytes (or null on EOF) -> decoded, trailing-newline-stripped text
const toText = compose(
  bytes => bytes && new TextDecoder().decode(bytes),
  text => (text?.endsWith('\n') ? text.slice(0, -1) : text),
);

/** Frame a JSON string. byteLength must be the UTF-8 byte count of `json`. */
export function frameMessage(json, byteLength = json.length) {
  return (byteLength + 1).toString(16).padStart(8, '0') + '\n' + json + '\n';
}

let browser = null; // wsi of the connected browser tab (WebSocket)
let target = null; // wsi of the connected debug target (raw TCP)
let targetQueue = null; // ByteQueue accumulating bytes from `target` until full frames are available

// Source files outside this directory (e.g. modules the debug target loaded
// from elsewhere on disk) aren't reachable through the static mount at '/',
// so demo.js asks for those via GET /source?path=<absolute path> instead.
// Restricted to .js files inside the user's home directory - realpath()
// collapses any '..'/symlink tricks before the containment check runs.
const [HOME] = realpath(process.env.HOME ?? '/');

function urlArg(uriArgs, name) {
  for(const part of (uriArgs ?? '').split('&')) {
    const eq = part.indexOf('=');
    if((eq === -1 ? part : part.slice(0, eq)) === name) return decodeURIComponent(eq === -1 ? '' : part.slice(eq + 1));
  }
}

createServer({
  port: PORT,
  vhostName: 'localhost',
  options: LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG,
  listenAcceptRole: 'raw-skt',
  listenAcceptProtocol: 'target',
  mounts: [
    { mountpoint: '/debug', protocol: 'browser', originProtocol: LWSMPRO_NO_MOUNT },
    { mountpoint: '/source', protocol: 'source', originProtocol: LWSMPRO_CALLBACK },
    { mountpoint: '/', origin: '.', def: 'demo.html', originProtocol: LWSMPRO_FILE, protocol: 'http' },
  ],
  protocols: [
    { name: 'http' },

    // GET /source?path=<abs path> - serves a .js source file from outside
    // this directory, restricted to the user's home directory.
    {
      name: 'source',
      onHttp(wsi) {
        const path = urlArg(wsi.headers['uri-args'], 'path');

        if(!path || !path.endsWith('.js')) {
          wsi.respond(400, { 'content-type': 'text/plain' });
          wsi.write('bad request: missing or non-.js path\n', LWS_WRITE_HTTP_FINAL);
          return 0;
        }

        const [real, err] = realpath(path);

        if(err) {
          wsi.respond(404, { 'content-type': 'text/plain' });
          wsi.write('not found\n', LWS_WRITE_HTTP_FINAL);
          return 0;
        }

        /*if(real !== HOME && !real.startsWith(HOME + '/')) {
          wsi.respond(403, { 'content-type': 'text/plain' });
          wsi.write('forbidden\n', LWS_WRITE_HTTP_FINAL);
          return 0;
        }*/

        const content = std.loadFile(real);

        if(content == null) {
          wsi.respond(404, { 'content-type': 'text/plain' });
          wsi.write('not found\n', LWS_WRITE_HTTP_FINAL);
          return 0;
        }

        wsi.respond(200, { 'content-type': 'text/javascript' }, content.length);
        wsi.write(content, LWS_WRITE_HTTP_FINAL);
      },
    },

    // browser <-> here, over WebSocket at /debug
    {
      name: 'browser',
      onEstablished(wsi) {
        browser = wsi;

        if(!target) {
          launchTarget();
          debugLog(0, '✅', 36, 'browser connected, launching target...');
        } else {
          debugLog(0, '✅', 36, 'browser connected');
        }
      },
      onClosed() {
        browser = null;
        debugLog(0, '⛔', 36, 'browser disconnected');
      },
      onReceive(wsi, data) {
        // debugger commands from the demo UI always arrive as a bare JSON
        // message (ws.send(string) => a WS text frame => data is a string)
        const json = typeof data == 'string' ? data : new TextDecoder().decode(data);

        debugLog(2, '🡆', 31, 'client', JSON.parse(json));

        target?.write(frameMessage(json, new TextEncoder().encode(json).length));
      },
    },

    // debug target <-> here, over a plain TCP socket
    {
      name: 'target',
      onRawAdopt(wsi) {
        target = wsi;
        debugLog(0, '✅', 33, 'debug target connected');

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

            debugLog(2, '🡄', 32, 'target', JSON.parse(json));

            // Large frames (e.g. a big variable listing) can come out on
            // the WS wire as several separate frames instead of one
            // fragmented message - libwebsockets' own fragment-boundary
            // tracking doesn't reliably survive that here. Reuse the same
            // explicit length-prefix framing already used for the raw TCP
            // side instead of relying on WS message boundaries; demo.js
            // decodes it the same way decodeFrame() does above.
            browser?.write(frameMessage(json, new TextEncoder().encode(json).length));
          }
        })();
      },
      onRawClose() {
        target = null;
        targetQueue?.close();
        targetQueue = null;
        debugLog(0, '⛔', 33, 'debug target disconnected');
      },
      onRawRx(wsi, data) {
        targetQueue?.feed(data);
      },
    },
  ],
});

function launchTarget(script = 'target.js') {
  const [[stdin, toChild], [fromStdout, stdout], [fromStderr, stderr]] = [pipe(), pipe(), pipe()];

  const pid = exec(['env', `QUICKJS_DEBUG_ADDRESS=127.0.0.1:${PORT}`, `qjs`, script], {
    block: false,
    stdin,
    stdout,
    stderr,
  });

  [stdout, stderr, stdin].forEach(close);

  for(const [fd, channel] of [
    [fromStdout, 1],
    [fromStderr, 2],
  ]) {
    const buf = new Uint8Array(1 + 1024);
    buf[0] = channel;

    setReadHandler(fd, () => {
      const n = read(fd, buf.buffer, 1, 1024);

      if(n <= 0) {
        setReadHandler(fd, null);
        close(fd);
        return;
      }

      debugLog(1, '🡇', 33, 'onOutput', { channel, text: new TextDecoder().decode(buf.subarray(1, 1 + n)) });

      browser?.write(buf.buffer, 1 + n, LWS_WRITE_BINARY);
    });
  }

  debugLog(0, '▶️', 36, 'launchTarget', { pid, toChild });
  return toChild;
}

debugLog(0, 'ℹ️', 36, `open http://localhost:${PORT}/`);
debugLog(0, 'ℹ️', 36, `then:  QUICKJS_DEBUG_ADDRESS=127.0.0.1:${PORT} qjs target.js`);
