/** Small binary helpers shared by dns-message.js/resolver.js/server.js. */

/** Concatenates a list of Uint8Arrays into one. */
export function concatBytes(arrays) {
  let total = 0;
  for(const a of arrays) total += a.length;

  const out = new Uint8Array(total);
  let off = 0;

  for(const a of arrays) {
    out.set(a, off);
    off += a.length;
  }

  return out;
}

/** wsi.write()/wsi.sendTo() only accept a plain ArrayBuffer (or string) - never a typed-array view. */
export function toArrayBuffer(u8) {
  return u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8.buffer : u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

/** DNS names are ASCII (IDNs travel over the wire already punycode-encoded) - plain charCodeAt avoids pulling in TextEncoder. */
export function labelBytes(str) {
  const buf = new Uint8Array(str.length);

  for(let i = 0; i < str.length; i++)
    buf[i] = str.charCodeAt(i) & 0xff;

  return buf;
}

export function bytesToLabel(buf) {
  let s = '';

  for(let i = 0; i < buf.length; i++)
    s += String.fromCharCode(buf[i]);

  return s;
}
