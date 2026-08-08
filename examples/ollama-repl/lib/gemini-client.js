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
 *
 * `messages`/`options`/return value follow this project's shared message
 * and tool-use format (documented in `../API.md`, not Ollama's own wire
 * shape) - `#toContents()` converts it natively into Gemini's `contents`/
 * `tools`/`toolConfig` request shape and back out of its response.
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
  #timeoutMs;

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
    this.#timeoutMs = timeoutSecs * 1000;

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
   * Converts this project's shared message format (see API.md) into
   * Gemini's `contents` array. `Content.role` only ever accepts `'user'` or
   * `'model'` in this API - there is no third `'function'`/`'tool'` role -
   * so `assistant` maps to `model`, `system` messages are pulled out into a
   * separate `systemInstruction`, and `tool` messages (this project's
   * format) map to a `'user'`-role turn carrying a `functionResponse` part,
   * per the API's own contract for replying to a `functionCall`.
   */
  #toContents(messages) {
    const systemParts = [];
    const contents = [];

    for(const { role, content, toolCalls, name } of messages) {
      if(role === 'system') {
        systemParts.push({ text: content });
        continue;
      }

      if(role === 'tool') {
        const response = content != null && typeof content === 'object' ? content : { result: content };
        contents.push({ role: 'user', parts: [{ functionResponse: { name, response } }] });
        continue;
      }

      const parts = [];
      if(content) parts.push({ text: content });
      for(const tc of toolCalls ?? []) parts.push({ functionCall: { name: tc.name, args: tc.args } });

      contents.push({ role: role === 'assistant' ? 'model' : 'user', parts });
    }

    return { contents, systemInstruction: systemParts.length ? { parts: systemParts } : undefined };
  }

  /** `toolChoice` (see API.md) -> Gemini's `toolConfig.functionCallingConfig`. */
  #toToolConfig(toolChoice) {
    if(!toolChoice) return undefined;

    const { mode, allowed } = typeof toolChoice === 'string' ? { mode: toolChoice } : toolChoice;
    return { functionCallingConfig: { mode: mode.toUpperCase(), ...(allowed ? { allowedFunctionNames: allowed } : {}) } };
  }

  /** Shared connect+await-response half of chat()/chatStream() below. */
  async #post(pathSuffix, messages, { tools, toolChoice, ...options }) {
    const { contents, systemInstruction } = this.#toContents(messages);

    const payload = {
      ...options,
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(tools ? { tools: [{ functionDeclarations: tools.map(({ name, description, parameters }) => ({ name, description, parameters })) }] } : {}),
      ...(toolChoice ? { toolConfig: this.#toToolConfig(toolChoice) } : {}),
    };
    this.#debugConsole?.debug('request', payload);

    const url = `${API_BASE}/${this.model}:${pathSuffix}`;

    const { req, wsi } = await this.#adapter.connect(this.#ctx, url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.#apiKey },
      body: JSON.stringify(payload),
      ssl_connection: LCCSCF_PIPELINE,
    });

    // Registered synchronously, right after connect() resolves - no
    // `await` in between - see OllamaClient#post's identical comment for
    // why that ordering matters.
    const resp = await this.#awaitResponse(req, wsi);

    // See OllamaClient#post's identical comment: `.status`, not `.ok`.
    if(resp.status < 200 || resp.status >= 300) throw new Error(`Gemini HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);

    return resp;
  }

  /** Same backstop as OllamaClient#awaitResponse - see its own doc comment. */
  #awaitResponse(req, wsi) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#take(req);
        wsi?.close();
        reject(new Error(`Gemini: no response after ${(this.#timeoutMs / 1000).toFixed(0)}s - connection appears dead, aborting`));
      }, this.#timeoutMs);

      this.#settled.set(req, {
        wsi,
        resolve: v => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: e => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  /** Same rationale as OllamaClient#abort - see its own doc comment.
   * @returns {boolean} whether a pending request was actually aborted */
  abort() {
    if(!this.#settled.size) return false;

    for(const { reject, wsi } of this.#settled.values()) {
      wsi?.close();
      reject(new Error('aborted (Ctrl-C)'));
    }

    this.#settled.clear();
    return true;
  }

  /** Same backstop as OllamaClient#readWithTimeout - see its own doc comment. */
  #readWithTimeout(reader) {
    let timer;

    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reader.cancel().catch(() => {});
        reject(new Error(`Gemini: stream stalled - no data for ${(this.#timeoutMs / 1000).toFixed(0)}s, aborting`));
      }, this.#timeoutMs);
    });

    return Promise.race([reader.read(), timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * Pulls `{ content, toolCalls }` (see API.md) out of one candidate's
   * `parts[]` - shared between chat()'s single response and chatStream()'s
   * per-event chunks. `id` is synthesized here (`name#index`); neither this
   * API nor Ollama's gives one - see API.md's "common shape" note.
   */
  #toResult(parts) {
    const content = parts.filter(p => p.text != null).map(p => p.text).join('');
    const toolCalls = parts.filter(p => p.functionCall).map((p, i) => ({ id: `${p.functionCall.name}#${i}`, name: p.functionCall.name, args: p.functionCall.args ?? {} }));

    return { content, toolCalls: toolCalls.length ? toolCalls : undefined };
  }

  /**
   * POSTs one non-streaming `:generateContent` request. `messages`/`options`
   * follow this project's shared message/tool-use format - see API.md.
   *
   * @returns {Promise<{content: string, toolCalls?: object[]}>}
   */
  async chat(messages, options = {}) {
    const resp = await this.#post('generateContent', messages, options);
    const data = await resp.json();
    this.#debugConsole?.debug('response', data);

    const parts = data?.candidates?.[0]?.content?.parts;
    if(!parts) throw new Error(`unexpected Gemini response: ${JSON.stringify(data)}`);

    const result = this.#toResult(parts);
    if(!result.content && !result.toolCalls) throw new Error(`unexpected Gemini response: ${JSON.stringify(data)}`);

    return result;
  }

  /**
   * Same as chat(), but posts to `:streamGenerateContent?alt=sse` -
   * Gemini sends the response as Server-Sent Events, one `data: {...}`
   * JSON chunk per event, as each part of the reply is generated. A
   * `functionCall` part arrives whole in one event (see API.md) rather
   * than token-by-token like `text`, so it's only visible in the returned
   * object, not via `onToken`.
   *
   * @param {(token: string) => void} onToken called once per text chunk,
   *   in order, as SSE events arrive
   * @returns {Promise<{content: string, toolCalls?: object[]}>}
   */
  async chatStream(messages, options = {}, onToken) {
    const resp = await this.#post('streamGenerateContent?alt=sse', messages, options);
    const reader = resp.body.getReader();

    let buf = '';
    let full = '';
    const toolCalls = [];

    for(;;) {
      const { done, value } = await this.#readWithTimeout(reader);

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

        const parts = chunk?.candidates?.[0]?.content?.parts ?? [];
        const { content: token, toolCalls: chunkCalls } = this.#toResult(parts);

        if(token) {
          full += token;
          onToken(token);
        }

        for(const tc of chunkCalls ?? []) toolCalls.push({ ...tc, id: `${tc.name}#${toolCalls.length}` });
      }

      if(done) return { content: full, toolCalls: toolCalls.length ? toolCalls : undefined };
    }
  }

  /* Idempotent - see BUGS: repl-controlc-double-invokes-cleanup-handlers.
     A double Ctrl-C in the REPL (lib/chat-repl.js's base class) runs every
     registered cleanup handler, including this one via destroy(), twice;
     without this guard the second call's this.#debugFile?.close() throws
     "invalid file handle" on the already-closed handle, and since that
     throw happens inside the REPL's own exit()'s cleanup loop - which
     runs *before* exit()'s std.exit() call - it silently stops the
     process from ever actually exiting. */
  #destroyed = false;

  destroy() {
    if(this.#destroyed) return;
    this.#destroyed = true;

    this.#ctx.destroy();
    this.#debugFile?.close();
  }
}
