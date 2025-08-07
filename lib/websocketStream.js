import { CONNECTING, OPEN, CLOSING, CLOSED, WebSocket } from './websocket.js';
import { WritableStream, ReadableStream } from './streams.js';

const ALLOWED_PROTOCOLS = ['ws:', 'wss:', 'http:', 'https:'];

/**
 * An interface for handling WebSocket connections using streams.
 *
 * For more information, see: https://developer.mozilla.org/en-US/docs/Web/API/WebSocketStream
 */
export class WebSocketStream {
  #ws;

  constructor(url, { signal, protocols, ctor = WebSocket } = {}) {
    if(!ALLOWED_PROTOCOLS.find(p => url.toString().startsWith(p)))
      throw new SyntaxError(`Failed to create WebSocketStream. Cause: Invalid URL protocol. Possible values are: ${ALLOWED_PROTOCOLS.map(protocol => `"${protocol}"`).join(', ')}.`);

    signal?.addEventListener('abort', () => this.close(), {
      once: true,
    });

   const ws = this.#ws = new ctor(url, protocols);
    //this.#ws.binaryType = 'arraybuffer';

    Object.defineProperties(this, {
      opened: {
        value: new Promise((resolve, reject) => {
          this.#ws.addEventListener('open', () =>
            resolve({
              get extensions() { return ws.extensions; },
              get protocol() { return ws.protocol; },
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
                write: chunk => this.#ws.send(chunk),
                close: () => this.#ws.close(),
                abort: reason => this.#ws.close(undefined, reason),
              }),
            }),
          );
          this.#ws.addEventListener('error', () => reject(new Error('WebSocket error')));
        }),
      },
      closed: {
        value: new Promise(resolve => {
          this.#ws.addEventListener('close', event => {
            resolve({
              closeCode: event.code,
              reason: event.reason,
            });
          });
        }),
      },
    });
  }

  /**
   * The URL of the WebSocket connection.
   */ get url() {
    return this.#ws.url;
  }

  /**
   * Closes the WebSocket connection.
   */ 
  close({ closeCode, reason } = {}) {
    this.#ws.close(closeCode, reason);
  }
}

WebSocketStream.prototype[Symbol.toStringTag]='WebSocketStream';
