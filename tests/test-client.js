/**
 * Exercises the RAW client role (lib/tcpsocket.js / lib/tcpsocketstream.js,
 * both built on lib/lws/protocols.js's `raw()`/`stream()` adapters) - the
 * client roles not already covered by tests/test-fetch.js (HTTP/1.1+H2,
 * plain+TLS) or tests/test-websocket.js (WS): plain TCP and TCP+TLS.
 *
 * TCP+TLS is verified against `openssl s_server -rev` (spawned via
 * lib/lws/subprocess-stream.js) rather than a qjs-lws-hosted TLS server:
 * this project's own raw-skt server role doesn't currently complete a TLS
 * handshake (a native-level gap - the server accepts the connection and
 * hands it to the raw-skt role, but never progresses past that, even
 * though the equivalent client-side code path works correctly, as this
 * test demonstrates). That's a server-side limitation outside what was
 * asked here (client roles), so an independent, known-good TLS endpoint is
 * used instead to verify the client in isolation.
 *
 * "adopted UDP socket" (the third role originally asked for) is skipped:
 * it isn't reachable from JS at all in this binding.
 * `ctx.adoptSocket()`/`adoptSocketReadbuf()` are hardcoded to
 * `LWS_ADOPT_SOCKET|LWS_ADOPT_HTTP|LWS_ADOPT_ALLOW_SSL` (HTTP only), and
 * nothing in qjs-lws calls `lws_create_adopt_udp()` - there's no
 * UDP socket-creation or adoption primitive exposed to JS to test against.
 */
import { TCPSocket } from '../lib/tcpsocket.js';
import { TCPSocketStream } from '../lib/tcpsocketstream.js';
import { generateSelfSignedCert } from '../lib/lws/tls.js';
import { SubprocessStream } from '../lib/lws/subprocess-stream.js';
import { toString } from 'lws';
import { mkdir, sleepAsync, kill, SIGTERM, open, O_WRONLY } from 'os';
import * as std from 'std';

function assert(cond, message) {
  if(!cond) throw new Error('assertion failed: ' + message);
}

function writeFile(path, arrayBuffer) {
  const f = std.open(path, 'w');
  f.write(arrayBuffer, 0, arrayBuffer.byteLength);
  f.close();
}

/** Retries TCPSocketStream connect attempts until `opened` settles or `timeoutMs` elapses - used against the openssl fixture below, which has no machine-readable "ready" signal to poll instead. */
async function connectWithRetry(options, { timeoutMs = 5000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;

  for(;;) {
    const tss = new TCPSocketStream(options);

    try {
      const opened = await tss.opened;
      return { tss, ...opened };
    } catch(e) {
      if(Date.now() >= deadline) throw e;
      await sleepAsync(intervalMs);
    }
  }
}

/** Plain TCP: a TCPSocket echo server, a TCPSocketStream client. */
async function testPlainTcp(port) {
  console.log(`\n=== plain TCP (port ${port}) ===`);

  const server = new TCPSocket();
  server.bind('127.0.0.1', port);
  server.addEventListener('accept', ev => {
    ev.socket.addEventListener('message', e => ev.socket.send(e.data));
  });
  server.listen();

  const { tss, readable, writable, remoteAddress, remotePort } = await connectWithRetry({ host: '127.0.0.1', port });
  const writer = writable.getWriter();
  const reader = readable.getReader();

  await writer.write('hello-tcp');
  const { value } = await reader.read();
  const text = toString(value);

  assert(text === 'hello-tcp', `expected echo of 'hello-tcp', got ${JSON.stringify(text)}`);
  assert(remoteAddress === '127.0.0.1', `expected remoteAddress 127.0.0.1, got ${remoteAddress}`);
  assert(remotePort === port, `expected remotePort ${port}, got ${remotePort}`);

  tss.close();
  console.log('plain TCP: OK');
}

/** TCP+TLS: openssl s_server -rev as the fixture, TCPSocketStream as the client under test. */
async function testTcpTls(port) {
  console.log(`\n=== TCP+TLS (port ${port}) ===`);

  const dir = '/tmp/test-client-tls-fixture';
  mkdir(dir);

  const { cert, key } = generateSelfSignedCert({ commonName: 'localhost' });
  writeFile(`${dir}/cert.pem`, cert);
  writeFile(`${dir}/key.pem`, key);

  const devNull = open('/dev/null', O_WRONLY);
  const proc = SubprocessStream(['openssl', 's_server', '-accept', String(port), '-cert', `${dir}/cert.pem`, '-key', `${dir}/key.pem`, '-rev', '-quiet'], { stdout: devNull, stderr: devNull });

  try {
    const { tss, readable, writable } = await connectWithRetry({ host: '127.0.0.1', port, tls: { rejectUnauthorized: false } });
    const writer = writable.getWriter();
    const reader = readable.getReader();

    await writer.write('hello-tls\n');
    const { value } = await reader.read();
    const text = toString(value);

    assert(text === 'slt-olleh\n', `expected '-rev'-reversed echo 'slt-olleh\\n', got ${JSON.stringify(text)}`);

    tss.close();
    console.log('TCP+TLS: OK');
  } finally {
    kill(proc.pid, SIGTERM);
    await proc.exited;
  }
}

async function main() {
  await testPlainTcp(28930);
  await testTcpTls(28931);

  console.log('\nALL CLIENT ROLE TESTS PASSED');
}

main()
  .catch(e => {
    console.log('TEST FAILED:', e, e?.stack);
    std.exit(1);
  })
  .then(() => std.exit(0)); // the TCPSocket/TCPSocketStream shared contexts would otherwise keep the process alive
