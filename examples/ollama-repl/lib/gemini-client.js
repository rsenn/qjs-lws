/**
 * A tiny Google Gemini `generateContent`/`streamGenerateContent` client
 * (https://ai.google.dev/api/generate-content), built directly on the
 * `httpClient` protocol adapter (`lib/lws/protocols.js`) with its own
 * `LWSContext` - same structure as `OllamaClient` (./ollama-client.js) -
 * rather than the shared `fetch()` (lib/fetch.js): `fetch()`'s pooled
 * context never overrides lws's own 15s connection timeout, which Gemini
 * can easily exceed on a "thinking" response (confirmed directly: a real
 * request closed with a bare "closed" ConnectionError after ~15s before
 * this client switched to its own long-timeout context - see BUGS).
 *
 * `chat()` posts to `:generateContent` and returns the complete reply in
 * one go; `chatStream()` posts to `:streamGenerateContent?alt=sse` and
 * reads the SSE (blank-line-delimited `data: {...}`) response
 * incrementally as it arrives, same shape as `OllamaClient#chatStream` - a
 * real `ReadableStream` (lib/lws/streams.js), no child process or second
 * connection needed.
 */
import createContext from '../../../lib/lws/context.js';
import { httpClient } from '../../../lib/lws/protocols.js';
import {
  LCCSCF_PIPELINE,
  LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX,
  LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT,
  LWS_SERVER_OPTION_IGNORE_MISSING_CERT,
  toString,
} from 'lws.so';
import { Console } from 'console';
import { open as fopen, getenv } from 'std';

const DEFAULT_MODEL = 'gemini-flash-latest';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/* Same rationale as OllamaClient's own DEFAULT_TIMEOUT_SECS: lws's 15s
   built-in default (see wsi-timeout.c/context.c) is too short for a
   "thinking" model response. Overridable via `timeoutSecs` for tests/
   tuning. */
const DEFAULT_TIMEOUT_SECS = 15 * 60;

/* Mirrors OllamaClient's own debug log (see its DEBUG_LOG_PATH comment)
   but kept in a separate file so the two clients' logs don't interleave. */
const DEBUG_LOG_PATH = 'gemini-repl-debug.log';

export class GeminiClient {
  #apiKey;
  #ctx;
  #adapter;
  /** Same req -> {resolve, reject} bookkeeping as OllamaClient#settled -
      see its own doc comment for why this is a plain Map, not a WeakMap. */
  #settled = new Map();
  #debugConsole;
  #debugFile;

  /**
   * @param {object} opts
   * @param {string} [opts.apiKey] Gemini API key; defaults to the
   *   `GEMINI_API_KEY` environment variable
   * @param {string} [opts.model]  model name, e.g. "gemini-flash-latest"
   * @param {number} [opts.timeoutSecs] how long a request may wait before
   *   lws gives up on it (see DEFAULT_TIMEOUT_SECS above)
   * @param {boolean} [opts.debug] log every request/response to
   *   DEBUG_LOG_PATH (also turned on by the `DEBUG` env var, regardless
   *   of this flag)
   */
  constructor({ apiKey = getenv('GEMINI_API_KEY'), model = DEFAULT_MODEL, timeoutSecs = DEFAULT_TIMEOUT_SECS, debug = false } = {}) {
    if(!apiKey) throw new Error('GeminiClient: no API key (pass opts.apiKey or set GEMINI_API_KEY)');

    this.#apiKey = apiKey;
    this.model = model;

    if(debug || getenv('DEBUG')) {
      this.#debugFile = fopen(DEBUG_LOG_PATH, 'a');
      this.#debugConsole = new Console(this.#debugFile, { inspectOptions: { depth: Infinity, compact: false } });
    }

    this.#adapter = httpClient(
      (req, resp) => this.#take(req)?.resolve(resp),
      { error: (req, err) => this.#reject(req, err) },
    );

    /* Same SSL-enabling context options lib/fetch.js's buildContext() uses
       for a plain HTTPS request with no client-cert-style `tls` object -
       lws needs LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX (+ friends) up
       front to be able to make any TLS client connection at all. */
    this.#ctx = createContext({
      options: LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT | LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX | LWS_SERVER_OPTION_IGNORE_MISSING_CERT,
      protocols: [{ name: 'http', ...this.#adapter }],
      timeout_secs: timeoutSecs,
    });
  }

  #take(req) {
    const record = this.#settled.get(req);
    this.#settled.delete(req);
    return record;
  }

  /** Same rationale as OllamaClient#reject - see its own doc comment. */
  #reject(req, err) {
    const reason = new Error(`Gemini connection failed: ${err.message}`);

    if(req) {
      this.#take(req)?.reject(reason);
      return;
    }

    for(const { reject } of this.#settled.values()) reject(reason);
    this.#settled.clear();
  }

  /**
   * Converts the standard Ollama-shaped `[{ role, content }, ...]` message
   * array (same shape `OllamaClient#chat` takes) into Gemini's `contents`
   * array - Gemini only accepts `role: 'user' | 'model'` in `contents`, so
   * `assistant` maps to `model` and any `system` messages are pulled out
   * into a separate `systemInstruction` instead.
   */
  #toContents(messages) {
    const systemParts = [];
    const contents = [];

    for(const { role, content } of messages) {
      if(role === 'system') {
        systemParts.push({ text: content });
        continue;
      }

      contents.push({ role: role === 'assistant' ? 'model' : 'user', parts: [{ text: content }] });
    }

    return { contents, systemInstruction: systemParts.length ? { parts: systemParts } : undefined };
  }

  /** Shared connect+await-response half of chat()/chatStream() below. */
  async #post(pathSuffix, messages, options) {
    const { contents, systemInstruction } = this.#toContents(messages);
    const payload = { ...options, contents, ...(systemInstruction ? { systemInstruction } : {}) };
    this.#debugConsole?.debug('request', payload);

    const url = `${API_BASE}/${this.model}:${pathSuffix}`;

    const { req } = await this.#adapter.connect(this.#ctx, url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.#apiKey },
      body: JSON.stringify(payload),
      ssl_connection: LCCSCF_PIPELINE,
    });

    // Registered synchronously, right after connect() resolves - no
    // `await` in between - see OllamaClient#post's identical comment for
    // why that ordering matters.
    const resp = await new Promise((resolve, reject) => this.#settled.set(req, { resolve, reject }));

    // See OllamaClient#post's identical comment: `.status`, not `.ok`.
    if(resp.status < 200 || resp.status >= 300) throw new Error(`Gemini HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);

    return resp;
  }

  /**
   * POSTs one non-streaming `:generateContent` request. `messages` is the
   * standard Ollama chat array: `[{ role: 'system' | 'user' | 'assistant',
   * content: string }, ...]`.
   *
   * @returns {Promise<string>} the model's reply text
   */
  async chat(messages, options = {}) {
    const resp = await this.#post('generateContent', messages, options);
    const data = await resp.json();
    this.#debugConsole?.debug('response', data);

    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('');
    if(!text) throw new Error(`unexpected Gemini response: ${JSON.stringify(data)}`);

    return text;
  }

  /**
   * Same as chat(), but posts to `:streamGenerateContent?alt=sse` -
   * Gemini sends the response as Server-Sent Events, one `data: {...}`
   * JSON chunk per event, as each part of the reply is generated.
   *
   * @param {(token: string) => void} onToken called once per text chunk,
   *   in order, as SSE events arrive
   * @returns {Promise<string>} the full reply text, once done
   */
  async chatStream(messages, options = {}, onToken) {
    const resp = await this.#post('streamGenerateContent?alt=sse', messages, options);
    const reader = resp.body.getReader();

    let buf = '';
    let full = '';

    for(;;) {
      const { done, value } = await reader.read();

      /* toString() (lws.so) only accepts a real ArrayBuffer - a Uint8Array
         *view* (what getReader().read() yields, per WHATWG) silently
         returns undefined instead of throwing (see BUGS:
         tostring-silently-undefined-on-typed-array-view, and
         OllamaClient#chatStream's identical use of toString() below). */
      if(!done) buf += toString(value);

      let m;
      while((m = buf.match(/\r?\n\r?\n/))) {
        const event = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);

        const dataLine = event.split(/\r?\n/).find(line => line.startsWith('data:'));
        if(!dataLine) continue;

        const chunk = JSON.parse(dataLine.slice(5).trim());
        this.#debugConsole?.debug('chunk', chunk);

        const token = chunk?.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';

        if(token) {
          full += token;
          onToken(token);
        }
      }

      if(done) return full;
    }
  }

  destroy() {
    this.#ctx.destroy();
    this.#debugFile?.close();
  }
}
