import { toArrayBuffer, toString } from 'lws';
import { ReadableStream } from '../streams.js';
import { SimpleQueue } from '../simple-queue.js';
import { Blob } from 'blob';

function isDataView(obj) {
  return obj && isPrototypeOf(DataView.prototype, obj);
}

function consumed(body) {
  if(body._noBody) return;

  if(body.bodyUsed) return Promise.reject(new TypeError('Already read'));

  body.bodyUsed = true;
}

function bufferClone(buf) {
  if(ArrayBuffer.isView(buf)) {
    const view = new Uint8Array(buf.byteLength);

    view.set(new Uint8Array(buf.buffer, buf.byteOffset));

    return view.buffer;
  }

  if(buf.slice) return buf.slice();
}

function isPrototypeOf(a, b) {
  return Object.prototype.isPrototypeOf.call(a, b);
}

export class Body {
  #stream;
  #bodyBlob;
  #bodyFormData;
  #bodyArrayBuffer;
  #bodyText;
  #chunks;

  static init(instance, body) {
    assign(instance, { _bodyInit: body });

    if(!body && body !== '') ((instance.#bodyText = ''), assign(instance, { _noBody: true }));
    else if(typeof body == 'string') instance.#bodyText = body;
    else if(isPrototypeOf(Blob?.prototype, body)) instance.#bodyBlob = body;
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

  static write(instance, chunk) {
    if(#chunks in instance) instance.#chunks ??= new SimpleQueue();

    instance._noBody = false;

    instance.#chunks.push(chunk);
  }

  static complete(instance) {
    if(#chunks in instance) instance.#chunks.push(null);
  }

  blob() {
    const isConsumed = consumed(this);

    if(isConsumed) return isConsumed;

    if(this.#bodyBlob) return Promise.resolve(this.#bodyBlob);
    if(this.#bodyArrayBuffer) return Promise.resolve(new Blob([this.#bodyArrayBuffer]));
    if(this.#bodyFormData) return Promise.reject(new Error('could not read FormData body as blob'));
    if(this.#bodyText) return Promise.resolve(new Blob([this.#bodyText]));
  }

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
  }

  text() {
    const isConsumed = consumed(this);

    if(isConsumed) return isConsumed;

    if(this.#bodyBlob) return this.#bodyBlob.text();
    if(this.#bodyArrayBuffer) return Promise.resolve(toString(this.#bodyArrayBuffer));
    if(this.#bodyFormData) return Promise.reject(new Error('could not read FormData body as text'));
    if(this.#bodyText) return Promise.resolve(this.#bodyText);
  }

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

  json() {
    return this.text().then(JSON.parse);
  }

  get body() {
    if(this._noBody) return null;
    //if(this.method != 'POST') return null;

    return (this.#stream ??= new ReadableStream(
      this.#chunks
        ? {
            start() {},
            pull: async controller => {
              if(this.#chunks.length > 0) {
                const chunk = this.#chunks.shift();

                if(chunk === null) controller.close();
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
}

Body.prototype[Symbol.toStringTag] = 'Body';
Body.prototype.bodyUsed = false;

assign(Body.prototype, { _bodyInit: null });

function assign(obj, ...args) {
  for(let props of args) for (let prop in props) Object.defineProperty(obj, prop, { value: props[prop], configurable: true, writable: true });
}
