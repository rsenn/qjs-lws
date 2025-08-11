import { toArrayBuffer, toString } from 'lws';
import { ReadableStream } from './streams.js';
import { LinkedList } from './list.js';
import { isPrototypeOf, assign, readStream } from './util.js';
import { Blob } from 'blob';

/**
 * @class ReadError
 * @description Error during reading
 */
export class ReadError extends Error {}

/**
 * @class Body
 * @description Mixin class for @class Request and @class Response
 */
export class Body {
  #bodyStream;
  #bodyBlob;
  #bodyFormData;
  #bodyArrayBuffer;
  #bodyText;
  #chunks;
  #queue;

  /**
   * Return the body as a Blob
   *
   * @return {Promise<Blob>}  Promise that resolves to a Blob object
   */
  blob() {
    const isConsumed = consumed(this);

    if(isConsumed) return isConsumed;

    if(this.#bodyBlob) return Promise.resolve(this.#bodyBlob);
    if(this.#bodyArrayBuffer) return Promise.resolve(new Blob([this.#bodyArrayBuffer]));
    if(this.#bodyFormData) return Promise.reject(new Error('could not read FormData body as blob'));
    if(this.#bodyText) return Promise.resolve(new Blob([this.#bodyText]));
    if(this.#chunks || this.#queue || this.#bodyStream) return readStream(this.body).then(arr => Promise.resolve(new Blob(arr)));
  }

  /**
   * Return the body as an ArrayBuffer
   *
   * @return {Promise<ArrayBuffer>}  Promise that resolves to an ArrayBuffer object
   */
  arrayBuffer() {
    const isConsumed = consumed(this);

    if(isConsumed) return isConsumed;

    if(this.#bodyBlob) return this.#bodyBlob.arrayBuffer();
    if(this.#bodyArrayBuffer)
      return Promise.resolve(
        ArrayBuffer.isView(this.#bodyArrayBuffer)
          ? this.#bodyArrayBuffer.buffer.slice(this.#bodyArrayBuffer.byteOffset, this.#bodyArrayBuffer.byteOffset + this.#bodyArrayBuffer.byteLength)
          : this.#bodyArrayBuffer,
      );
    if(this.#bodyFormData) return Promise.reject(new Error('could not read FormData body as ArrayBuffer'));
    if(this.#bodyText) return Promise.resolve(toArrayBuffer(this.#bodyText));
    if(this.#chunks || this.#queue || this.#bodyStream) return readStream(this.body).then(arr => Promise.resolve(new Blob(arr).arrayBuffer()));
  }

  /**
   * Return the body as text
   *
   * @return {Promise<string>}  Promise that resolves to a string
   */
  text() {
    const isConsumed = consumed(this);

    if(isConsumed) return isConsumed;

    if(this.#bodyBlob) return this.#bodyBlob.text();
    if(this.#bodyArrayBuffer) return Promise.resolve(toString(this.#bodyArrayBuffer));
    if(this.#bodyFormData) return Promise.reject(new Error('could not read FormData body as text'));
    if(this.#bodyText) return Promise.resolve(this.#bodyText);
    if(this.#chunks || this.#queue || this.#bodyStream) return readStream(this.body).then(arr => Promise.resolve(new Blob(arr).text()));
  }

  /**
   * Return the body as a FormData object
   *
   * @return {Promise<FormData>}  Promise that resolves to a FormData object
   */
  formData() {
    return this.text().then(s => {
      const form = new FormData();

      s.trim()
        .split('&')
        .forEach(bytes => {
          if(bytes) {
            const split = bytes.split('=');
            const name = split.shift().replace(/\+/g, ' ');
            const value = split.join('=').replace(/\+/g, ' ');

            form.append(decodeURIComponent(name), decodeURIComponent(value));
          }
        });

      return form;
    });
  }

  /**
   * Return the body as a JSON object
   *
   * @return {Promise<object>}  Promise that resolves to an object
   */
  json() {
    return this.text().then(JSON.parse);
  }

  /**
   * Return the body as a ReadableStream
   *
   * @return {ReadableStream}
   */
  get body() {
    if(this._noBody) return null;

    return (this.#bodyStream ??= new ReadableStream(
      this.#chunks
        ? {
            start() {},
            pull: async controller => {
              if(!this.#chunks.empty) {
                const chunk = this.#chunks.popFront();

                if(chunk === null) controller.close();
                else if(isPrototypeOf(ReadError.prototype, chunk)) controller.error(chunk.message);
                else controller.enqueue(chunk);
              }
            },
          }
        : this.#queue
          ? {
              start() {},
              pull: async controller => {
                if(this.#queue.length > 0) {
                  const chunk = this.#queue.shift();

                  if(chunk === null) controller.close();
                  else if(isPrototypeOf(ReadError.prototype, chunk)) controller.error(chunk.message);
                  else controller.enqueue(chunk);
                }
              },
            }
          : {
              start: async controller => {
                controller.enqueue(await this.arrayBuffer());
                controller.close();
              },
            },
    ));
  }

  /**
   * Initialize the body on a class
   *
   * @param  {object} instance      Request or Response object
   * @param  {Blob|ArrayBuffer|TypedArray|DataView|FormData|ReadableStream|URLSearchParams} body
   */
  static init(instance, body) {
    assign(instance, { _bodyInit: body });

    if(!body && body !== '') ((instance.#bodyText = ''), assign(instance, { _noBody: true }));
    else if(typeof body == 'string') instance.#bodyText = body;
    else if(isPrototypeOf(Blob?.prototype, body)) instance.#bodyBlob = body;
    else if(isPrototypeOf(ReadableStream?.prototype, body)) instance.#bodyStream = body;
    else if(isPrototypeOf(globalThis.FormData?.prototype, body)) instance.#bodyFormData = body;
    else if(isPrototypeOf(globalThis.URLSearchParams?.prototype, body)) this.#bodyText = body.toString();
    else if(isDataView(body)) instance.#bodyArrayBuffer = bufferClone(body.buffer);
    else if(isPrototypeOf(ArrayBuffer.prototype, body) || ArrayBuffer.isView(body)) instance.#bodyArrayBuffer = bufferClone(body);
    else instance.#bodyText = body = Object.prototype.toString.call(body);

    if(!instance.headers.get('content-type')) {
      if('#bodyText' in instance) instance.headers.set('content-type', 'text/plain;charset=UTF-8');
      else if(instance.#bodyBlob && instance.#bodyBlob.type) instance.headers.set('content-type', instance.#bodyBlob.type);
      else if(isPrototypeOf(globalThis.URLSearchParams?.prototype, body)) instance.headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
    }
  }

  /**
   * Write body data.
   *
   * @param  {Request|Response}      instance  Request or Response object
   * @param  {ArrayBuffer} chunk     Chunk of data.
   */
  static write(instance, chunk) {
    instance._noBody = false;

    instance.#chunks ??= new LinkedList();

    if(!instance.#chunks.empty) {
      const last = instance.#chunks.back;

      if(last === null) throw new Error('stream already completed');
      if(isPrototypeOf(ReadError.prototype, last)) throw new Error('stream had read error');
    }

    instance.#chunks.pushBack(chunk);
  }

  /**
   * Close body stream
   *
   * @param  {Request|Response} instance  Request or Response object
   */
  static close(instance) {
    console.log('Body.close');
    this.write(instance, null);
  }

  /**
   * Signal error on a body stream
   *
   * @param  {Request|Response} instance  Request or Response object
   * @param  {string} error     Error message
   */
  static error(instance, error) {
    console.log('Body.error', error);
    this.write(instance, new ReadError(error));
  }
}

Body.prototype[Symbol.toStringTag] = 'Body';
Body.prototype.bodyUsed = false;

assign(Body.prototype, { _bodyInit: null });

/**
 * @param  {any}  obj   Object to check
 * @return {boolean}    true if object is a DataView
 */
function isDataView(obj) {
  return obj && isPrototypeOf(DataView.prototype, obj);
}

/**
 * @param  {Request|Response} body  Body object
 * @return {undefined|Promise}      If already read, return a rejected Promise
 */
function consumed(body) {
  if(body._noBody) return;

  if(body.bodyUsed) return Promise.reject(new TypeError('Already read'));

  body.bodyUsed = true;
}

/**
 * Clone a buffer
 *
 * @param  {ArrayBuffer|DataView|TypedArray} buf  Buffer object
 * @return {ArrayBuffer}                          Cloned ArrayBuffer
 */
function bufferClone(buf) {
  if(ArrayBuffer.isView(buf)) {
    const view = new Uint8Array(buf.byteLength);

    view.set(new Uint8Array(buf.buffer, buf.byteOffset));

    return view.buffer;
  }

  if(buf.slice) return buf.slice();
}
