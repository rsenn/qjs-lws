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
 *
 * Each request opens its own fresh connection rather than a kept-alive
 * `LCCSCF_PIPELINE` connection reused across turns - see OllamaClient's
 * own doc comment (BUGS: h1-late-queued-pipeline-never-promoted) for why.
 */
import createContext from 'lws/context.js';
import { httpClient } from 'lws/protocols.js';
import { LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX, LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT, LWS_SERVER_OPTION_IGNORE_MISSING_CERT, toString } from 'lws.so';
import { RequestLogger } from 'logger.js';
import { getenv } from 'std';

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_API_PATH = '/chat/completions';

/* Same rationale as OllamaClient's own DEFAULT_TIMEOUT_SECS: lws's 15s
   built-in default (see wsi-timeout.c/context.c) is too short for a slow
   response. Overridable via `timeoutSecs` for tests/tuning. */
const DEFAULT_TIMEOUT_SECS = 15 * 60;

/* Mirrors OllamaClient's own debug log (see its DEBUG_LOG_PATH comment)
   but kept in a separate file so the clients' logs don't interleave.
   See lib/logger.js's own doc comment. */
const DEBUG_LOG_PATH = 'openai-repl-debug.log';

/**
 * A non-2xx answer from the endpoint. `message` keeps the full dump
 * (status, headers, body) for the log; the parsed fields are for callers
 * that react to a kind of failure (e.g. failing over from a model whose
 * quota is used up).
 *
 * @property {number} status       HTTP status
 * @property {string} [code]       OpenAI `error.code` (rate_limit_exceeded, login_required, ...)
 * @property {string} [type]       OpenAI `error.type`
 * @property {number} [retryAfter] seconds, from the Retry-After header
 * @property {string} [detail]     OpenAI `error.message`, the short human text
 */
export class OpenAIError extends Error {
  constructor(status, headers, body) {
    let err;
    try {
      err = JSON.parse(body)?.error;
    } catch(e) {}

    /* one line: the full header block and body stay on .headers / .body for verbose mode */
    super(`OpenAI HTTP ${status}: ${String(err?.message ?? body ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) || 'no message'}`);
    this.name = 'OpenAIError';
    this.status = status;
    this.headers = headers;
    this.body = body;

    this.code = err?.code ?? undefined;
    this.type = err?.type ?? undefined;
    this.detail = err?.message;
    const ra = Number(headers['retry-after']);
    if(ra > 0) this.retryAfter = ra;
  }

  /** the quota or rate limit of the model is used up */
  get isRateLimit() {
    return this.status === 429 || this.code === 'rate_limit_exceeded' || this.code === 'insufficient_quota';
  }
}

/* first value of a header, percent-decoded (freellmapi encodes non-ASCII model ids) */
function header(resp, name) {
  const v = resp.headers?.get?.(name);
  if(v == null || v === '') return undefined;

  try {
    return decodeURIComponent(v);
  } catch(e) {
    return v;
  }
}

/**
 * usage block of a response, OpenAI shape -> this project's token record
 *
 *   { prompt_tokens: 15, completion_tokens: 44, completion_tokens_details: { reasoning_tokens: 38 } }
 *   -> { prompt: 15, completion: 44, total: 59, reasoning: 38, cached: undefined, cost: undefined }
 */
export function parseUsage(u) {
  if(!u) return undefined;

  const prompt = u.prompt_tokens ?? u.input_tokens;
  const completion = u.completion_tokens ?? u.output_tokens;

  return {
    prompt,
    completion,
    total: u.total_tokens ?? (prompt ?? 0) + (completion ?? 0),
    reasoning: u.completion_tokens_details?.reasoning_tokens || undefined,
    cached: u.prompt_tokens_details?.cached_tokens || undefined,
    cacheWrite: u.prompt_tokens_details?.cache_write_tokens || undefined,
    cost: u.cost || undefined,
  };
}

/* security headers every helmet-based server sends, no news about the request */
const BORING_HEADERS = new Set(['x-content-type-options', 'x-dns-prefetch-control', 'x-download-options', 'x-frame-options', 'x-permitted-cross-domain-policies', 'x-xss-protection', 'x-powered-by']);

/**
 * Per-request facts: what was asked, where a gateway routed it, what it
 * cost. Filled from the response headers, then from the body.
 *
 *   requested    model name sent (auto, auto:fast, a model id)
 *   model        model that answered (body model, else the routed one)
 *   provider     upstream host the gateway or OpenRouter names (body provider)
 *   routedVia    freellmapi X-Routed-Via, platform/model
 *   platform     first part of routedVia (kilo, groq, google, ...)
 *   requestId    X-Request-ID, the same as the body's execution_id
 *   fallbacks    X-Fallback-Attempts, hops that failed before this one
 *   trail        X-Fallback-Trail, why each hop failed
 *   detail       X-Fallback-Detail, timings per hop (opt-in on the gateway)
 *   compress     X-FreeLLM-Compress, mode and estimated tokens saved
 *   cache        X-FreeLLM-Cache, on/off/hit
 *   rateLimit    { limit, remaining, reset } from X-RateLimit-*
 *   usage        parseUsage() record
 *   finish       finish_reason
 *   ttfbMs       time until the response headers arrived
 *   firstTokenMs time until the first streamed text (streams only)
 *   ms           time until the reply was complete
 *   stream       whether it was streamed
 *   status       HTTP status, error the error message for a failed call
 *   headers      every x-* response header (gateway and upstream facts)
 *   usageRaw     the usage object as sent (cost_details, is_byok, ...)
 *   genId        upstream generation id, fingerprint, serviceTier,
 *                nativeFinish: other body fields when present
 *   reasoning    reasoning text, when the model sent it
 */
export class OpenAIClient {
  #apiKey;

  /** extra request headers for chat requests, e.g. { 'x-session-id': ... } for a gateway's sticky routing */
  extraHeaders = {};
  #baseUrl;
  #apiPath;
  #ctx;
  #adapter;
  /** Same req -> {resolve, reject} bookkeeping as OllamaClient#settled -
      see its own doc comment for why this is a plain Map, not a WeakMap. */
  #settled = new Map();
  #logger;
  #timeoutMs;
  #timeoutSecs;
  #streamUsage;

  /** metadata of the last request (see the record above OpenAIClient), null before the first */
  lastMeta = null;

  /** called with each request's metadata once it is complete or failed */
  onMeta = null;

  /**
   * called as a request moves on: (phase, meta)
   *
   *   sending    the request goes out, meta.bytesOut
   *   waiting    it is out, the model works, no headers yet
   *   headers    a stream's headers are in, the first token is due
   *   receiving  the body of a reply that does not stream, meta.bytesIn
   *   reasoning  reasoning text streams in
   *   streaming  reply text streams in, meta.chunks, meta.bytesIn
   *   tool-call  a tool call streams in
   *   idle       done or failed
   */
  onPhase = null;

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
   * @param {boolean} [opts.streamUsage] ask for a final usage chunk on
   *   streams (stream_options.include_usage, default true)
   */
  constructor({ apiKey, apiKeyEnv = 'OPENAI_API_KEY', baseUrl, apiPath = DEFAULT_API_PATH, model = DEFAULT_MODEL, timeoutSecs = DEFAULT_TIMEOUT_SECS, debug = false, streamUsage = true } = {}) {
    const resolvedKey = apiKey ?? getenv(apiKeyEnv);
    if(!resolvedKey) throw new Error(`OpenAIClient: no API key (pass opts.apiKey or set ${apiKeyEnv})`);

    this.#apiKey = resolvedKey;
    this.#baseUrl = (baseUrl ?? getenv('OPENAI_API_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#apiPath = apiPath;
    this.model = model;
    this.#timeoutMs = timeoutSecs * 1000;
    this.#timeoutSecs = timeoutSecs;
    this.#streamUsage = streamUsage;

    this.#logger = new RequestLogger(DEBUG_LOG_PATH, debug);

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
      timeoutSecs: this.#timeoutSecs,
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
    const reasoning = message?.reasoning ?? message?.reasoning_content;
    return { content: message?.content ?? '', toolCalls: toolCalls?.length ? toolCalls : undefined, ...(reasoning ? { reasoning } : {}) };
  }

  /* header half of a request's metadata */
  #headerMeta(meta, resp) {
    const routedVia = header(resp, 'x-routed-via');
    const limit = header(resp, 'x-ratelimit-limit');

    Object.assign(meta, {
      status: resp.status,
      ttfbMs: Date.now() - meta.t0,
      requestId: header(resp, 'x-request-id'),
      routedVia,
      platform: routedVia?.split('/')[0],
      fallbacks: +(header(resp, 'x-fallback-attempts') ?? 0),
      trail: header(resp, 'x-fallback-trail'),
      detail: header(resp, 'x-fallback-detail'),
      compress: header(resp, 'x-freellm-compress'),
      cache: header(resp, 'x-freellm-cache'),
      rateLimit: limit ? { limit: +limit, remaining: +header(resp, 'x-ratelimit-remaining'), reset: +header(resp, 'x-ratelimit-reset') } : undefined,
      headers: {},
    });

    resp.headers?.forEach((v, k) => {
      k = k.toLowerCase();
      if(k.startsWith('x-') && !BORING_HEADERS.has(k)) meta.headers[k] = v;
    });
  }

  /* body half: one response object or stream chunk */
  #bodyMeta(meta, data) {
    if(data?.model) meta.model = data.model;
    if(data?.provider) meta.provider = data.provider;
    if(data?.execution_id) meta.requestId ??= data.execution_id;
    if(data?.usage) {
      meta.usage = parseUsage(data.usage);
      meta.usageRaw = data.usage;
    }
    if(data?.id) meta.genId = data.id;
    if(data?.system_fingerprint) meta.fingerprint = data.system_fingerprint;
    if(data?.service_tier) meta.serviceTier = data.service_tier;
    const choice = data?.choices?.[0];
    if(choice?.finish_reason) meta.finish = choice.finish_reason;
    if(choice?.native_finish_reason) meta.nativeFinish = choice.native_finish_reason;
  }

  #finishMeta(meta, err) {
    meta.ms = Date.now() - meta.t0;
    this.onPhase?.('idle', meta);
    meta.model ??= meta.routedVia?.slice((meta.platform?.length ?? -1) + 1) || meta.requested;
    if(err) meta.error = err.detail ?? err.message?.split('\n')[0];
    delete meta.t0;
    this.lastMeta = meta;
    this.onMeta?.(meta);
    return meta;
  }

  /** Shared connect+await-response half of chat()/chatStream() below. */
  async #post(payload, meta) {
    const url = `${this.#baseUrl}${this.#apiPath}`;
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${this.#apiKey}`, ...this.extraHeaders };

    this.#logger.request('POST', url, headers);
    this.#logger.body(payload);

    const body = JSON.stringify(payload);
    if(meta) {
      meta.bytesOut = body.length;
      meta.bytesIn = 0;
      meta.chunks = 0;
      this.onPhase?.('sending', meta);
    }

    const { req, wsi } = await this.#adapter.connect(this.#ctx, url, {
      method: 'POST',
      headers,
      body,
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
    const response = this.#awaitResponse(req, wsi);
    if(meta) this.onPhase?.('waiting', meta);
    const resp = await response;

    this.#logger.response(resp.status, resp.statusText, resp.headers);

    if(meta) {
      this.#headerMeta(meta, resp);
      this.onPhase?.(meta.stream ? 'headers' : 'receiving', meta);
    }

    // See OllamaClient#post's identical comment: `.status`, not `.ok`.
    if(resp.status < 200 || resp.status >= 300) {
      const headers = {};
      resp.headers?.forEach((v, k) => headers[k] = v);
      const body = await resp.text().catch(() => '');
      throw new OpenAIError(resp.status, headers, body);
    }

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

    /* reject before close: closing reports the drop through #reject() first otherwise */
    for(const { reject, wsi } of this.#settled.values()) {
      reject(new Error('interrupted'));
      wsi?.close();
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
   * @returns {Promise<{content: string, toolCalls?: object[], meta: object}>}
   */
  async chat(messages, { tools, toolChoice, onReasoning, ...options } = {}) {
    const payload = { ...options, model: this.model, messages: this.#toMessages(messages), stream: false, ...(tools ? { tools: this.#toTools(tools) } : {}), ...(toolChoice ? { tool_choice: toolChoice } : {}) };

    const meta = { requested: this.model, stream: false, t0: Date.now() };

    try {
      const resp = await this.#post(payload, meta);
      const text = await resp.text();
      meta.bytesIn = text.length;
      const data = JSON.parse(text);
      this.#logger.body(data);
      this.#bodyMeta(meta, data);

      const message = data?.choices?.[0]?.message;
      if(!message) throw new Error(`unexpected OpenAI response: ${JSON.stringify(data)}`);

      const result = this.#toResult(message);
      if(!result.content && !result.toolCalls) throw new Error(`unexpected OpenAI response: ${JSON.stringify(data)}`);

      if(result.reasoning) meta.reasoning = result.reasoning;
      result.meta = this.#finishMeta(meta);
      return result;
    } catch(e) {
      this.#finishMeta(meta, e);
      throw e;
    }
  }

  /**
   * GET {base}{path} and parse the JSON answer - for endpoints next to the
   * chat one, such as a gateway's /usage or /providers.
   *
   *   await client.getJSON('/usage')   // { month, requests, tokens, byPlatform, ... }
   *
   * Throws OpenAIError on a non-2xx status.
   */
  getJSON(path) {
    return this.fetchJSON(`${this.#baseUrl}${path}`);
  }

  /**
   * any JSON request on this client's connection context - for a
   * gateway's admin API next to /v1
   *
   *   await client.fetchJSON('http://localhost:3001/api/auth/login', { method: 'POST', body: { email, password } })
   *
   * opts.token replaces the API key as bearer token. Throws OpenAIError on
   * a non-2xx status.
   */
  async fetchJSON(url, { method = 'GET', body, token } = {}) {
    const headers = { authorization: `Bearer ${token ?? this.#apiKey}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) };

    this.#logger.request(method, url, headers);

    const { req, wsi } = await this.#adapter.connect(this.#ctx, url, { method, headers, alpn: 'http/1.1', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const resp = await this.#awaitResponse(req, wsi);
    const text = await resp.text().catch(() => '');

    if(resp.status < 200 || resp.status >= 300) throw new OpenAIError(resp.status, {}, text);

    const data = JSON.parse(text);
    this.#logger.body(data);
    return data;
  }

  /**
   * GET {base}/models - the models the endpoint offers. A chat-bridge
   * (examples/chat-bridge) adds `available` (false while a site is rate
   * limited or logged out) and `resets_at`; plain servers leave them out.
   *
   * @returns {Promise<{name: string, displayName: string, available: boolean, resetsAt?: string, ownedBy?: string}[]>}
   */
  /** the endpoint's base URL, e.g. http://127.0.0.1:8089/v1 */
  get baseUrl() {
    return this.#baseUrl;
  }

  async listModels() {
    const url = `${this.#baseUrl}${this.#apiPath.replace(/\/chat\/completions$/, '')}/models`;
    const headers = { authorization: `Bearer ${this.#apiKey}` };

    this.#logger.request('GET', url, headers);

    const { req, wsi } = await this.#adapter.connect(this.#ctx, url, { method: 'GET', headers, alpn: 'http/1.1' });
    const resp = await this.#awaitResponse(req, wsi);
    const body = await resp.text().catch(() => '');

    if(resp.status < 200 || resp.status >= 300) throw new OpenAIError(resp.status, {}, body);

    return (JSON.parse(body).data ?? []).map(m => ({
      name: m.id,
      displayName: [m.owned_by, m.available === false ? `unavailable (${m.unavailable ?? 'refused'}${m.resets_at ? ` until ${m.resets_at}` : ''})` : ''].filter(Boolean).join(' '),
      available: m.available !== false,
      resetsAt: m.resets_at,
      ownedBy: m.owned_by,
      contextWindow: m.context_window ?? m.context_length,
      status: m.execution_status,
      tools: Array.isArray(m.supported_parameters) ? m.supported_parameters.includes('tools') : undefined,
    }));
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
   * options.onReasoning(text) gets reasoning chunks (delta.reasoning or
   * reasoning_content) as they arrive, they are not part of the content.
   *
   * @param {(token: string) => void} onToken called once per text chunk,
   *   in order, as SSE events arrive
   * @returns {Promise<{content: string, toolCalls?: object[], meta: object}>}
   */
  async chatStream(messages, { tools, toolChoice, onReasoning, ...options } = {}, onToken) {
    const payload = { ...options, model: this.model, messages: this.#toMessages(messages), stream: true, ...(this.#streamUsage ? { stream_options: { include_usage: true } } : {}), ...(tools ? { tools: this.#toTools(tools) } : {}), ...(toolChoice ? { tool_choice: toolChoice } : {}) };
    const meta = { requested: this.model, stream: true, t0: Date.now() };

    try {
      const result = await this.#readStream(await this.#post(payload, meta), meta, onToken, onReasoning);
      result.meta = this.#finishMeta(meta);
      return result;
    } catch(e) {
      this.#finishMeta(meta, e);
      throw e;
    }
  }

  async #readStream(resp, meta, onToken, onReasoning) {
    const reader = resp.body.getReader();

    let buf = '';
    let full = '';
    /** index -> { id, name, args } accumulator - `args` is the raw JSON
        string built up across chunks, parsed only once the stream ends. */
    const toolCallsByIndex = new Map();
    let sawDone = false;

    for(;;) {
      const { done, value } = await this.#readWithTimeout(reader);

      // See OllamaClient#chatStream's identical toString()/BUGS reference.
      if(!done) {
        buf += toString(value);
        meta.bytesIn += value.byteLength ?? value.length ?? 0;
      }

      let idx;
      while((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);

        if(!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if(!data) continue;
        if(data === '[DONE]') {
          sawDone = true;
          continue;
        }

        const chunk = JSON.parse(data);
        this.#logger.body(chunk);
        this.#bodyMeta(meta, chunk);

        const delta = chunk?.choices?.[0]?.delta;
        if(!delta) continue;

        const thought = delta.reasoning ?? delta.reasoning_content;
        if(thought) {
          if(!meta.reasoning) this.onPhase?.('reasoning', meta);
          meta.chunks++;
          meta.reasoning = (meta.reasoning ?? '') + thought;
          onReasoning?.(thought);
        }

        if(delta.content) {
          if(meta.firstTokenMs == null) this.onPhase?.('streaming', meta);
          meta.chunks++;
          meta.firstTokenMs ??= Date.now() - meta.t0;
          full += delta.content;
          onToken(delta.content);
        }

        for(const tc of delta.tool_calls ?? []) {
          if(!toolCallsByIndex.size) this.onPhase?.('tool-call', meta);
          meta.chunks++;
          const entry = toolCallsByIndex.get(tc.index) ?? { id: undefined, name: undefined, args: '' };
          if(tc.id) entry.id = tc.id;
          if(tc.function?.name) entry.name = tc.function.name;
          if(tc.function?.arguments) entry.args += tc.function.arguments;
          toolCallsByIndex.set(tc.index, entry);
        }
      }

      if(done) {
        // See OllamaClient#chatStream's identical reasoning: reaching the
        // end of the HTTP stream without ever seeing the `data: [DONE]`
        // sentinel means the connection closed before the response
        // actually finished - surface that instead of returning a
        // silently-truncated reply.
        if(!sawDone) throw new Error('OpenAI: connection closed before the response finished');
        const toolCalls = [...toolCallsByIndex.entries()].map(([i, { id, name, args }]) => ({ id: id ?? `${name}#${i}`, name, args: args ? JSON.parse(args) : {} }));
        return { content: full, toolCalls: toolCalls.length ? toolCalls : undefined };
      }
    }
  }

  /* Idempotent - see BUGS: repl-controlc-double-invokes-cleanup-handlers.
     A double Ctrl-C in the REPL (lib/chat-repl.js's base class) runs every
     registered cleanup handler, including this one via destroy(), twice;
     #logger.close() has its own matching guard, see lib/logger.js. */
  #destroyed = false;

  destroy() {
    if(this.#destroyed) return;
    this.#destroyed = true;

    this.#ctx.destroy();
    this.#logger.close();
  }
}
