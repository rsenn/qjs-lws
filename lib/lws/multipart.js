import { LWSSPA } from 'lws.so';
import { ReadableStream, ByteLengthQueuingStrategy } from './streams.js';
import { weakMapper, debug } from './util.js';

export class MultipartStream extends ReadableStream {
  constructor(cb, props = {}) {
    super({ start: c => cb({ write: chunk => c.enqueue(chunk), close: () => c.close() }) });

    Object.assign(this, props);
  }
}

MultipartStream.prototype[Symbol.toStringTag] = 'MultipartStream';

export class MultipartParser {
  #spa;
  #stream;

  constructor(wsi) {
    let controller;

    this.#stream = new ReadableStream({
      start: c => (controller = c),
    });

    this.#spa = new LWSSPA(wsi, {
      onOpen(name, filename) {
        debug(2, 'LWSSPA.onOpen', { name, filename });

        controller.enqueue(new MultipartStream(c => (this.controller = c), { name, filename }));
      },
      onContent(name, filename, chunk) {
        debug(2, 'LWSSPA.onContent', { name, filename, chunkSize: chunk.byteLength });
        this.controller.write(chunk);
      },
      onFinalContent(name, filename, chunk) {
        debug(2, 'LWSSPA.onFinalContent', { name, filename, chunkSize: chunk.byteLength });
        this.controller.write(chunk);
        this.controller.close();
        delete this.controller;
      },
      onClose(name, filename) {
        debug(2, 'LWSSPA.onClose', { name, filename });
        controller.close();
      },
    });
  }

  write(buf) {
    debug(3, 'MultipartParser.write', buf);
    this.#spa.process(buf);
  }

  close() {
    debug(3, 'MultipartParser.close');
    this.#spa.finalize();
  }

  [Symbol.asyncIterator]() {
    return this.#stream[Symbol.asyncIterator]();
  }

  static protocol(callback = () => {}) {
    const wsi2multipart = weakMapper(wsi => {
      const parser = new MultipartParser(wsi);
      callback?.(parser);
      return parser;
    });

    debug('MultipartParser.protocol');

    return {
      onHttpBody: (wsi, buf) => wsi2multipart(wsi).write(buf),
      onHttpBodyCompletion: wsi => (wsi2multipart(wsi).close(), wsi2multipart(wsi, null)),
    };
  }
}

MultipartParser.prototype[Symbol.toStringTag] = 'MultipartParser';
