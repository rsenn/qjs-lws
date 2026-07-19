/**
 * Resolves a `{host, port}` destination to a connected `{readable, writable}`
 * pair, per the configured onward mode, and the generic byte-relay pump used
 * by every listener once a destination is up. This is the file where the
 * plan's "everything reduces to piping bytes once a destination is known"
 * insight actually lives.
 */
import { TCPSocketStream } from '../../../lib/tcpsocketstream.js';
import { ReadableStream } from '../../../lib/lws/streams.js';
import { accumulateUntil, bytesToString, writeBytes } from './byte-utils.js';
import { decodeSocks4Reply, decodeSocks5MethodSelection, decodeSocks5Reply, encodeSocks4Request, encodeSocks5Greeting, encodeSocks5Request, SOCKS5_REP_SUCCEEDED } from './socks-protocol.js';

/** Bidirectionally pumps bytes between two `{readable, writable}` pairs until either side ends. Neither stream may already have an active reader/writer lock. */
export function pipePair(a, b) {
  return Promise.all([a.readable.pipeTo(b.writable).catch(() => {}), b.readable.pipeTo(a.writable).catch(() => {})]);
}

/**
 * Writes `prefix` (already-read bytes belonging to the client leg that must
 * still reach the onward leg - e.g. a forwarded HTTP request's buffered
 * head) onto `onward` before pumping the rest of both directions.
 */
export async function relay(client, onward, prefix) {
  if(prefix && prefix.length) await writeBytes(onward.writable, prefix);

  await pipePair(client, onward);
}

/** Writes a final reply/error to `client` (best-effort) and drops the connection - used by both listeners when a handshake fails or a destination can't be reached. */
export async function writeAndClose(client, data) {
  try {
    await writeBytes(client.writable, data);
  } catch {}

  client.readable.cancel().catch(() => {});
}

async function readExact(reader, n) {
  const result = await accumulateUntil(reader, buf => (buf.length >= n ? { consumed: n } : null));
  if(!result) throw new Error('onward: connection closed during handshake');

  return { taken: result.buf.subarray(0, n), rest: result.rest };
}

/* ------------------------------------------------------------------ *
 * direct - plain TCP, no bridging
 * ------------------------------------------------------------------ */

async function dialDirect({ host, port }) {
  const tcp = new TCPSocketStream({ host, port });
  return tcp.opened;
}

/* ------------------------------------------------------------------ *
 * socks5 - hand-rolled. libwebsockets does have its own built-in SOCKS5
 * *client* (vhost-level `socks_proxy_address`/`socks_proxy_port`, wired
 * through in lws-context.c and backed by libwebsockets/lib/core-net/
 * socks5-client.c) - but driving it via a bare RAW-role clientConnect(),
 * the way an onward dial to an arbitrary per-request destination needs,
 * didn't complete the handshake correctly in testing against a real SOCKS5
 * server. Hand-rolling it the same way as socks4 below is simpler to
 * reason about and verified to work correctly.
 * ------------------------------------------------------------------ */

async function dialViaSocks5(destination, onward) {
  const tcp = new TCPSocketStream({ host: onward.host, port: onward.port });
  const { readable, writable } = await tcp.opened;

  await writeBytes(writable, encodeSocks5Greeting());

  const reader = readable.getReader();
  let result;

  try {
    const greeting = await accumulateUntil(reader, decodeSocks5MethodSelection);
    if(!greeting) throw new Error('onward: SOCKS5 proxy closed the connection during the greeting');
    if(greeting.decoded.method !== 0x00) throw new Error(`onward: SOCKS5 proxy rejected our "no auth" method (chose 0x${greeting.decoded.method.toString(16)})`);

    await writeBytes(writable, encodeSocks5Request({ host: destination.host, port: destination.port }));

    result = await accumulateUntil(reader, decodeSocks5Reply, greeting.rest);
  } finally {
    reader.releaseLock();
  }

  if(!result) throw new Error('onward: SOCKS5 proxy closed the connection during CONNECT');
  if(result.decoded.rep !== SOCKS5_REP_SUCCEEDED) throw new Error(`onward: SOCKS5 proxy refused the connection (rep=${result.decoded.rep})`);

  return { readable: prependTo(readable, result.rest), writable };
}

/* ------------------------------------------------------------------ *
 * socks4 - hand-rolled (libwebsockets has no SOCKS4 client support at all)
 * ------------------------------------------------------------------ */

async function dialViaSocks4(destination, onward) {
  const tcp = new TCPSocketStream({ host: onward.host, port: onward.port });
  const { readable, writable } = await tcp.opened;

  await writeBytes(writable, encodeSocks4Request({ host: destination.host, port: destination.port }));

  const reader = readable.getReader();
  const { taken, rest } = await readExact(reader, 8);
  reader.releaseLock();

  const reply = decodeSocks4Reply(taken);
  if(!reply.granted) throw new Error(`onward SOCKS4 proxy rejected the connection (code ${taken[1]})`);

  return { readable: prependTo(readable, rest), writable };
}

/* ------------------------------------------------------------------ *
 * http-connect - bridge onward through an upstream HTTP(S) proxy's own
 * CONNECT method (hand-rolled, same reasoning as socks4 above)
 * ------------------------------------------------------------------ */

async function dialViaHttpConnect(destination, onward) {
  const tcp = new TCPSocketStream({ host: onward.host, port: onward.port });
  const { readable, writable } = await tcp.opened;

  const target = `${destination.host}:${destination.port}`;
  await writeBytes(writable, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Connection: keep-alive\r\n\r\n`);

  const reader = readable.getReader();
  const result = await accumulateUntil(reader, buf => {
    const idx = bytesToString(buf).indexOf('\r\n\r\n');
    return idx === -1 ? null : { consumed: idx + 4, headEnd: idx };
  });
  reader.releaseLock();

  if(!result) throw new Error('onward: upstream HTTP proxy closed the connection during CONNECT');

  const statusLine = bytesToString(result.buf.subarray(0, result.decoded.headEnd)).split('\r\n')[0];
  if(!/^HTTP\/1\.[01]\s+200\b/.test(statusLine)) throw new Error(`onward: upstream HTTP proxy refused CONNECT: ${statusLine}`);

  return { readable: prependTo(readable, result.rest), writable };
}

/** Wraps a `ReadableStream` so `leftover` bytes are yielded before anything else - used to put back bytes read past a handshake boundary. */
function prependTo(readable, leftover) {
  if(!leftover.length) return readable;

  let prepended = false;
  const reader = readable.getReader();

  return new ReadableStream({
    async pull(controller) {
      if(!prepended) {
        prepended = true;
        controller.enqueue(leftover);
        return;
      }

      const { value, done } = await reader.read();
      if(done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * @param  {{host:string, port:number}} destination
 * @param  {{mode:string, host?:string, port?:number}} onward
 * @return {Promise<{readable:ReadableStream, writable:WritableStream}>}
 */
export function dial(destination, onward) {
  switch(onward.mode) {
    case 'socks5':
      return dialViaSocks5(destination, onward);
    case 'socks4':
      return dialViaSocks4(destination, onward);
    case 'http-connect':
      return dialViaHttpConnect(destination, onward);
    case 'direct':
    default:
      return dialDirect(destination);
  }
}
