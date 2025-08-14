import { ReadableStream, WritableStream } from './lws/streams.js';
import { define, mapper } from './lws/util.js';
import { WebSocket } from './websocket.js';
import { inspect } from 'inspect';

/**
 * An interface for handling WebSocket connections using streams.
 *
 * For more information, see: https://developer.mozilla.org/en-US/docs/Web/API/WebSocketStream
 */
export class WebSocketStream {
  #ws;

  constructor(url, options = {}) {
    const { signal, protocols, ctor = WebSocket } = Array.isArray(options) ? { protocols: options } : options;

    signal?.addEventListener('abort', () => this.close(), {
      once: true,
    });

    this.#ws = new ctor(url, protocols);
    this.#ws.binaryType = 'arraybuffer';

    define(this, {
      /**
       * A promise that resolves when the WebSocket connection is opened. Among other features, this object contains a
       * ReadableStream and a WritableStream instance for receiving and sending data on the connection.
       */
      opened: new Promise((resolve, reject) => {
        this.#ws.addEventListener('open', () =>
          resolve({
            extensions: this.#ws.extensions,
            protocol: this.#ws.protocol,
            readable: new ReadableStream({
              start: controller => {
                this.#ws.addEventListener('message', event => controller.enqueue(event.data));
                this.#ws.addEventListener('close', () => {
                  try {
                    controller.close();
                  } catch {}
                });
              },
              cancel: () => this.#ws.close(),
            }),
            writable: new WritableStream({
              start: controller => this.#ws.addEventListener('close', () => controller.error()),
              write: async chunk => {
                await ctor.waitWrite(this.#ws);

                return this.#ws.send(chunk);
              },
              close: () => this.#ws.close(),
              abort: reason => this.#ws.close(undefined, reason),
            }),
          }),
        );
        this.#ws.addEventListener('error', err => reject(new Error('WebSocketStream error: ' + err.message)));
      }),
      /**
       * A promise that resolves when the WebSocket connection is closed, providing the close code and reason.
       */
      closed: new Promise(resolve => {
        this.#ws.addEventListener('close', event => {
          resolve({
            closeCode: event.code,
            reason: event.reason,
          });
        });
      }),
    });
  }

  /**
   * The URL of the WebSocket connection.
   */
  get url() {
    return this.#ws.url;
  }

  /**
   * Closes the WebSocket connection.
   */
  close({ closeCode, reason } = {}) {
    this.#ws.close(closeCode, reason);
  }
}

WebSocketStream.prototype[Symbol.toStringTag] = 'WebSocketStream';
