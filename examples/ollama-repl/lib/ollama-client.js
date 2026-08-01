/**
 * A tiny, dedicated Ollama `/api/chat` client built directly on the
 * `httpClient` protocol adapter (`lib/lws/protocols.js`) - the same
 * adapter `fetch()` (`lib/fetch.js`) is built on, but with its own
 * `LWSContext` and `LCCSCF_PIPELINE` connect flag so every request in a
 * REPL session reuses one persistent, kept-alive HTTP/1.1 connection to
 * the local Ollama server instead of opening a fresh TCP connection (and
 * paying a new connect/TLS-less-but-still-a-round-trip cost) per turn.
 *
 * Mirrors the connect/established/error wiring `fetch()` uses internally
 * (see lib/fetch.js) - a `#pending`/`settled` handoff between
 * `adapter.connect()` and the adapter's `established`/`error` hooks - just
 * narrowed to one fixed JSON endpoint instead of being a general-purpose
 * fetch() replacement.
 */
import createContext from '../../../lib/lws/context.js';
import { httpClient } from '../../../lib/lws/protocols.js';
import { LCCSCF_PIPELINE } from 'lws.so';

export class OllamaClient {
  #ctx;
  #adapter;
  #settled = new WeakMap();

  /**
   * @param {object} opts
   * @param {string} [opts.host]  Ollama server hostname
   * @param {number} [opts.port]  Ollama server port
   * @param {string} opts.model   model name, e.g. "qwen2.5-coder"
   */
  constructor({ host = 'localhost', port = 11434, model } = {}) {
    this.host = host;
    this.port = port;
    this.model = model;

    this.#adapter = httpClient(
      (req, resp) => {
        const record = this.#settled.get(req);
        record?.resolve(resp);
      },
      {
        error: (req, err) => {
          if(req) this.#settled.get(req)?.reject(err);
        },
      },
    );

    this.#ctx = createContext({ protocols: [{ name: 'http', ...this.#adapter }] });
  }

  /**
   * POSTs one non-streaming `/api/chat` request over the kept-alive
   * connection. `messages` is the standard Ollama chat array:
   * `[{ role: 'system' | 'user' | 'assistant', content: string }, ...]`.
   *
   * @returns {Promise<string>} the assistant's reply text
   */
  async chat(messages) {
    const url = `http://${this.host}:${this.port}/api/chat`;
    const body = JSON.stringify({ model: this.model, messages, stream: false });

    const resp = await new Promise((resolve, reject) => {
      this.#adapter
        .connect(this.#ctx, url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          ssl_connection: LCCSCF_PIPELINE,
        })
        .then(({ req }) => this.#settled.set(req, { resolve, reject }))
        .catch(reject);
    });

    /* Not `resp.ok`: Response's `.ok` is computed once at construction
       time (lib/lws/response.js), before HttpClientProtocol patches in
       the real status on establishment (see onEstablishedClientHttp,
       lib/lws/protocols.js) - it's always true regardless of the actual
       response code. Check `.status` directly instead. */
    if(resp.status < 200 || resp.status >= 300) throw new Error(`Ollama HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);

    const data = await resp.json();

    if(!data?.message?.content) throw new Error(`unexpected Ollama response: ${JSON.stringify(data)}`);

    return data.message.content;
  }

  destroy() {
    this.#ctx.destroy();
  }
}
