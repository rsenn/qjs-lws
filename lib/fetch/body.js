import { toArrayBuffer } from 'lws';

function isDataView(obj) {
  return obj && isPrototypeOf(DataView.prototype, obj);
}

function consumed(body) {
  if(body._noBody) return;

  if(body.bodyUsed) return Promise.reject(new TypeError('Already read'));

  body.bodyUsed = true;
}

function fileReaderReady(reader) {
  return new Promise(function (resolve, reject) {
    reader.onload = function() {
      resolve(reader.result);
    };

    reader.onerror = function() {
      reject(reader.error);
    };
  });
}

function readBlobAsArrayBuffer(blob) {
  const reader = new FileReader();
  const promise = fileReaderReady(reader);

  reader.readAsArrayBuffer(blob);

  return promise;
}

function readBlobAsText(blob) {
  const reader = new FileReader();
  const promise = fileReaderReady(reader);
  const match = /charset=([A-Za-z0-9_-]+)/.exec(blob.type);
  const encoding = match ? match[1] : 'utf-8';

  reader.readAsText(blob, encoding);

  return promise;
}

function readArrayBufferAsText(buf) {
  const view = new Uint8Array(buf);
  const chars = new Array(view.length);

  for(let i = 0; i < view.length; i++) chars[i] = String.fromCharCode(view[i]);

  return chars.join('');
}

function bufferClone(buf) {
  if(buf.slice) {
    return buf.slice(0);
  } else {
    const view = new Uint8Array(buf.byteLength);

    view.set(new Uint8Array(buf));

    return view.buffer;
  }
}

function isPrototypeOf(a, b) {
  return Object.prototype.isPrototypeOf.call(a, b);
}

export class Body {
  blob() {
    const rejected = consumed(this);

    if(rejected) return rejected;

    if(this._bodyBlob) return Promise.resolve(this._bodyBlob);

    if(this._bodyArrayBuffer) return Promise.resolve(new Blob([this._bodyArrayBuffer]));

    if(this._bodyFormData) throw new Error('could not read FormData body as blob');

    return Promise.resolve(new Blob([this._bodyText]));
  }

  arrayBuffer() {
    if(this._bodyArrayBuffer) {
      const isConsumed = consumed(this);

      if(isConsumed) return isConsumed;

      if(ArrayBuffer.isView(this._bodyArrayBuffer))
        return Promise.resolve(this._bodyArrayBuffer.buffer.slice(this._bodyArrayBuffer.byteOffset, this._bodyArrayBuffer.byteOffset + this._bodyArrayBuffer.byteLength));

      return Promise.resolve(this._bodyArrayBuffer);
    }

    if(typeof this._bodyText == 'string') {
      const isConsumed = consumed(this);

      if(isConsumed) return isConsumed;

      try {
        return toArrayBuffer(this._bodyText);
      } catch(e) {
        console.log('arrayBuffer', { bodyText: this._bodyText, error: e.message });
      }
    }

    return this.blob().then(readBlobAsArrayBuffer);
  }

  text() {
    const rejected = consumed(this);

    if(rejected) return rejected;

    if(this._bodyBlob) return readBlobAsText(this._bodyBlob);
    if(this._bodyArrayBuffer) return Promise.resolve(readArrayBufferAsText(this._bodyArrayBuffer));
    if(this._bodyFormData) throw new Error('could not read FormData body as text');

    return Promise.resolve(this._bodyText);
  }

  formData() {
    return this.text().then(decode);
  }

  json() {
    return this.text().then(JSON.parse);
  }
}

Body.prototype[Symbol.toStringTag] = 'Body';
Body.prototype.bodyUsed = false;

assign(Body.prototype, { _bodyInit: null });

export function InitBody(body) {
  assign(this, { _bodyInit: body });

  if(!body && body !== '') {
    assign(this, { _noBody: true });
    assign(this, { _bodyText: '' });
  } else if(typeof body === 'string') {
    assign(this, { _bodyText: body });
  } else if(isPrototypeOf(globalThis.Blob?.prototype, body)) {
    assign(this, { _bodyBlob: body });
  } else if(isPrototypeOf(globalThis.FormData?.prototype, body)) {
    assign(this, { _bodyFormData: body });
  } else if(isPrototypeOf(globalThis.URLSearchParams?.prototype, body)) {
    assign(this, { _bodyText: body.toString() });
  } else if(isDataView(body)) {
    assign(this, { _bodyArrayBuffer: bufferClone(body.buffer) });
  } else if(isPrototypeOf(ArrayBuffer.prototype, body) || ArrayBuffer.isView(body)) {
    assign(this, { _bodyArrayBuffer: bufferClone(body) });
  } else {
    assign(this, { _bodyText: (body = Object.prototype.toString.call(body)) });
  }

  if(!this.headers.get('content-type')) {
    if(typeof body === 'string') {
      this.headers.set('content-type', 'text/plain;charset=UTF-8');
    } else if(this._bodyBlob && this._bodyBlob.type) {
      this.headers.set('content-type', this._bodyBlob.type);
    } else if(isPrototypeOf(globalThis.URLSearchParams?.prototype, body)) {
      this.headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
    }
  }
}

function assign(obj, ...args) {
  for(let props of args) for (let prop in props) Object.defineProperty(obj, prop, { value: props[prop], configurable: true, writable: true });
}

function decode(body) {
  const form = new FormData();

  body
    .trim()
    .split('&')
    .forEach(function (bytes) {
      if(bytes) {
        const split = bytes.split('=');
        const name = split.shift().replace(/\+/g, ' ');
        const value = split.join('=').replace(/\+/g, ' ');

        form.append(decodeURIComponent(name), decodeURIComponent(value));
      }
    });

  return form;
}
