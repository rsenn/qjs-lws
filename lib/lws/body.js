import { readableStreamCallback, readableStreamSink, readWholeStream, streamFromIterable, concatArrayBuffer } from './stream-utils.js';
import { ReadableStream } from './streams.js';
import { assign, define, typeIsObject, isPrototypeOf, isAsyncIterable, isIterable, isView } from './util.js';
import { toString, toArrayBuffer } from 'lws.so';

function contentType(headers) {
  if(!headers) return '';
  if(typeof headers.get === 'function') return headers.get('content-type') || '';
  return headers['content-type'] || '';
}

export class Body {
  constructor(body) {
    let stream;

    if(isPrototypeOf(ReadableStream.prototype, body)) {
      stream = body;
    } else if(!isView(body) && (isIterable(body) || isAsyncIterable(body))) {
      /* Typed arrays (Uint8Array, ...) implement Symbol.iterator too, but
         yield individual byte values - a binary body passed as a view must
         be excluded here so it falls through to the isView() branch below
         and is treated as one opaque chunk, not an iterable of byte numbers. */
      stream = body;
    } else if(body !== undefined && body !== null) {
      let buf;

      if(typeIsObject(body) && typeof body.arrayBuffer == 'function') {
        buf = body.arrayBuffer();
      } else if(isView(body)) {
        buf = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
      } else if(isPrototypeOf(ArrayBuffer.prototype, body) || typeof body == 'string') {
        buf = body;
      } else {
        throw new TypeError(`Body.constructor: bad body: ${typeof body}`);
      }

      // Only a raw, re-buildable value (not a stream/iterable, which is
      // one-shot) is safe to keep around - Request/Response's clone()
      // reads this back to build an independent copy rather than sharing
      // (and racing on) the live stream below.
      this._bodyInit = body;

      stream = new ReadableStream({
        start(controller) {
          controller.enqueue(buf);
          controller.close();
        },
      });
    }

    if(stream)
      define(
        this,
        {
          body: readableStreamCallback(streamFromIterable(stream), () => (this.bodyUsed = true)),
        },
        { writable: true, configurable: true },
      );
  }

  /**
   * Synthesizes a `createServer()`-compatible protocol descriptor: the
   * first time body data arrives for a connection (`onHttpBody`), builds a
   * `ReadableStream` (via `readableStreamSink()`, lib/lws/stream-
   * utils.js - the same primitive `HttpProtocol.post()`,
   * lib/lws/protocols.js, builds its writable sink from) fed by that and
   * every subsequent chunk, and calls `callback(wsi, stream)` once. Purely
   * a body-streaming adapter - no `onHttp`/response handling of its own,
   * so pair it with your own `onHttp` (or `http()`) if you need to send a
   * response too, e.g. `{ name: 'http', ...http(fn), ...Body.protocol(cb) }`.
   *
   * @param  {Function} callback  `(wsi, stream: ReadableStream) => void`,
   *                              called once per connection, the first time
   *                              body data arrives
   * @return {object}             A protocol descriptor for `createServer()`'s
   *                              `protocols` array
   */
  static protocol(callback) {
    const sinks = new WeakMap();

    const finish = wsi => {
      sinks.get(wsi)?.close();
      sinks.delete(wsi);
    };

    return {
      onHttpBody: (wsi, buf) => {
        let sink = sinks.get(wsi);

        if(!sink) {
          const [stream, s] = readableStreamSink();

          sinks.set(wsi, (sink = s));
          callback(wsi, stream);
        }

        if(buf && buf.byteLength) sink.write(buf);
      },
      onHttpBodyCompletion: finish,
      onClosedHttp: finish,
    };
  }

  /**
   * Return the body as a Blob
   *
   * @return {Promise<Blob>}  Promise that resolves to a Blob object
   */
  async blob() {
    const { Blob } = await import('blob');
    this.bodyUsed = true;
    return new Blob(await readWholeStream(this.body));
  }

  /**
   * Return the body as an ArrayBuffer
   *
   * @return {Promise<ArrayBuffer>}  Promise that resolves to an ArrayBuffer object
   */
  async arrayBuffer() {
    const { body } = this;

    /* readWholeStream() consumes the stream via for-await-of, which goes
       through ReadableStream's own internal reader acquisition rather than
       the (wrapped, bodyUsed-tracking) public getReader() - so bodyUsed has
       to be set here explicitly rather than relying on that wrapper. */
    this.bodyUsed = true;

    return concatArrayBuffer((await readWholeStream(body)).map(chunk => (typeof chunk == 'string' ? toArrayBuffer(chunk) : chunk)));
  }

  /**
   * Return the body as text
   *
   * @return {Promise<string>}  Promise that resolves to a string
   */
  async text() {
    return toString(await this.arrayBuffer());
  }

  /**
   * Return the body as a JSON object
   *
   * @return {Promise<object>}  Promise that resolves to an object
   */
  async json() {
    return JSON.parse(await this.text());
  }

  /**
   * Return the body as parsed application/x-www-form-urlencoded data.
   *
   * `ServerRequest` (lib/lws/request.js) overrides this to handle
   * multipart/form-data too, via `MultipartMixin` (lib/lws/multipart.js) -
   * plain `Body`/`Response` have no streamed-upload machinery to parse
   * that with, so it's rejected here rather than silently mishandled.
   *
   * @return {Promise<object>}  Promise that resolves to a plain object
   *                            of decoded name → value pairs
   */
  async formData() {
    const ct = contentType(this.headers);

    if(/^multipart\/form-data/i.test(ct)) throw new TypeError('Body.formData: multipart/form-data requires ServerRequest (see MultipartMixin, lib/lws/multipart.js)');

    const text = await this.text();
    const out = Object.setPrototypeOf({}, null);

    if(!text) return out;

    for(const part of text.split('&')) {
      if(!part) continue;
      const eq = part.indexOf('=');
      const name = decodeURIComponent((eq < 0 ? part : part.slice(0, eq)).replace(/\+/g, ' '));
      const value = eq < 0 ? '' : decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' '));
      if(name in out) out[name] = [].concat(out[name], value);
      else out[name] = value;
    }

    return out;
  }
}

Body.prototype[Symbol.toStringTag] = 'Body';
Body.prototype.bodyUsed = false;

assign(Body.prototype, { body: null, _bodyInit: null });
