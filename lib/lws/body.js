import { readableStreamCallback, readWholeStream, streamFromIterable } from './stream-utils.js';
import { ReadableStream } from './streams.js';
import { assign, define, isAsyncIterable, isIterable, isPrototypeOf, isView, Blob } from 'blob';

export class Body {
  constructor(body) {
    let stream;

    if(isPrototypeOf(ReadableStream.prototype, body)) {
      stream = body;
    } else if(isIterable(body) || isAsyncIterable(body)) {
      stream = body;
    } else if(body !== undefined) {
      let buf;

      if(isPrototypeOf(Blob.prototype, body)) {
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
  blob() {
    return readWholeStream(this.body).then(a => new Blob(a));
  }

  /**
   * Return the body as an ArrayBuffer
   *
   * @return {Promise<ArrayBuffer>}  Promise that resolves to an ArrayBuffer object
   */

  arrayBuffer() {
    return this.blob().then(b => b.arrayBuffer());
  }

  /**
   * Return the body as text
   *
   * @return {Promise<string>}  Promise that resolves to a string
   */
  text() {
    return this.blob().then(b => b.text());
  }

  /**
   * Return the body as a JSON object
   *
   * @return {Promise<object>}  Promise that resolves to an object
   */
  json() {
    return this.text().then(s => JSON.parse(s));
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

      if(/^multipart\/form-data/i.test(ct))
        throw new TypeError('Body.formData: parse multipart bodies with LWSSPA, not Body.formData()');

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
