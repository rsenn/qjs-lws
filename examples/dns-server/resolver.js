/**
 * Iterative/recursive resolution: starting from the root hints, follow NS
 * referrals (using glue where given, otherwise resolving the NS's own A
 * record first) until an authoritative answer or NXDOMAIN comes back,
 * caching whatever RRsets show up along the way.
 *
 * Every upstream query is UDP first; if it comes back truncated (TC bit) or
 * the UDP leg fails outright (timeout, ICMP unreachable, a firewall that
 * only allows TCP/53), it's retried over TCP against the same server - see
 * queryServer() below.
 */
import { decodeMessage, buildQuery, TYPE, RCODE } from './dns-message.js';
import { ROOT_SERVERS } from './root-hints.js';
import { Cache } from './cache.js';
import { toArrayBuffer, concatBytes } from './bytes.js';

export function createResolver({ timeoutMs = 4000, maxHops = 32, maxGlueDepth = 2 } = {}) {
  const cache = new Cache();
  const pendingUdp = new Map(); // wsi -> { queryBuf, resolve, reject }
  const pendingTcp = new Map(); // wsi -> { queryBuf, chunks, resolve, reject }
  let ctx;
  let nextId = 1;

  function attach(context) {
    ctx = context;
  }

  function queryUdp(ip, port, queryBuf) {
    return new Promise((resolve, reject) => {
      let wsi;
      let settled = false;

      const timer = setTimeout(() => finish(new Error(`udp query to ${ip} timed out`)), timeoutMs);

      function finish(err, data) {
        if(settled)
          return;

        settled = true;
        clearTimeout(timer);

        if(wsi)
          pendingUdp.delete(wsi);

        try {
          wsi?.close();
        } catch {}

        err ? reject(err) : resolve(data);
      }

      try {
        wsi = ctx.createUdp({ address: ip, port, protocol: 'resolver-udp' });
      } catch(e) {
        clearTimeout(timer);
        reject(e);
        return;
      }

      pendingUdp.set(wsi, { queryBuf, resolve: d => finish(null, d), reject: e => finish(e) });
    });
  }

  function queryTcp(ip, port, queryBuf) {
    return new Promise((resolve, reject) => {
      let wsi;
      let settled = false;

      const timer = setTimeout(() => finish(new Error(`tcp query to ${ip} timed out`)), timeoutMs);

      function finish(err, data) {
        if(settled)
          return;

        settled = true;
        clearTimeout(timer);

        if(wsi)
          pendingTcp.delete(wsi);

        try {
          wsi?.close();
        } catch {}

        err ? reject(err) : resolve(data);
      }

      try {
        wsi = ctx.clientConnect({ address: ip, port, method: 'RAW', protocol: 'resolver-tcp' });
      } catch(e) {
        clearTimeout(timer);
        reject(e);
        return;
      }

      pendingTcp.set(wsi, { queryBuf, chunks: [], resolve: d => finish(null, d), reject: e => finish(e) });
    });
  }

  const protocols = [
    {
      name: 'resolver-udp',
      onRawAdopt(wsi) {
        const p = pendingUdp.get(wsi);
        if(p)
          wsi.write(toArrayBuffer(p.queryBuf));
      },
      onRawRx(wsi, data) {
        pendingUdp.get(wsi)?.resolve(new Uint8Array(data));
      },
      onRawClose(wsi) {
        pendingUdp.get(wsi)?.reject(new Error('udp socket closed before a reply arrived'));
      },
    },
    {
      name: 'resolver-tcp',
      onRawConnected(wsi) {
        const p = pendingTcp.get(wsi);
        if(!p)
          return;

        const len = p.queryBuf.length;
        const prefix = Uint8Array.of(len >> 8, len & 0xff);

        wsi.write(toArrayBuffer(concatBytes([prefix, p.queryBuf])));
      },
      onRawRx(wsi, data) {
        const p = pendingTcp.get(wsi);
        if(!p)
          return;

        p.chunks.push(new Uint8Array(data));

        const merged = concatBytes(p.chunks);
        if(merged.length < 2)
          return;

        const msgLen = (merged[0] << 8) | merged[1];
        if(merged.length >= 2 + msgLen)
          p.resolve(merged.subarray(2, 2 + msgLen));
      },
      onRawClose(wsi) {
        pendingTcp.get(wsi)?.reject(new Error('tcp socket closed before a reply arrived'));
      },
      onClientConnectionError(wsi, msg) {
        pendingTcp.get(wsi)?.reject(new Error(`tcp connect to upstream failed: ${msg}`));
      },
    },
  ];

  /* One query to one specific upstream server, UDP-first with a TCP retry
     (RFC 1035 4.2.2's mandatory case is TC=1; blocked/unreachable UDP is
     handled the same way here since the end result - "redo it over TCP" -
     is identical). */
  async function queryServer(ip, port, name, type) {
    const id = nextId++ & 0xffff;
    const queryBuf = buildQuery(name, type, id);

    let msg;

    try {
      msg = decodeMessage(await queryUdp(ip, port, queryBuf));
    } catch(udpErr) {
      return decodeMessage(await queryTcp(ip, port, queryBuf));
    }

    if(msg.header.tc)
      return decodeMessage(await queryTcp(ip, port, queryBuf));

    return msg;
  }

  function cacheKey(name, type) {
    return `${type}:${name.toLowerCase()}`;
  }

  function cacheRRs(name, type, rrs) {
    if(!rrs.length)
      return;

    cache.set(
      cacheKey(name, type),
      rrs,
      rrs.reduce((min, rr) => Math.min(min, rr.ttl), Infinity),
    );
  }

  /* Resolves a bare NS hostname to an IPv4 address, for referrals that
     didn't come with glue. Bounded by glueDepth so a pathological/hostile
     zone (NS pointing at a name whose own NS records point back at zones
     needing more glueless lookups) can't recurse forever. */
  async function resolveGlue(name, glueDepth) {
    const cached = cache.get(cacheKey(name, TYPE.A));
    if(cached)
      return cached[0]?.rdata.address;

    if(glueDepth >= maxGlueDepth)
      return null;

    try {
      const result = await resolve(name, TYPE.A, glueDepth + 1);
      return result.answers.find(rr => rr.type === TYPE.A)?.rdata.address;
    } catch {
      return null;
    }
  }

  /**
   * @param {string} name  fully-qualified, trailing dot optional
   * @param {number} type  a dns-message.js TYPE.* value
   * @returns {Promise<{header, answers, authorities, additionals}>}
   */
  async function resolve(name, type, glueDepth = 0) {
    if(!name.endsWith('.'))
      name += '.';

    const direct = cache.get(cacheKey(name, type));
    if(direct)
      return { header: { rcode: RCODE.NOERROR }, answers: direct, authorities: [], additionals: [] };

    let servers = ROOT_SERVERS.map(s => s.address);
    let currentName = name;
    const seenCnames = new Set();
    const cnameChain = [];

    for(let hop = 0; hop < maxHops; hop++) {
      let msg;
      let lastErr;

      for(const ip of servers) {
        try {
          msg = await queryServer(ip, 53, currentName, type);
          break;
        } catch(e) {
          lastErr = e;
        }
      }

      if(!msg)
        throw lastErr || new Error(`no reachable server while resolving ${currentName}`);

      const wanted = msg.answers.filter(rr => rr.name.toLowerCase() === currentName.toLowerCase() && rr.type === type);
      const cname = msg.answers.find(rr => rr.name.toLowerCase() === currentName.toLowerCase() && rr.type === TYPE.CNAME);

      if(wanted.length) {
        cacheRRs(currentName, type, wanted);
        return { header: msg.header, answers: [...cnameChain, ...wanted], authorities: [], additionals: [] };
      }

      if(cname) {
        if(seenCnames.has(cname.rdata.target))
          throw new Error(`CNAME loop detected resolving ${name}`);

        seenCnames.add(cname.rdata.target);
        cacheRRs(currentName, TYPE.CNAME, [cname]);
        cnameChain.push(cname);
        currentName = cname.rdata.target;
        servers = ROOT_SERVERS.map(s => s.address);
        continue;
      }

      if(msg.header.rcode === RCODE.NXDOMAIN || (!msg.authorities.length && msg.header.rcode !== RCODE.NOERROR))
        return { header: msg.header, answers: cnameChain, authorities: [], additionals: [] };

      const nsRecords = msg.authorities.filter(rr => rr.type === TYPE.NS);
      if(!nsRecords.length)
        /* NOERROR with no NS and no matching answer - either an empty
           non-terminal or the qtype just doesn't exist here (e.g. AAAA
           for an A-only name). Return whatever we have (nothing) rather
           than failing outright. */
        return { header: msg.header, answers: cnameChain, authorities: [], additionals: [] };

      const glue = {};
      for(const rr of msg.additionals)
        if(rr.type === TYPE.A)
          glue[rr.name.toLowerCase()] = rr.rdata.address;

      const nextServers = [];

      for(const ns of nsRecords) {
        const target = ns.rdata.target.toLowerCase();

        if(glue[target]) {
          nextServers.push(glue[target]);
          continue;
        }

        const ip = await resolveGlue(ns.rdata.target, glueDepth);
        if(ip)
          nextServers.push(ip);
      }

      if(!nextServers.length)
        throw new Error(`referral for ${currentName} had no usable nameserver address`);

      servers = nextServers;
    }

    throw new Error(`too many referral hops resolving ${name}`);
  }

  return { protocols, resolve, attach };
}
