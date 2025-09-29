import { Blob } from 'blob';
import { ReadableStream } from './streams.js';
import { define, isPrototypeOf, isView, assign, isAsyncIterable, isIterable } from './util.js';
import { readWholeStream, streamFromIterable, readableStreamCallback } from './stream-utils.js';

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
}

Body.prototype[Symbol.toStringTag] = 'Body';
Body.prototype.bodyUsed = false;

assign(Body.prototype, { body: null, _bodyInit: null });
