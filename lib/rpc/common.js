export function IdSequencer(start = 0, typedArr = Uint32Array) {
  const a = new typedArr([start]);
  return () => a[0]++;
}

/**
 * Wire codecs for lib/rpc/http-client.js, ws-client.js and ws-server.js -
 * each factory returns { name, encode(value), decode(raw) } (`bjson`'s
 * `decode` additionally expects/produces an ArrayBuffer rather than a
 * string, flagged by `binary: true`, so HTTP transport knows to read the
 * response body as bytes instead of text). Passed as `options.codec`;
 * default is `codecs.json()`.
 */
export const codecs = {
  none() {
    return { name: 'none', encode: v => v, decode: v => v };
  },
  json(verbose = false) {
    return {
      name: 'json',
      encode: v => JSON.stringify(v, ...(verbose ? [null, 2] : [])),
      decode: v => JSON.parse(v),
    };
  },
  async bjson() {
    const { write, read } = await import('bjson');
    return { name: 'bjson', binary: true, encode: v => write(v), decode: v => read(v) };
  },
  async js(verbose = false) {
    const { inspect } = await import('inspect');
    return {
      name: 'js',
      encode: v => inspect(v, { colors: false, compact: verbose ? false : -2, reparseable: true }),
      decode: v => eval(`(${v})`),
    };
  },
};

/* No dependency on 'lws.so' at the top level here (unlike the rest of
   lib/rpc/) - this file is imported by socket-client.js, which a browser
   loads directly (see its createWebSocketClient()), so it has to load
   standalone. `toArrayBuffer`/`toString` are lws.so's own string<->bytes
   primitives (the same ones lib/lws/body.js's Body#text() uses) - in the
   browser, build them from the TextEncoder/TextDecoder globals instead;
   in qjsm, load the real ones with a dynamic import so this file never
   statically pulls in 'lws.so'. */
const isBrowser = typeof globalThis.TextEncoder !== 'undefined' && typeof globalThis.TextDecoder !== 'undefined';

let toArrayBuffer, toString;

if(isBrowser) {
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();

  toArrayBuffer = str => textEncoder.encode(str).buffer;
  toString = bytes => textDecoder.decode(bytes instanceof ArrayBuffer ? bytes : bytes.buffer);
} else {
  ({ toArrayBuffer, toString } = await import('lws.so'));
}

function toBytes(data) {
  return data instanceof ArrayBuffer ? new Uint8Array(data) : typeof data === 'string' ? new Uint8Array(toArrayBuffer(data)) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Encodes one message into the `<hex-length>\n<payload bytes>` shape
 * createMessageUnframer() decodes back out - the write-side counterpart it
 * was missing, for a raw/TCP socket's wsi.write().
 *
 * @param  {string|ArrayBuffer|ArrayBufferView} data  a string, ArrayBuffer, TypedArray, or DataView
 * @return {ArrayBuffer}
 */
export function frameMessage(data) {
  const payload = toBytes(data);
  const header = toBytes(payload.length.toString(16) + '\n');

  return concatBytes(header, payload).buffer;
}

/**
 * WebSocket frames its own messages, so createWsOnMessage()'s handler
 * (ws-server.js) fires once per message already. A raw/TCP socket has no
 * such framing - one write() on one end can arrive as several message()
 * calls on the other, or several writes coalesced into one - so a message
 * boundary has to be spliced in ourselves before that same handler can be
 * reused verbatim over TCP.
 *
 * Wraps `onMessage` (the function createWsOnMessage() returns, or anything
 * with the same `(wsi, message)` shape) in a decoder for
 * `<hex-length>\n<payload bytes>` frames, one after another - the same
 * idea as HTTP chunked-transfer-encoding's `<hex-length>\r\n<data>\r\n`
 * (see writeChunk() in lib/lws/response.js), minus the trailing CRLF since
 * the length prefix already says exactly where the payload ends. The
 * returned wrapper accumulates incoming chunks per-wsi (a WeakMap, so a
 * closed/dropped wsi's leftover buffer is collected on its own) and calls
 * `onMessage(wsi, message)` once per complete frame - possibly more than
 * once per call, if more than one full frame arrived at once.
 *
 * The sending side must write frames in this same shape (not provided
 * here - this only decodes incoming data).
 *
 * @param  {(wsi, message: string) => void} onMessage
 * @return {(wsi, data, size?) => void}
 */
export function createMessageUnframer(onMessage) {
  const buffered = new WeakMap();

  return (wsi, data) => {
    let buf = concatBytes(buffered.get(wsi) ?? new Uint8Array(0), toBytes(data));

    for(;;) {
      const nl = buf.indexOf(10); // '\n'
      if(nl < 0) break;

      const length = parseInt(toString(buf.slice(0, nl)), 16);
      if(!Number.isFinite(length)) throw new Error('createMessageUnframer: bad frame length');

      const payloadStart = nl + 1;
      if(buf.length < payloadStart + length) break;

      onMessage(wsi, toString(buf.slice(payloadStart, payloadStart + length)));

      buf = buf.slice(payloadStart + length);
    }

    buffered.set(wsi, buf);
  };
}
