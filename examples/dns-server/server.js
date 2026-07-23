/**
 * A caching recursive DNS resolver: listens on UDP/53, answers client
 * queries by walking the referral chain from the IANA root hints down to
 * an authoritative answer (see resolver.js), talking UDP to upstream
 * nameservers and falling back to TCP when needed.
 *
 * Exercises lws-context.c's UDP support end to end:
 *   - ctx.createUdp({ bind: true, ... })   the client-facing listener
 *   - ctx.createUdp({ address, ... })      one-shot connected sockets for
 *                                          each upstream UDP query
 *   - ctx.clientConnect({ method: 'RAW' }) the TCP fallback leg
 *   - wsi.sendTo(data, peerAddr)           reply to *this* query's client,
 *                                          not whichever peer the listener
 *                                          last happened to hear from
 *
 * Run (needs root, or `sudo setcap cap_net_bind_service=+ep $(which qjs)`,
 * to bind port 53):
 *   sudo qjs server.js
 *   dig @127.0.0.1 example.com
 *
 * Or on an unprivileged port:
 *   DNS_PORT=5353 qjs server.js
 *   dig @127.0.0.1 -p 5353 example.com
 */
import { createServer } from 'lws';
import { createResolver } from './resolver.js';
import { decodeMessage, encodeMessage, typeName, RCODE } from './dns-message.js';
import { toArrayBuffer } from './bytes.js';

const PORT = +(process.env.DNS_PORT ?? 53);

const resolver = createResolver();

async function handleQuery(wsi, data, len, peer) {
  let query;

  try {
    query = decodeMessage(data);
  } catch(e) {
    console.error(`[dns] malformed query from ${peer}: ${e.message}`);
    return;
  }

  const q = query.questions[0];
  if(!q) return;

  console.log(`[dns] ${peer.host}:${peer.port}  ${q.name} ${typeName(q.type)}`);

  let answers = [];
  let rcode = RCODE.NOERROR;

  try {
    const result = await resolver.resolve(q.name, q.type);
    answers = result.answers;
    rcode = result.header.rcode ?? RCODE.NOERROR;
  } catch(e) {
    console.error(`[dns] resolving ${q.name} ${typeName(q.type)} failed: ${e.message}`);
    rcode = RCODE.SERVFAIL;
  }

  const response = encodeMessage({
    header: { id: query.header.id, qr: 1, opcode: 0, aa: 0, tc: 0, rd: query.header.rd, ra: 1, rcode },
    questions: [q],
    answers,
  });

  try {
    wsi.sendTo(toArrayBuffer(response), peer);
  } catch(e) {
    console.error(`[dns] failed to reply to ${peer}: ${e.message}`);
  }
}

const ctx = createServer({
  vhostName: 'dns',
  protocols: [{ name: 'dns-listener', onRawRx: handleQuery }, ...resolver.protocols],
});

resolver.attach(ctx);

try {
  ctx.createUdp({ port: PORT, protocol: 'dns-listener', bind: true });
} catch(e) {
  console.error(`[dns] could not bind udp/${PORT}: ${e.message}`);
  console.error(PORT < 1024 ? 'Port 53 needs root (or cap_net_bind_service) - try DNS_PORT=5353 instead.' : '');
  throw e;
}

console.log(`[dns] recursive resolver listening on udp/${PORT}`);
