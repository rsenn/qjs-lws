/**
 * Raw-socket SOCKS4/4a/5 listener. libwebsockets has no SOCKS-server role at
 * all (only a SOCKS5 *client*, see onward.js) - this hand-parses the
 * handshake on a plain accepted TCP connection, same `raw()` primitive as
 * examples/raw-proxy-fallback/server.js and http-proxy-listener.js.
 *
 * Only CMD=CONNECT is implemented for both versions - BIND and UDP ASSOCIATE
 * reply "command not supported" (documented limitation). SOCKS5 replies "no
 * auth required" and doesn't support username/password sub-negotiation
 * (RFC 1929) - also a documented limitation, fine for a LAN/loopback proxy.
 */
import { TCPSocketStream } from '../../../lib/tcpsocketstream.js';
import { accumulateUntil, writeBytes } from './byte-utils.js';
import { dial, relay, writeAndClose } from './onward.js';
import {
  decodeSocks4Request,
  decodeSocks5Greeting,
  decodeSocks5Request,
  encodeSocks4Reply,
  encodeSocks5MethodSelection,
  encodeSocks5Reply,
  SOCKS4_CMD_CONNECT,
  SOCKS5_CMD_CONNECT,
  SOCKS5_REP_COMMAND_NOT_SUPPORTED,
  SOCKS5_REP_GENERAL_FAILURE,
  SOCKS5_REP_SUCCEEDED,
} from './socks-protocol.js';

const SOCKS5_NO_AUTH = 0x00;
const SOCKS5_NO_ACCEPTABLE_METHOD = 0xff;

async function handleSocks4(client, reader, initial, opts) {
  let result;

  try {
    result = await accumulateUntil(reader, decodeSocks4Request, initial);
  } finally {
    reader.releaseLock();
  }

  if(!result) return;

  const { cmd, host, port } = result.decoded;

  if(cmd !== SOCKS4_CMD_CONNECT) {
    opts.log(`SOCKS4: unsupported command ${cmd}`);
    await writeAndClose(client, encodeSocks4Reply({ granted: false }));
    return;
  }

  opts.log(`SOCKS4 CONNECT -> ${host}:${port}`);

  let onward;
  try {
    onward = await dial({ host, port }, opts.onward);
  } catch(e) {
    opts.log(`onward connect to ${host}:${port} failed: ${e.message}`);
    await writeAndClose(client, encodeSocks4Reply({ granted: false }));
    return;
  }

  await writeBytes(client.writable, encodeSocks4Reply({ granted: true, host, port }));
  await relay(client, onward);
}

async function handleSocks5(client, reader, initial, opts) {
  let reqResult;

  try {
    const greeting = await accumulateUntil(reader, decodeSocks5Greeting, initial);
    if(!greeting) return;

    const noAuth = greeting.decoded.methods.includes(SOCKS5_NO_AUTH);
    await writeBytes(client.writable, encodeSocks5MethodSelection(noAuth ? SOCKS5_NO_AUTH : SOCKS5_NO_ACCEPTABLE_METHOD));

    if(!noAuth) {
      opts.log('SOCKS5: client offered no acceptable (unauthenticated) method');
      return;
    }

    reqResult = await accumulateUntil(reader, decodeSocks5Request, greeting.rest);
  } finally {
    reader.releaseLock();
  }

  if(!reqResult) return;

  const { cmd, host, port } = reqResult.decoded;

  if(cmd !== SOCKS5_CMD_CONNECT) {
    opts.log(`SOCKS5: unsupported command ${cmd}`);
    await writeAndClose(client, encodeSocks5Reply({ rep: SOCKS5_REP_COMMAND_NOT_SUPPORTED }));
    return;
  }

  opts.log(`SOCKS5 CONNECT -> ${host}:${port}`);

  let onward;
  try {
    onward = await dial({ host, port }, opts.onward);
  } catch(e) {
    opts.log(`onward connect to ${host}:${port} failed: ${e.message}`);
    await writeAndClose(client, encodeSocks5Reply({ rep: SOCKS5_REP_GENERAL_FAILURE }));
    return;
  }

  await writeBytes(client.writable, encodeSocks5Reply({ rep: SOCKS5_REP_SUCCEEDED }));
  await relay(client, onward);
}

async function handleConnection(client, opts) {
  const reader = client.readable.getReader();

  const probe = await accumulateUntil(reader, buf => (buf.length >= 1 ? { consumed: 0, version: buf[0] } : null));
  if(!probe) {
    reader.releaseLock();
    return;
  }

  if(probe.decoded.version === 4) return handleSocks4(client, reader, probe.buf, opts);
  if(probe.decoded.version === 5) return handleSocks5(client, reader, probe.buf, opts);

  opts.log(`unrecognized SOCKS version byte: 0x${probe.decoded.version.toString(16)}`);
  reader.releaseLock();
  client.readable.cancel().catch(() => {});
}

/**
 * @param  {object}   opts
 * @param  {object}   opts.onward  Passed straight to onward.js's `dial()`
 * @param  {Function} [opts.log]   `(msg) => void`, defaults to a no-op
 * @return {object}   A protocol descriptor for `createServer()`'s `protocols` array
 */
export function createSocksListener(opts) {
  const resolvedOpts = { log: () => {}, ...opts };

  return TCPSocketStream.protocol('socks', async stream => {
    const client = await stream.opened;

    try {
      await handleConnection(client, resolvedOpts);
    } catch(e) {
      resolvedOpts.log(`connection error: ${e.message}`);
    }
  });
}
