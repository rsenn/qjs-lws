/**
 * Minimal DNS (RFC 1035 + RFC 3596 AAAA) wire-format codec: just enough to
 * run a recursive resolver - decode/encode messages, questions and the
 * handful of RR types that show up while walking a referral chain (A/AAAA/
 * NS/CNAME/SOA/MX/TXT). Anything else is round-tripped as opaque rdata
 * bytes rather than decoded, since we never need to inspect it.
 *
 * Outgoing messages are always written without name compression - wastes a
 * few bytes, but sidesteps having to track/reuse offsets while encoding.
 * Incoming messages (from upstream nameservers) *do* use compression
 * pointers, which decodeName() below follows.
 */
import { concatBytes, labelBytes, bytesToLabel } from './bytes.js';

export const TYPE = { A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28, SRV: 33, OPT: 41, ANY: 255 };
export const CLASS = { IN: 1 };
export const RCODE = { NOERROR: 0, FORMERR: 1, SERVFAIL: 2, NXDOMAIN: 3, NOTIMP: 4, REFUSED: 5 };

const TYPE_NAMES = Object.fromEntries(Object.entries(TYPE).map(([name, id]) => [id, name]));

export function typeName(t) {
  return TYPE_NAMES[t] || `TYPE${t}`;
}

export function typeFromName(name) {
  const t = TYPE[String(name).toUpperCase()];
  return t === undefined ? TYPE.A : t;
}

function encodeName(name) {
  const parts = [];

  if(name !== '.' && name !== '') {
    for(const label of name.replace(/\.$/, '').split('.')) {
      const lb = labelBytes(label);

      if(lb.length > 63)
        throw new Error(`label too long: ${label}`);

      parts.push(Uint8Array.of(lb.length), lb);
    }
  }

  parts.push(Uint8Array.of(0));
  return concatBytes(parts);
}

/* Follows compression pointers (RFC 1035 4.1.4). Returns { name, next }
   where `next` is the offset right after the name *as it appears at
   `offset`* - i.e. past the first pointer taken, not past whatever the
   pointer chain eventually bottoms out at. */
function decodeName(buf, offset) {
  const labels = [];
  let pos = offset;
  let next = -1;
  let jumps = 0;

  for(;;) {
    if(pos >= buf.length)
      throw new Error('name runs past end of message');

    const len = buf[pos];

    if((len & 0xc0) === 0xc0) {
      if(pos + 1 >= buf.length)
        throw new Error('truncated compression pointer');

      if(next === -1)
        next = pos + 2;

      if(++jumps > 128)
        throw new Error('too many compression pointers');

      pos = ((len & 0x3f) << 8) | buf[pos + 1];
      continue;
    }

    if(len === 0) {
      if(next === -1)
        next = pos + 1;
      break;
    }

    if(pos + 1 + len > buf.length)
      throw new Error('label runs past end of message');

    labels.push(bytesToLabel(buf.subarray(pos + 1, pos + 1 + len)));
    pos += 1 + len;
  }

  return { name: labels.length ? `${labels.join('.')}.` : '.', next };
}

function ipv4ToBytes(str) {
  const parts = str.split('.').map(Number);

  if(parts.length !== 4 || parts.some(n => !(n >= 0 && n <= 255)))
    throw new Error(`bad IPv4 address: ${str}`);

  return Uint8Array.from(parts);
}

function ipv4ToString(buf) {
  return Array.from(buf).join('.');
}

function ipv6ToBytes(str) {
  const [head, tail] = str.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const fillCount = 8 - headParts.length - tailParts.length;
  const groups = str.includes('::') ? [...headParts, ...Array(Math.max(fillCount, 0)).fill('0'), ...tailParts] : headParts;

  if(groups.length !== 8)
    throw new Error(`bad IPv6 address: ${str}`);

  const bytes = new Uint8Array(16);

  for(let i = 0; i < 8; i++) {
    const v = parseInt(groups[i] || '0', 16);
    bytes[i * 2] = v >> 8;
    bytes[i * 2 + 1] = v & 0xff;
  }

  return bytes;
}

function ipv6ToString(buf) {
  const groups = [];

  for(let i = 0; i < 16; i += 2)
    groups.push(((buf[i] << 8) | buf[i + 1]).toString(16));

  return groups.join(':');
}

function decodeRdata(type, buf, start, end) {
  switch(type) {
    case TYPE.A:
      return { address: ipv4ToString(buf.subarray(start, end)) };

    case TYPE.AAAA:
      return { address: ipv6ToString(buf.subarray(start, end)) };

    case TYPE.NS:
    case TYPE.CNAME:
    case TYPE.PTR:
      return { target: decodeName(buf, start).name };

    case TYPE.SOA: {
      const mname = decodeName(buf, start);
      const rname = decodeName(buf, mname.next);
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const p = rname.next;

      return {
        mname: mname.name,
        rname: rname.name,
        serial: dv.getUint32(p),
        refresh: dv.getUint32(p + 4),
        retry: dv.getUint32(p + 8),
        expire: dv.getUint32(p + 12),
        minimum: dv.getUint32(p + 16),
      };
    }

    case TYPE.MX: {
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      return { preference: dv.getUint16(start), exchange: decodeName(buf, start + 2).name };
    }

    case TYPE.TXT: {
      const text = [];
      let p = start;

      while(p < end) {
        const len = buf[p];
        text.push(bytesToLabel(buf.subarray(p + 1, p + 1 + len)));
        p += 1 + len;
      }

      return { text };
    }

    default:
      return { raw: buf.slice(start, end) };
  }
}

function encodeRdata(rr) {
  switch(rr.type) {
    case TYPE.A:
      return ipv4ToBytes(rr.rdata.address);

    case TYPE.AAAA:
      return ipv6ToBytes(rr.rdata.address);

    case TYPE.NS:
    case TYPE.CNAME:
    case TYPE.PTR:
      return encodeName(rr.rdata.target);

    case TYPE.SOA: {
      const tail = new Uint8Array(20);
      const dv = new DataView(tail.buffer);
      dv.setUint32(0, rr.rdata.serial >>> 0);
      dv.setUint32(4, rr.rdata.refresh >>> 0);
      dv.setUint32(8, rr.rdata.retry >>> 0);
      dv.setUint32(12, rr.rdata.expire >>> 0);
      dv.setUint32(16, rr.rdata.minimum >>> 0);
      return concatBytes([encodeName(rr.rdata.mname), encodeName(rr.rdata.rname), tail]);
    }

    case TYPE.MX: {
      const pref = new Uint8Array(2);
      new DataView(pref.buffer).setUint16(0, rr.rdata.preference);
      return concatBytes([pref, encodeName(rr.rdata.exchange)]);
    }

    case TYPE.TXT:
      return concatBytes(rr.rdata.text.map(s => concatBytes([Uint8Array.of(s.length), labelBytes(s)])));

    default:
      return rr.rdata.raw ?? new Uint8Array(0);
  }
}

function decodeQuestion(buf, offset) {
  const { name, next } = decodeName(buf, offset);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  return { question: { name, type: dv.getUint16(next), class: dv.getUint16(next + 2) }, next: next + 4 };
}

function encodeQuestion(q) {
  const tail = new Uint8Array(4);
  const dv = new DataView(tail.buffer);
  dv.setUint16(0, q.type);
  dv.setUint16(2, q.class ?? CLASS.IN);

  return concatBytes([encodeName(q.name), tail]);
}

function decodeRR(buf, offset) {
  const { name, next } = decodeName(buf, offset);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const type = dv.getUint16(next);
  const cls = dv.getUint16(next + 2);
  const ttl = dv.getUint32(next + 4);
  const rdlength = dv.getUint16(next + 8);
  const rdataStart = next + 10;
  const rdataEnd = rdataStart + rdlength;

  return { rr: { name, type, class: cls, ttl, rdata: decodeRdata(type, buf, rdataStart, rdataEnd) }, next: rdataEnd };
}

function encodeRR(rr) {
  const rdataBytes = encodeRdata(rr);
  const head = new Uint8Array(10);
  const dv = new DataView(head.buffer);
  dv.setUint16(0, rr.type);
  dv.setUint16(2, rr.class ?? CLASS.IN);
  dv.setUint32(4, rr.ttl >>> 0);
  dv.setUint16(8, rdataBytes.length);

  return concatBytes([encodeName(rr.name), head, rdataBytes]);
}

export function decodeMessage(buf) {
  if(!(buf instanceof Uint8Array))
    buf = new Uint8Array(buf);

  if(buf.length < 12)
    throw new Error('message shorter than DNS header');

  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const flags = dv.getUint16(2);

  const header = {
    id: dv.getUint16(0),
    qr: (flags >> 15) & 1,
    opcode: (flags >> 11) & 0xf,
    aa: (flags >> 10) & 1,
    tc: (flags >> 9) & 1,
    rd: (flags >> 8) & 1,
    ra: (flags >> 7) & 1,
    rcode: flags & 0xf,
    qdcount: dv.getUint16(4),
    ancount: dv.getUint16(6),
    nscount: dv.getUint16(8),
    arcount: dv.getUint16(10),
  };

  let offset = 12;
  const questions = [];

  for(let i = 0; i < header.qdcount; i++) {
    const { question, next } = decodeQuestion(buf, offset);
    questions.push(question);
    offset = next;
  }

  const decodeSection = count => {
    const rrs = [];

    for(let i = 0; i < count; i++) {
      const { rr, next } = decodeRR(buf, offset);
      rrs.push(rr);
      offset = next;
    }

    return rrs;
  };

  const answers = decodeSection(header.ancount);
  const authorities = decodeSection(header.nscount);
  const additionals = decodeSection(header.arcount);

  return { header, questions, answers, authorities, additionals };
}

export function encodeMessage(msg) {
  const { header, questions, answers = [], authorities = [], additionals = [] } = msg;

  const headerBytes = new Uint8Array(12);
  const dv = new DataView(headerBytes.buffer);
  dv.setUint16(0, header.id & 0xffff);

  let flags = 0;
  flags |= (header.qr & 1) << 15;
  flags |= (header.opcode & 0xf) << 11;
  flags |= (header.aa & 1) << 10;
  flags |= (header.tc & 1) << 9;
  flags |= (header.rd & 1) << 8;
  flags |= (header.ra & 1) << 7;
  flags |= header.rcode & 0xf;
  dv.setUint16(2, flags);

  dv.setUint16(4, questions.length);
  dv.setUint16(6, answers.length);
  dv.setUint16(8, authorities.length);
  dv.setUint16(10, additionals.length);

  return concatBytes([headerBytes, ...questions.map(encodeQuestion), ...answers.map(encodeRR), ...authorities.map(encodeRR), ...additionals.map(encodeRR)]);
}

export function buildQuery(name, type, id) {
  return encodeMessage({
    header: { id, qr: 0, opcode: 0, aa: 0, tc: 0, rd: 0, ra: 0, rcode: 0 },
    questions: [{ name, type, class: CLASS.IN }],
  });
}
