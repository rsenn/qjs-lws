/**
 * Investigates the mechanism behind ollama-repl's "only the first prompt
 * gets a reply, every one after it just hangs" report (see git log for
 * the OllamaClient/GeminiClient fix, and their IDLE_RECONNECT_MS doc
 * comments): OllamaClient/GeminiClient each reuse one kept-alive
 * (LCCSCF_PIPELINE) HTTP/1.1 connection for every request, and a request
 * sent after the connection has sat idle long enough for the *server* to
 * close it silently just hangs forever - no reply, no error - because
 * lws's pipelining never notices the close before reusing the wsi.
 *
 * Reproduced here without Ollama or any external process: this project's
 * own HTTP server closes an idle HTTP/1.1 client connection after
 * `keepalive_timeout` seconds (lws default 5s, see
 * libwebsockets/include/libwebsockets/lws-context-vhost.h) - the exact
 * same mechanism, just given a short (1s) timeout so the same class of
 * failure shows up in about a second instead of Ollama's observed ~90s.
 *
 * Two variants of the same probe, against the same fixture server, to
 * localize which layer is responsible for not detecting the dead
 * connection:
 *  - the bare lws.so client API (LWSContext + a protocol object with
 *    onEstablishedClientHttp/onReceiveClientHttp callbacks) - same shape
 *    as tests/unittests/test-client.js's own "HTTP client (GET)" case.
 *  - lib/lws/protocols.js's httpClient() adapter - what
 *    OllamaClient/GeminiClient actually build on.
 * If both hang the same way, the gap is native/lws-level, below either
 * JS layer - if only httpClient() hangs, the bug is in that adapter's
 * own bookkeeping instead.
 *
 * Result so far: neither variant reproduces a hang against this local
 * fixture server, even though the exact same idle-gap-then-reuse pattern
 * reliably hung against a real Ollama server (see the fixed BUGS entry's
 * git history). Most likely explanation: this server's keepalive_timeout
 * closes the idle connection *cleanly* (a real FIN), which the client
 * notices immediately on its next write/read attempt and reports as a
 * normal connection error - not the same failure mode as whatever
 * happened against Ollama, where nothing ever notices the connection is
 * gone at all. That points at something more like a silently black-holed
 * connection (no FIN/RST ever reaching the client - e.g. a stalled/half-
 * open TCP state) rather than a plain graceful idle-timeout close, which
 * this fixture can't reproduce without deliberately dropping packets
 * (e.g. an iptables DROP rule, not attempted here) instead of just
 * closing the socket normally.
 */
import { LWSContext, createServer, LCCSCF_PIPELINE, LWS_WRITE_HTTP_FINAL, LWSMPRO_CALLBACK, toString } from 'lws.so';
import createContext from '../lib/lws/context.js';
import { httpClient } from '../lib/lws/protocols.js';
import * as std from 'std';

function assert(cond, message) {
  if(!cond) throw new Error('assertion failed: ' + message);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Races `promise` against a timeout so a hang shows up as a rejection
    instead of wedging this whole script forever. */
function withTimeout(promise, ms, timeoutMessage) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const PORT = 28940;
const KEEPALIVE_TIMEOUT_SECS = 1;
// Comfortably past KEEPALIVE_TIMEOUT_SECS, so the server side has
// definitely already dropped the idle connection by the time the second
// request goes out.
const IDLE_GAP_MS = 1800;
// How long a single probe is allowed to run before it's counted as a
// hang rather than a slow-but-working response.
const HANG_TIMEOUT_MS = 5000;

/** In-process fixture server: replies 'pong' to every request, and (via
    a short keepalive_timeout) drops an idle HTTP/1.1 client connection
    quickly - the same mechanism a real server (Ollama's included) uses
    at its own, much longer, default. */
function startServer() {
  return createServer({
    port: PORT,
    vhostName: 'localhost',
    keepalive_timeout: KEEPALIVE_TIMEOUT_SECS,
    mounts: [{ mountpoint: '/', protocol: 'http', originProtocol: LWSMPRO_CALLBACK }],
    protocols: [
      {
        name: 'http',
        onHttp(wsi) {
          wsi.respond(200, { 'content-type': 'text/plain' });
          wsi.write('pong', LWS_WRITE_HTTP_FINAL);
        },
      },
    ],
  });
}

/** One GET / over `ctx`'s existing (possibly already-pipelined)
    connection, via the bare lws.so client API. Unlike
    tests/unittests/test-client.js's own "HTTP client (GET)" case, this
    can't stash per-request state on `this` inside the callbacks below -
    confirmed directly (see git history/commit message for this file)
    that `this` there is some fresh per-session object, unrelated to (and
    not even prototype-linked to) the protocol descriptor object passed
    to `new LWSContext()` - so a later request's callbacks can't see
    anything stored by an earlier one that way. `pending` (module-scope,
    reassigned per call) carries the resolve/reject for whichever request
    is currently in flight instead - safe here since this probe only ever
    has one request outstanding at a time. */
let pending = null;

function requestPlainApi(ctx) {
  return new Promise((resolve, reject) => {
    pending = { resolve, reject, status: undefined };
    ctx.clientConnect({
      address: 'localhost',
      port: PORT,
      path: '/',
      host: 'localhost',
      method: 'GET',
      protocol: 'http',
      ssl_connection: LCCSCF_PIPELINE,
    });
  });
}

async function probe(label, requestOnce, destroy) {
  console.log(`\n=== ${label} ===`);

  try {
    const first = await withTimeout(requestOnce(), HANG_TIMEOUT_MS, 'first request timed out - unexpected, the fixture server should be immediately reachable');
    assert(first.status === 200 && first.body === 'pong', `unexpected first response: ${JSON.stringify(first)}`);
    console.log('first request (fresh connection): OK');

    console.log(`waiting ${IDLE_GAP_MS}ms (> ${KEEPALIVE_TIMEOUT_SECS}s server keepalive_timeout) before reusing the connection...`);
    await sleep(IDLE_GAP_MS);

    const second = await withTimeout(
      requestOnce(),
      HANG_TIMEOUT_MS,
      `second request never settled within ${HANG_TIMEOUT_MS}ms - HANGS, same failure mode as the ollama-repl report`,
    );
    assert(second.status === 200 && second.body === 'pong', `unexpected second response: ${JSON.stringify(second)}`);
    console.log('second request (idle-reused pipelined connection): OK - no hang reproduced');
    return true;
  } catch(e) {
    console.log(`FAILED - ${e.message}`);
    return false;
  } finally {
    destroy();
  }
}

async function testPlainApi() {
  const proto = {
    name: 'http',
    onEstablishedClientHttp(wsi, status) {
      if(pending) pending.status = status;
    },
    // Recognized native callback name (LWS_CALLBACK_RECEIVE_CLIENT_HTTP_READ)
    // - wsi.httpClientRead(buf) below re-enters synchronously into this
    // with the real (wsi, buf, len), same as lib/lws/protocols.js's own
    // onReceiveClientHttpRead doc comment describes; no manual dispatch
    // needed (confirmed directly: defining this and just calling
    // httpClientRead() is enough).
    onReceiveClientHttp(wsi) {
      wsi.httpClientRead(new ArrayBuffer(4096));
    },
    onReceiveClientHttpRead(wsi, buf, len) {
      if(pending) {
        const { resolve, status } = pending;
        pending = null;
        resolve({ status, body: toString(buf, 0, len) });
      }
    },
    onClientConnectionError(wsi, msg) {
      if(pending) {
        const { reject } = pending;
        pending = null;
        reject(new Error(`connection error: ${msg}`));
      }
    },
    onClosedClientHttp(wsi) {
      if(pending) {
        const { reject } = pending;
        pending = null;
        reject(new Error('closed before a body was received'));
      }
    },
  };

  const ctx = new LWSContext({ protocols: [proto] });

  return probe('plain lws.so API', () => requestPlainApi(ctx), () => ctx.destroy());
}

async function testHttpClientAdapter() {
  const settled = new Map();
  const adapter = httpClient((req, resp) => settled.get(req)?.resolve(resp), {
    error: (req, err) => settled.get(req)?.reject(new Error(`connection error: ${err.message}`)),
  });
  const ctx = createContext({ protocols: [{ name: 'http', ...adapter }] });

  async function requestOnce() {
    const { req } = await adapter.connect(ctx, `http://localhost:${PORT}/`, { method: 'GET', ssl_connection: LCCSCF_PIPELINE });
    const resp = await new Promise((resolve, reject) => settled.set(req, { resolve, reject }));
    return { status: resp.status, body: await resp.text() };
  }

  return probe('httpClient() (lib/lws/protocols.js)', requestOnce, () => ctx.destroy());
}

async function main() {
  const server = startServer();

  let plainOk, adapterOk;
  try {
    plainOk = await testPlainApi();
    adapterOk = await testHttpClientAdapter();
  } finally {
    server.destroy();
  }

  console.log('\n=== summary ===');
  console.log(`plain lws.so API,  idle-reused connection: ${plainOk ? 'OK' : 'HANGS/FAILS'}`);
  console.log(`httpClient() adapter, idle-reused connection: ${adapterOk ? 'OK' : 'HANGS/FAILS'}`);

  if(!plainOk && !adapterOk) {
    console.log('\nBoth layers fail the same way -> the dead-pipelined-connection');
    console.log('detection gap is native/lws-level, below both JS layers.');
  } else if(plainOk && !adapterOk) {
    console.log('\nOnly httpClient() fails -> the gap is in that JS adapter, not lws itself.');
  } else if(!plainOk && adapterOk) {
    console.log('\nOnly the plain API failed (unexpected) -> re-check the plain-API probe itself.');
  } else {
    console.log('\nNeither reproduced a hang - this server likely closes the idle');
    console.log('connection cleanly (a real FIN), which the client notices right away.');
    console.log('The real Ollama failure looks more like a silently black-holed');
    console.log('connection (no FIN/RST ever arriving) - not reproducible here without');
    console.log('deliberately dropping packets instead of just closing the socket.');
  }

  if(!plainOk || !adapterOk) std.exit(1);
}

main()
  .catch(e => {
    console.log('TEST FAILED:', e, e?.stack);
    std.exit(1);
  })
  .then(() => std.exit(0));
