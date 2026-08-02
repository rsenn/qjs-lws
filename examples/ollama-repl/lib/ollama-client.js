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
 *
 * chat() sends `stream: false` and returns the complete reply in one go;
 * chatStream() sends `stream: true` and reads Ollama's newline-delimited
 * JSON response incrementally as it arrives on the wire - no child process
 * or second connection needed, since the response body is a real
 * ReadableStream already (see chatStream()'s own comment below).
 */
import createContext from '../../../lib/lws/context.js';
import { httpClient } from '../../../lib/lws/protocols.js';
import { LCCSCF_PIPELINE, toString } from 'lws.so';

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

  /** Shared connect+await-response half of chat()/chatStream() below. */
  async #post(payload) {
    const url = `http://${this.host}:${this.port}/api/chat`;

    const resp = await new Promise((resolve, reject) => {
      this.#adapter
        .connect(this.#ctx, url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
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

    return resp;
  }

  /**
   * POSTs one non-streaming `/api/chat` request over the kept-alive
   * connection. `messages` is the standard Ollama chat array:
   * `[{ role: 'system' | 'user' | 'assistant', content: string }, ...]`.
   *
   * @returns {Promise<string>} the assistant's reply text
   */
  async chat(messages, { think = false, ...options } = {}) {
    const resp = await this.#post({ ...options, model: this.model, messages, stream: false, think });
    const data = await resp.json();

    if(!data?.message?.content) throw new Error(`unexpected Ollama response: ${JSON.stringify(data)}`);

    return data.message.content;
  }

  /**
   * Same as chat(), but with `stream: true` - Ollama sends the response as
   * newline-delimited JSON objects as each token is generated, over the
   * *same* kept-alive HTTP/1.1 connection (verified against a real Ollama
   * server: chunks arrive well before the full reply is done). Reads
   * `resp.body` (a real WHATWG ReadableStream - lib/lws/streams.js, fed
   * chunk-by-chunk by HttpClientProtocol's onReceiveClientHttpRead,
   * lib/lws/protocols.js - not buffered up front) incrementally via
   * `getReader()`, so no child process or second connection is needed for
   * token-by-token output.
   *
   * @param {(token: string) => void} onToken called once per token, in
   *   order, as they arrive - not once per network chunk, since a chunk
   *   can (and often does) contain a partial line or several complete ones.
   * @returns {Promise<string>} the full assistant reply, once done
   */
  async chatStream(messages, { think = false, ...options } = {}, onToken) {
    const resp = await this.#post({ ...options, model: this.model, messages, stream: true, think });
    const reader = resp.body.getReader();

    let buf = '';
    let full = '';

    for(;;) {
      const { done, value } = await reader.read();

      /* toString() (lws.so) only accepts a real ArrayBuffer - passed a
         Uint8Array *view* (what getReader().read() yields here, per
         WHATWG - see readableStreamCallback()'s enqueue calls,
         lib/lws/protocols.js) it silently returns undefined instead of
         throwing (see BUGS: tostring-silently-undefined-on-typed-array-view).
         Slice out the view's own backing ArrayBuffer region first. */
      if(!done) buf += toString(value /*.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)*/);

      let idx;
      while((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if(!line.trim()) continue;

        const chunk = JSON.parse(line);
        const token = chunk.message?.content ?? '';

        if(token) {
          full += token;
          onToken(token);
        }

        if(chunk.done) return full;
      }

      if(done) return full;
    }
  }

  destroy() {
    this.#ctx.destroy();
  }
}
