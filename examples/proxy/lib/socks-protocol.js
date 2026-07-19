/**
 * Pure SOCKS4/4a/5 message encode/decode - no I/O, no state. Shared by
 * socks-listener.js (decoding what an incoming client sends, encoding our
 * replies) and onward.js's hand-rolled SOCKS4 client (encoding what we send
 * upstream, decoding its reply).
 *
 * Every decode* function returns `null` if `bytes` doesn't hold a complete
 * message yet (caller should wait for more data), or `{ ..., consumed }`
 * where `consumed` is how many leading bytes the message actually used -
 * SOCKS handshakes are small and typically arrive as a single TCP segment,
 * but a decoder that tracked its own boundary correctly is what makes it
 * safe to feed it a whole buffer that might contain trailing bytes.
 *
 * See RFC 1928 (SOCKS5), RFC 1929 (SOCKS5 username/password - not
 * implemented here), and the (never-formally-RFC'd) SOCKS4/4a spec.
 */

const SOCKS5_ATYP_IPV4 = 1;
const SOCKS5_ATYP_DOMAIN = 3;
const SOCKS5_ATYP_IPV6 = 4;

export const SOCKS5_CMD_CONNECT = 1;
export const SOCKS5_REP_SUCCEEDED = 0x00;
export const SOCKS5_REP_COMMAND_NOT_SUPPORTED = 0x07;
export const SOCKS5_REP_GENERAL_FAILURE = 0x01;

export const SOCKS4_CMD_CONNECT = 1;
export const SOCKS4_GRANTED = 0x5a;
export const SOCKS4_REJECTED = 0x5b;

function u8(bytes) {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

function ipv4ToBytes(host) {
  const parts = host.split('.').map(Number);
  if(parts.length !== 4 || parts.some(n => !(n >= 0 && n <= 255))) return null;
  return Uint8Array.from(parts);
}

function isIpv4(host) {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) && ipv4ToBytes(host) != null;
}

/* ------------------------------------------------------------------ *
 * SOCKS4 / SOCKS4a
 * ------------------------------------------------------------------ */

/**
 * Decodes a SOCKS4/4a CONNECT request (client -> server).
 * @return {{cmd, port, host, consumed}|null}
 */
export function decodeSocks4Request(bytes) {
  bytes = u8(bytes);
  if(bytes.length < 9) return null;
  if(bytes[0] !== 4) throw new TypeError(`decodeSocks4Request: expected version 4, got ${bytes[0]}`);

  const cmd = bytes[1];
  const port = (bytes[2] << 8) | bytes[3];
  const ip = bytes.subarray(4, 8);
  const isSocks4a = ip[0] === 0 && ip[1] === 0 && ip[2] === 0 && ip[3] !== 0;

  const nulAfter = start => {
    const i = bytes.indexOf(0, start);
    return i === -1 ? -1 : i;
  };

  const userEnd = nulAfter(8);
  if(userEnd === -1) return null;

  if(!isSocks4a) return { cmd, port, host: `${ip[0]}.${ip[1]}.${ip[2]}.${ip[3]}`, consumed: userEnd + 1 };

  const domainStart = userEnd + 1;
  const domainEnd = nulAfter(domainStart);
  if(domainEnd === -1) return null;

  const host = toStringAscii(bytes.subarray(domainStart, domainEnd));
  return { cmd, port, host, consumed: domainEnd + 1 };
}

/** Encodes a SOCKS4/4a CONNECT request (for onward.js's client role). */
export function encodeSocks4Request({ cmd = SOCKS4_CMD_CONNECT, host, port }) {
  const v4 = isIpv4(host) ? ipv4ToBytes(host) : null;
  const domain = v4 ? null : toBytesAscii(host);
  const header = new Uint8Array(9 + (domain ? domain.length + 1 : 0));

  header[0] = 4;
  header[1] = cmd;
  header[2] = (port >> 8) & 0xff;
  header[3] = port & 0xff;

  if(v4) header.set(v4, 4);
  else header.set([0, 0, 0, 1], 4); // SOCKS4a marker: 0.0.0.x, x != 0

  header[8] = 0; // empty USERID, NUL-terminated

  if(domain) {
    header.set(domain, 9);
    header[9 + domain.length] = 0;
  }

  return header;
}

/** Encodes a SOCKS4 reply (server -> client). */
export function encodeSocks4Reply({ granted, port = 0, host = '0.0.0.0' } = {}) {
  const ip = ipv4ToBytes(host) ?? new Uint8Array(4);
  const reply = new Uint8Array(8);

  reply[0] = 0;
  reply[1] = granted ? SOCKS4_GRANTED : SOCKS4_REJECTED;
  reply[2] = (port >> 8) & 0xff;
  reply[3] = port & 0xff;
  reply.set(ip, 4);

  return reply;
}

/** Decodes a SOCKS4 reply (for onward.js's client role). */
export function decodeSocks4Reply(bytes) {
  bytes = u8(bytes);
  if(bytes.length < 8) return null;

  const ip = bytes.subarray(4, 8);
  return {
    granted: bytes[1] === SOCKS4_GRANTED,
    port: (bytes[2] << 8) | bytes[3],
    host: `${ip[0]}.${ip[1]}.${ip[2]}.${ip[3]}`,
    consumed: 8,
  };
}

/* ------------------------------------------------------------------ *
 * SOCKS5
 * ------------------------------------------------------------------ */

/** Decodes the initial client greeting (version + offered auth methods). */
export function decodeSocks5Greeting(bytes) {
  bytes = u8(bytes);
  if(bytes.length < 2) return null;
  if(bytes[0] !== 5) throw new TypeError(`decodeSocks5Greeting: expected version 5, got ${bytes[0]}`);

  const nmethods = bytes[1];
  if(bytes.length < 2 + nmethods) return null;

  return { methods: Array.from(bytes.subarray(2, 2 + nmethods)), consumed: 2 + nmethods };
}

/** Encodes the client greeting (for onward.js's client role). */
export function encodeSocks5Greeting(methods = [0]) {
  return Uint8Array.from([5, methods.length, ...methods]);
}

/** Encodes the server's chosen auth method (0x00 = no auth, 0xff = none acceptable). */
export function encodeSocks5MethodSelection(method) {
  return Uint8Array.from([5, method]);
}

/** Decodes the server's chosen auth method (for onward.js's client role). */
export function decodeSocks5MethodSelection(bytes) {
  bytes = u8(bytes);
  if(bytes.length < 2) return null;
  return { method: bytes[1], consumed: 2 };
}

function decodeSocks5Address(bytes, offset) {
  const atyp = bytes[offset];

  if(atyp === SOCKS5_ATYP_IPV4) {
    if(bytes.length < offset + 1 + 4 + 2) return null;
    const ip = bytes.subarray(offset + 1, offset + 5);
    return { atyp, host: `${ip[0]}.${ip[1]}.${ip[2]}.${ip[3]}`, next: offset + 5 };
  }

  if(atyp === SOCKS5_ATYP_DOMAIN) {
    if(bytes.length < offset + 2) return null;
    const len = bytes[offset + 1];
    if(bytes.length < offset + 2 + len + 2) return null;
    const host = toStringAscii(bytes.subarray(offset + 2, offset + 2 + len));
    return { atyp, host, next: offset + 2 + len };
  }

  if(atyp === SOCKS5_ATYP_IPV6) {
    if(bytes.length < offset + 1 + 16 + 2) return null;
    const parts = [];
    for(let i = 0; i < 8; i++) parts.push(((bytes[offset + 1 + i * 2] << 8) | bytes[offset + 2 + i * 2]).toString(16));
    return { atyp, host: parts.join(':'), next: offset + 17 };
  }

  throw new TypeError(`decodeSocks5Address: unsupported ATYP ${atyp}`);
}

/** Decodes a SOCKS5 request (CONNECT/BIND/UDP ASSOCIATE), client -> server. */
export function decodeSocks5Request(bytes) {
  bytes = u8(bytes);
  if(bytes.length < 4) return null;
  if(bytes[0] !== 5) throw new TypeError(`decodeSocks5Request: expected version 5, got ${bytes[0]}`);

  const cmd = bytes[1];
  const addr = decodeSocks5Address(bytes, 3);
  if(!addr) return null;

  const port = (bytes[addr.next] << 8) | bytes[addr.next + 1];
  return { cmd, host: addr.host, port, consumed: addr.next + 2 };
}

/** Encodes a SOCKS5 CONNECT request (for onward.js's client role) - always as a domain name, simplest and universally supported. */
export function encodeSocks5Request({ cmd = SOCKS5_CMD_CONNECT, host, port }) {
  const domain = toBytesAscii(host);
  const out = new Uint8Array(4 + 1 + domain.length + 2);

  out[0] = 5;
  out[1] = cmd;
  out[2] = 0; // RSV
  out[3] = SOCKS5_ATYP_DOMAIN;
  out[4] = domain.length;
  out.set(domain, 5);
  out[5 + domain.length] = (port >> 8) & 0xff;
  out[6 + domain.length] = port & 0xff;

  return out;
}

/** Encodes a SOCKS5 reply, server -> client. Defaults BND.ADDR/PORT to 0.0.0.0:0 (unused by clients for CONNECT). */
export function encodeSocks5Reply({ rep = SOCKS5_REP_SUCCEEDED, host = '0.0.0.0', port = 0 } = {}) {
  const ip = ipv4ToBytes(host) ?? new Uint8Array(4);
  const out = new Uint8Array(4 + 4 + 2);

  out[0] = 5;
  out[1] = rep;
  out[2] = 0; // RSV
  out[3] = SOCKS5_ATYP_IPV4;
  out.set(ip, 4);
  out[8] = (port >> 8) & 0xff;
  out[9] = port & 0xff;

  return out;
}

/** Decodes a SOCKS5 reply (for onward.js's client role). */
export function decodeSocks5Reply(bytes) {
  bytes = u8(bytes);
  if(bytes.length < 4) return null;

  const addr = decodeSocks5Address(bytes, 3);
  if(!addr) return null;

  const port = (bytes[addr.next] << 8) | bytes[addr.next + 1];
  return { rep: bytes[1], host: addr.host, port, consumed: addr.next + 2 };
}

/* ------------------------------------------------------------------ *
 * tiny ASCII helpers (hostnames only - SOCKS has no charset concept)
 * ------------------------------------------------------------------ */

function toBytesAscii(str) {
  const out = new Uint8Array(str.length);
  for(let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

function toStringAscii(bytes) {
  let s = '';
  for(let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}
