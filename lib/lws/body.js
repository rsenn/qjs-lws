import { readableStreamCallback, readWholeStream, streamFromIterable } from './stream-utils.js';
import { ReadableStream } from './streams.js';
import { assign, define, typeIsObject, isPrototypeOf, isAsyncIterable, isIterable, isView } from './util.js';

export class Body {
  constructor(body) {
    let stream;

    if(isPrototypeOf(ReadableStream.prototype, body)) {
      stream = body;
    } else if(isIterable(body) || isAsyncIterable(body)) {
      stream = body;
    } else if(body !== undefined) {
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
        {},
      );
  }

  /**
   * Return the body as a Blob
   *
   * @return {Promise<Blob>}  Promise that resolves to a Blob object
   */
  async blob() {
    const { Blob } = await import('blob');
    return new Blob(await readWholeStream(this.body));
  }

  /**
   * Return the body as an ArrayBuffer
   *
   * @return {Promise<ArrayBuffer>}  Promise that resolves to an ArrayBuffer object
   */
  async arrayBuffer() {
    if(isPrototypeOf(ArrayBuffer.prototype, this.body)) return this.body;

    if(typeof this.body == 'string') {
      const { TextEncoder } = globalThis.TextEncoder ? globalThis : await import('textcode');
      return new TextEncoder().encode(this.body);
    }

    if(typeIsObject(this.body) && typeof this.body.arrayBuffer == 'function') return await this.body.arrayBuffer();

    throw new TypeError(`Body.arrayBuffer: bad body: ${body}`);
  }

  /**
   * Return the body as text
   *
   * @return {Promise<string>}  Promise that resolves to a string
   */
  async text() {
    if(typeof this.body == 'string') return this.body;

    if(isPrototypeOf(ArrayBuffer.prototype, this.body)) {
      const { TextEncoder } = globalThis.TextEncoder ? globalThis : await import('textcode');
      return new TextEncoder().decode(this.body);
    }

    if(typeIsObject(this.body) && typeof this.body.text == 'function') return await this.body.text();

    throw new TypeError(`Body.text: bad body: ${body}`);
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
   * Return the body as parsed form data.
   *
   * Handles application/x-www-form-urlencoded directly. For
   * multipart/form-data on the server side use LWSSPA — its callbacks
   * parse the body incrementally rather than buffering the whole upload.
   *
   * @return {Promise<object>}  Promise that resolves to a plain object
   *                            of decoded name → value pairs
   */
  formData() {
    return this.text().then(text => {
      const ct = (this.headers && this.headers.get && this.headers.get('content-type')) || '';

      if(/^multipart\/form-data/i.test(ct)) throw new TypeError('Body.formData: parse multipart bodies with LWSSPA, not Body.formData()');

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
    });
  }
}

Body.prototype[Symbol.toStringTag] = 'Body';
Body.prototype.bodyUsed = false;

assign(Body.prototype, { body: null, _bodyInit: null });
