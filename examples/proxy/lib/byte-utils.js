/** Tiny byte-buffer helpers shared by the listeners and onward.js. */
import { toString } from 'lws.so';

export function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** lws.so's toString() only accepts a genuine ArrayBuffer (via JS_GetArrayBuffer) - a Uint8Array *view* is silently rejected (returns undefined, no throw). Always go through this instead of calling toString() on a Uint8Array directly. */
export function bytesToString(u8) {
  return toString(u8.buffer, u8.byteOffset, u8.byteLength);
}

/**
 * The native wsi.write() (StreamAdapter's WritableStream sink, lib/lws/
 * protocols.js) has the same ArrayBuffer-only limitation as toString()
 * above, but doesn't throw for a Uint8Array *view* - it hangs forever
 * instead (JS_GetArrayBuffer fails, and whatever consumes that failure
 * never settles the write() promise either way). Strings pass through
 * unchanged; a Uint8Array not already spanning its whole backing buffer
 * gets copied into a fresh, exactly-sized ArrayBuffer.
 */
export function toArrayBuffer(data) {
  if(!(data instanceof Uint8Array)) return data;
  return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data.buffer : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

/** getWriter()/write()/releaseLock(), with the toArrayBuffer() conversion above applied automatically. */
export async function writeBytes(writable, data) {
  const writer = writable.getWriter();
  await writer.write(toArrayBuffer(data));
  writer.releaseLock();
}

/**
 * Reads from `reader`, accumulating bytes, until `tryDecode(buf)` returns a
 * non-null `{..., consumed}` (or throws - propagated to the caller), or the
 * stream ends. `tryDecode` is re-run against the whole buffer so far on
 * every new chunk - fine for the small handshake/header-sized buffers every
 * caller here uses it for.
 *
 * @return {Promise<{decoded, buf, rest}|null>} `null` if the stream ended
 *         first; otherwise `decoded` is `tryDecode`'s result, `buf` is
 *         everything read so far, `rest` is `buf` past `decoded.consumed`.
 */
export async function accumulateUntil(reader, tryDecode, initial = new Uint8Array(0)) {
  let buf = initial;

  for(;;) {
    const decoded = tryDecode(buf);
    if(decoded) return { decoded, buf, rest: buf.subarray(decoded.consumed) };

    const { value, done } = await reader.read();
    if(done) return null;

    buf = concat(buf, value instanceof Uint8Array ? value : new Uint8Array(value));
  }
}
