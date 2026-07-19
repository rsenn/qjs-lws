/**
 * Raw-socket HTTP/1.1 proxy listener - CONNECT tunneling and plain
 * (absolute-URI or Host:-header) forwarding for every other method.
 *
 * Bypasses lws's own HTTP role entirely: libwebsockets' server.c rejects any
 * request-target that doesn't start with '/' (HTTP_STATUS_FORBIDDEN) before
 * any JS callback ever runs - exactly what a forward-proxy request looks
 * like ("GET http://host/path HTTP/1.1"). Hand-parsing the request line and
 * headers ourselves on a raw TCP accept, same primitive as
 * examples/raw-proxy-fallback/server.js, sidesteps that restriction entirely
 * and gives CONNECT and every other method the same treatment.
 *
 * Each accepted connection is proxied to the single destination resolved
 * from its *first* request. If a client pipelines further requests to a
 * *different* origin over the same (non-CONNECT) connection, only the
 * first destination is honoured from that point on - this is a dumb byte
 * relay, not a real HTTP proxy that parses every subsequent request.
 */
import { TCPSocketStream } from '../../../lib/tcpsocketstream.js';
import { accumulateUntil, bytesToString, writeBytes } from './byte-utils.js';
import { dial, relay, writeAndClose } from './onward.js';

const MAX_HEAD_SIZE = 64 * 1024;

/** Parses the request line + headers once `\r\n\r\n` has arrived. Returns null (need more bytes) or `{method, target, httpVersion, headers, consumed}`. */
function parseHead(buf) {
  const text = bytesToString(buf);
  const idx = text.indexOf('\r\n\r\n');

  if(idx === -1) {
    if(buf.length > MAX_HEAD_SIZE) throw new Error('request head too large');
    return null;
  }

  const lines = text.slice(0, idx).split('\r\n');
  const [method, target, httpVersion] = lines[0].split(' ');
  if(!method || !target) throw new Error(`malformed request line: ${JSON.stringify(lines[0])}`);

  const headers = Object.create(null);
  for(const line of lines.slice(1)) {
    const c = line.indexOf(':');
    if(c < 0) continue;
    const name = line.slice(0, c).trim().toLowerCase();
    const value = line.slice(c + 1).trim();
    headers[name] = name in headers ? `${headers[name]}, ${value}` : value;
  }

  return { method, target, httpVersion, headers, consumed: idx + 4 };
}

const ABSOLUTE_URI_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/:?#]+)(?::(\d+))?/;

/** CONNECT: target is `host:port` directly. Otherwise: an absolute-URI target, or else the Host: header (default port 80). */
function resolveDestination(method, target, headers) {
  if(method === 'CONNECT') {
    const c = target.lastIndexOf(':');
    if(c < 0) return null;
    return { host: target.slice(0, c), port: Number(target.slice(c + 1)) };
  }

  const abs = ABSOLUTE_URI_RE.exec(target);
  if(abs) return { host: abs[1], port: abs[2] ? Number(abs[2]) : 80 };

  const hostHeader = headers['host'];
  if(!hostHeader) return null;

  const c = hostHeader.lastIndexOf(':');
  return c < 0 ? { host: hostHeader, port: 80 } : { host: hostHeader.slice(0, c), port: Number(hostHeader.slice(c + 1)) };
}

async function handleConnection(client, opts) {
  const reader = client.readable.getReader();
  let result;

  try {
    result = await accumulateUntil(reader, parseHead);
  } catch(e) {
    reader.releaseLock();
    opts.log(`bad request: ${e.message}`);
    await writeAndClose(client, 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return;
  }

  reader.releaseLock();
  if(!result) return; // connection closed before a full request head arrived

  const { decoded: head, buf: bufferedRequest } = result;
  const destination = resolveDestination(head.method, head.target, head.headers);
  if(!destination) {
    opts.log(`could not resolve a destination for: ${head.method} ${head.target}`);
    await writeAndClose(client, 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return;
  }

  opts.log(`${head.method} ${head.target} -> ${destination.host}:${destination.port}`);

  let onward;
  try {
    onward = await dial(destination, opts.onward);
  } catch(e) {
    opts.log(`onward connect to ${destination.host}:${destination.port} failed: ${e.message}`);
    await writeAndClose(client, 'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    return;
  }

  if(head.method === 'CONNECT') {
    await writeBytes(client.writable, 'HTTP/1.1 200 Connection Established\r\n\r\n');
    await relay(client, onward);
    return;
  }

  // Plain forwarding: the origin server expects a normal HTTP request, so
  // replay everything already read (request line + headers + any body
  // bytes buffered alongside them) onward verbatim before relaying the rest.
  await relay(client, onward, bufferedRequest);
}

/**
 * @param  {object}   opts
 * @param  {object}   opts.onward  Passed straight to onward.js's `dial()`
 * @param  {Function} [opts.log]   `(msg) => void`, defaults to a no-op
 * @return {object}   A protocol descriptor for `createServer()`'s `protocols` array
 */
export function createHttpProxyListener(opts) {
  const resolvedOpts = { log: () => {}, ...opts };

  return TCPSocketStream.protocol('http-proxy', async stream => {
    const client = await stream.opened;

    try {
      await handleConnection(client, resolvedOpts);
    } catch(e) {
      resolvedOpts.log(`connection error: ${e.message}`);
    }
  });
}
