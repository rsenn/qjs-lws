/**
 * A generic OpenAI-compatible `chat/completions` client, built directly on
 * the `httpClient` protocol adapter (`lib/lws/protocols.js`) with its own
 * `LWSContext` - same structure as `GeminiClient`/`OllamaClient`
 * (./gemini-client.js, ./ollama-client.js), rather than the shared
 * `fetch()` (lib/fetch.js), for the same long-timeout reason documented
 * in GeminiClient's own header comment.
 *
 * Works with any provider that speaks the OpenAI `chat/completions` wire
 * format - OpenAI itself, Mistral, Together, Groq, OpenRouter, local
 * servers like vLLM/litellm, etc. Configure via `baseUrl` (the base URL
 * up to but not including `/chat/completions`), `apiKey`, and `model`.
 *
 * The wire shape is: `messages`/`tools` already close to this project's
 * shared format (see API.md), and streaming is SSE (`data: {...}` chunks,
 * terminated by a literal `data: [DONE]`), same framing as GeminiClient's
 * `alt=sse` stream - just with a different chunk shape and, unlike
 * Gemini/Ollama, tool-call *arguments* arriving as incremental string
 * fragments across several chunks (keyed by `index`) rather than whole in
 * one event - see chatStream()'s own comment.
 *
 * `messages`/`options`/return value follow this project's shared message
 * and tool-use format (documented in `../API.md`, not any particular
 * provider's wire shape) - `#toMessages()` converts it natively into the
 * OpenAI-style `messages`/`tools`/`tool_choice` request shape and back
 * out of its response.
 */
import createContext from '../../../lib/lws/context.js';
import { httpClient } from '../../../lib/lws/protocols.js';
import { LCCSCF_PIPELINE, LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX, LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT, LWS_SERVER_OPTION_IGNORE_MISSING_CERT, toString } from 'lws.so';
import { Console } from 'console';
import { open as fopen, getenv } from 'std';

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_API_PATH = '/chat/completions';

/* Same rationale as OllamaClient's own DEFAULT_TIMEOUT_SECS: lws's 15s
   built-in default (see wsi-timeout.c/context.c) is too short for a slow
   response. Overridable via `timeoutSecs` for tests/tuning. */
const DEFAULT_TIMEOUT_SECS = 15 * 60;

/* Mirrors OllamaClient's own IDLE_RECONNECT_MS - see its doc comment and
   BUGS: ollama-pipelined-connection-hangs-after-idle-gap. Not directly
   confirmed against every OpenAI-compatible provider's idle timeout (that
   repro was Ollama-specific), but OpenAIClient uses the identical
   LCCSCF_PIPELINE kept-alive pattern, so the same class of failure - a
   pipelined connection going silently dead during an idle gap between
   prompts, with no lifecycle callback ever firing to report it - applies
   here too. */
const IDLE_RECONNECT_MS = 30_000;

/* Mirrors OllamaClient's own debug log (see its DEBUG_LOG_PATH comment)
   but kept in a separate file so the clients' logs don't interleave. */
const DEBUG_LOG_PATH = 'openai-repl-debug.log';

export class OpenAIClient {
  #apiKey;
  #baseUrl;
  #apiPath;
  #ctx;
  #adapter;
  /** Same req -> {resolve, reject} bookkeeping as OllamaClient#settled -
      see its own doc comment for why this is a plain Map, not a WeakMap. */
  #settled = new Map();
  #debugConsole;
  #debugFile;
  #timeoutMs;
  #timeoutSecs;
  /** Same rationale as OllamaClient#lastActivityAt - see its own doc
      comment. */
  #lastActivityAt = null;

  /**
   * @param {object} opts
   * @param {string} [opts.apiKey] API key; defaults to the `OPENAI_API_KEY`
   *   environment variable (or `opts.apiKeyEnv` if set)
   * @param {string} [opts.apiKeyEnv] name of the environment variable to
   *   read the API key from when `opts.apiKey` is not supplied (default:
   *   `"OPENAI_API_KEY"`)
   * @param {string} [opts.baseUrl] base URL of the OpenAI-compatible API
   *   (default: the `OPENAI_API_URL` environment variable, or
   *   `"https://api.openai.com/v1"` if unset) - everything up to but not
   *   including the `/chat/completions` path
   * @param {string} [opts.apiPath] path appended to `baseUrl` for the chat
   *   completions endpoint (default: `"/chat/completions"`) - override for
   *   providers that use a different path
   * @param {string} [opts.model]  model name (default: `"gpt-4o-mini"`)
   * @param {number} [opts.timeoutSecs] how long a request may wait before
   *   lws gives up on it (see DEFAULT_TIMEOUT_SECS above)
   * @param {boolean} [opts.debug] log every request/response to
   *   DEBUG_LOG_PATH (also turned on by the `DEBUG` env var, regardless
   *   of this flag)
   */
  constructor({ apiKey, apiKeyEnv = 'OPENAI_API_KEY', baseUrl, apiPath = DEFAULT_API_PATH, model = DEFAULT_MODEL, timeoutSecs = DEFAULT_TIMEOUT_SECS, debug = false } = {}) {
    const resolvedKey = apiKey ?? getenv(apiKeyEnv);
    if(!resolvedKey) throw new Error(`OpenAIClient: no API key (pass opts.apiKey or set ${apiKeyEnv})`);

    this.#apiKey = resolvedKey;
    this.#baseUrl = (baseUrl ?? getenv('OPENAI_API_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#apiPath = apiPath;
    this.model = model;
    this.#timeoutMs = timeoutSecs * 1000;
    this.#timeoutSecs = timeoutSecs;

    if(debug || getenv('DEBUG')) {
      this.#debugFile = fopen(DEBUG_LOG_PATH, 'a');
      this.#debugConsole = new Console(this.#debugFile, { inspectOptions: { depth: Infinity, compact: false } });
    }

    this.#adapter = httpClient((req, resp) => this.#take(req)?.resolve(resp), { error: (req, err) => this.#reject(req, err) });

    /* Same SSL-enabling context options GeminiClient's own #newContext()
       uses for a plain HTTPS request with no client-cert-style `tls`
       object - lws needs LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX (+
       friends) up front to be able to make any TLS client connection at
       all. */
    this.#ctx = this.#newContext();
  }

  /** Same rationale as OllamaClient#newContext - see its own doc comment.
      Deliberately does *not* set LWS_SERVER_OPTION_H2_JUST_FIX_WINDOW_UPDATE_OVERFLOW
      - lws's h2 client can see a connection-level WINDOW_UPDATE that
      overflows its 31-bit tx-credit max and GOAWAYs the connection
      instead of just clamping (see BUGS:
      h2-window-update-overflow-fix-option-breaks-connect), but that
      option itself was confirmed to break the TLS connect() syscall
      entirely rather than fix anything - worse than the problem it's
      meant to solve. */
  #newContext() {
    return createContext({
      options: LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT | LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX | LWS_SERVER_OPTION_IGNORE_MISSING_CERT,
      protocols: [{ name: 'http', ...this.#adapter }],
      timeout_secs: this.#timeoutSecs,
    });
  }

  #take(req) {
    const record = this.#settled.get(req);
    this.#settled.delete(req);
    return record;
  }

  /** Same rationale as OllamaClient#reject - see its own doc comment. */
  #reject(req, err) {
    const reason = new Error(`OpenAI connection failed: ${err.message}`);

    if(req) {
      this.#take(req)?.reject(reason);
      return;
    }

    for(const { reject } of this.#settled.values()) reject(reason);
    this.#settled.clear();
  }

  /**
   * Converts this project's shared message format (see API.md) into the
   * OpenAI `messages` shape: an assistant message's `toolCalls` becomes
   * `tool_calls: [{ id, type: 'function', function: { name, arguments } }]`
   * (`arguments` is a JSON *string* here, unlike Ollama's object), and a
   * `tool` reply needs `tool_call_id` naming which call it answers - the
   * shared format's `toolCallId` (see API.md) is used when the caller
   * supplied it, else it falls back to the id of the oldest not-yet-
   * answered call from the immediately preceding assistant message (the
   * order tool results are pushed in the documented manual-usage loop),
   * and finally to the tool's own name if neither is available.
   */
  #toMessages(messages) {
    let pendingCallIds = [];

    return messages.map(({ role, content, toolCalls, name, toolCallId }) => {
      if(role === 'assistant' && toolCalls?.length) {
        pendingCallIds = toolCalls.map(tc => tc.id);
        return { role, content: content ?? '', tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } })) };
      }

      if(role === 'tool') {
        const id = toolCallId ?? pendingCallIds.shift() ?? name;
        return { role, name, content: typeof content === 'string' ? content : JSON.stringify(content), tool_call_id: id };
      }

      return { role, content };
    });
  }

  /** `tools` (see API.md) -> OpenAI's `{ type: 'function', function: {...} }` wrapping. */
  #toTools(tools) {
    return tools?.map(({ name, description, parameters }) => ({ type: 'function', function: { name, description, parameters } }));
  }

  /**
   * Pulls `{ content, toolCalls }` (see API.md) out of one OpenAI
   * `message` object (the non-streaming response shape) - `arguments` is a
   * JSON string here, unlike Ollama's object, so it needs parsing.
   */
  #toResult(message) {
    const toolCalls = message?.tool_calls?.map((tc, i) => ({ id: tc.id ?? `${tc.function.name}#${i}`, name: tc.function.name, args: tc.function.arguments ? JSON.parse(tc.function.arguments) : {} }));
    return { content: message?.content ?? '', toolCalls: toolCalls?.length ? toolCalls : undefined };
  }

  /** Shared connect+await-response half of chat()/chatStream() below. */
  async #post(payload) {
    // See OllamaClient#post's identical IDLE_RECONNECT_MS check/comment.
    if(this.#lastActivityAt != null && Date.now() - this.#lastActivityAt > IDLE_RECONNECT_MS) {
      this.#ctx.destroy();
      this.#ctx = this.#newContext();
    }

    this.#debugConsole?.debug('request', payload);

    const url = `${this.#baseUrl}${this.#apiPath}`;

    const { req, wsi } = await this.#adapter.connect(this.#ctx, url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#apiKey}` },
      body: JSON.stringify(payload),
      ssl_connection: LCCSCF_PIPELINE,
      /* Forces http/1.1 over ALPN instead of letting the server negotiate
         h2 - some OpenAI-compatible servers send a connection-level
         WINDOW_UPDATE that overflows lws's 31-bit tx-credit max
         (`0x10000 + 0x7fff0000 = 0x80000000`), which lws treats as a
         flow-control protocol error and GOAWAYs the connection before any
         response ever arrives (see BUGS:
         h2-window-update-overflow-fix-option-breaks-connect - the option
         meant to work around that turned out to break TLS connect()
         entirely, so this sidesteps h2 instead of trying to fix it up). */
      alpn: 'http/1.1',
    });

    // Registered synchronously, right after connect() resolves - no
    // `await` in between - see OllamaClient#post's identical comment for
    // why that ordering matters.
    const resp = await this.#awaitResponse(req, wsi);

    // See OllamaClient#post's identical comment: `.status`, not `.ok`.
    if(resp.status < 200 || resp.status >= 300) throw new Error(`OpenAI HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);

    return resp;
  }

  /** Same backstop as OllamaClient#awaitResponse - see its own doc comment. */
  #awaitResponse(req, wsi) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#take(req);
        wsi?.close();
        reject(new Error(`OpenAI: no response after ${(this.#timeoutMs / 1000).toFixed(0)}s - connection appears dead, aborting`));
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
        reject(new Error(`OpenAI: stream stalled - no data for ${(this.#timeoutMs / 1000).toFixed(0)}s, aborting`));
      }, this.#timeoutMs);
    });

    return Promise.race([reader.read(), timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * POSTs one non-streaming `chat/completions` request. `messages`/`options`
   * follow this project's shared message/tool-use format - see API.md.
   * `toolChoice` ('auto'|'any'|'none') is passed straight through as the
   * OpenAI-style `tool_choice` - unlike Gemini, no per-mode reshaping
   * needed.
   *
   * @returns {Promise<{content: string, toolCalls?: object[]}>}
   */
  async chat(messages, { tools, toolChoice, ...options } = {}) {
    const payload = { ...options, model: this.model, messages: this.#toMessages(messages), stream: false, ...(tools ? { tools: this.#toTools(tools) } : {}), ...(toolChoice ? { tool_choice: toolChoice } : {}) };

    const resp = await this.#post(payload);
    const data = await resp.json();
    this.#lastActivityAt = Date.now();
    this.#debugConsole?.debug('response', data);

    const message = data?.choices?.[0]?.message;
    if(!message) throw new Error(`unexpected OpenAI response: ${JSON.stringify(data)}`);

    const result = this.#toResult(message);
    if(!result.content && !result.toolCalls) throw new Error(`unexpected OpenAI response: ${JSON.stringify(data)}`);

    return result;
  }

  /**
   * Same as chat(), but with `stream: true` - the response arrives as
   * Server-Sent Events, one `data: {...}` JSON chunk per event, terminated
   * by a literal `data: [DONE]` line. Unlike Gemini/Ollama, a tool call's
   * `arguments` string arrives split across several chunks (each delta
   * keyed by `index`, the call's position in the response's `tool_calls`
   * array) rather than whole in one event, so fragments are accumulated
   * per index here and only parsed as JSON once the stream ends.
   *
   * @param {(token: string) => void} onToken called once per text chunk,
   *   in order, as SSE events arrive
   * @returns {Promise<{content: string, toolCalls?: object[]}>}
   */
  async chatStream(messages, { tools, toolChoice, ...options } = {}, onToken) {
    const payload = { ...options, model: this.model, messages: this.#toMessages(messages), stream: true, ...(tools ? { tools: this.#toTools(tools) } : {}), ...(toolChoice ? { tool_choice: toolChoice } : {}) };

    const resp = await this.#post(payload);
    const reader = resp.body.getReader();

    let buf = '';
    let full = '';
    /** index -> { id, name, args } accumulator - `args` is the raw JSON
        string built up across chunks, parsed only once the stream ends. */
    const toolCallsByIndex = new Map();

    for(;;) {
      const { done, value } = await this.#readWithTimeout(reader);

      // See OllamaClient#chatStream's identical toString()/BUGS reference.
      if(!done) buf += toString(value);

      let idx;
      while((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);

        if(!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if(!data || data === '[DONE]') continue;

        const chunk = JSON.parse(data);
        this.#debugConsole?.debug('chunk', chunk);

        const delta = chunk?.choices?.[0]?.delta;
        if(!delta) continue;

        if(delta.content) {
          full += delta.content;
          onToken(delta.content);
        }

        for(const tc of delta.tool_calls ?? []) {
          const entry = toolCallsByIndex.get(tc.index) ?? { id: undefined, name: undefined, args: '' };
          if(tc.id) entry.id = tc.id;
          if(tc.function?.name) entry.name = tc.function.name;
          if(tc.function?.arguments) entry.args += tc.function.arguments;
          toolCallsByIndex.set(tc.index, entry);
        }
      }

      if(done) {
        this.#lastActivityAt = Date.now();
        const toolCalls = [...toolCallsByIndex.entries()].map(([i, { id, name, args }]) => ({ id: id ?? `${name}#${i}`, name, args: args ? JSON.parse(args) : {} }));
        return { content: full, toolCalls: toolCalls.length ? toolCalls : undefined };
      }
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
