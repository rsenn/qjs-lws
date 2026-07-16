import { LWSSPA } from 'lws.so';
import { ReadableStream } from './lib/lws/streams.js';

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
        controller.enqueue(
          Object.assign(
            new ReadableStream({
              start: c => (this.controller = c),
            }),
            { name, filename },
          ),
        );
      },
      onContent(name, filename, chunk) {
        this.controller.enqueue(chunk);
      },
      onContentFinal(name, filename, chunk) {
        this.controller.enqueue(chunk);
      },
      onClose(name, filename) {
        this.controller.close();
      },
    });
  }

  process(buf) {
    return this.#spa.process(buf);
  }

  [Symbol.asyncIterator]() { return this.#stream[Symbol.asyncIterator](); }
}
