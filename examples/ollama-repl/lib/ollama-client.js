/**
 * A tiny, dedicated Ollama `/api/chat` client built directly on the
 * `httpClient` protocol adapter (`lib/lws/protocols.js`) - the same
 * adapter `fetch()` (`lib/fetch.js`) is built on, but with its own
 * `LWSContext`. Each request opens its own fresh HTTP/1.1 connection to
 * the local Ollama server rather than a kept-alive `LCCSCF_PIPELINE`
 * connection reused across turns - libwebsockets never promotes a second
 * h1 client request queued onto an already-idle pipelined connection (see
 * BUGS: h1-late-queued-pipeline-never-promoted), and any real, human-
 * paced pause between REPL turns is enough to land in that broken path,
 * so reconnecting per turn is the only reliable option until that's
 * fixed upstream.
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
 *
 * `messages`/`options`/return value follow this project's shared message
 * and tool-use format (documented in `../API.md`) - `#toMessages()`/
 * `#toTools()`/`#toResult()` convert it natively into Ollama's own
 * `messages`/`tools`/`message.tool_calls` wire shape and back.
 */
import createContext from '../../../lib/lws/context.js';
import { httpClient } from '../../../lib/lws/protocols.js';
import { toString } from 'lws.so';
import { RequestLogger } from '../../../lib/logger.js';

/* lws's own default (15s, see wsi-timeout.c/context.c) for how long a
   client connection may sit waiting on e.g. the server's reply before lws
   gives up on it and reports "Timed out waiting server reply" - too short
   for Ollama, which can easily take well over a minute to cold-load a
   multi-GB model into memory before it can answer the first /api/chat
   call, and longer still for a large model, a long prompt, or a slow/
   CPU-only box. Overridable via `timeoutSecs` for tests/tuning. */
const DEFAULT_TIMEOUT_SECS = 15 * 60;

/* Every request payload and raw response, appended here when debug mode
   is on (`-x`/`--debug`, repl.js, or the `DEBUG` env var - either enables
   it). See lib/logger.js's own doc comment. */
const DEBUG_LOG_PATH = scriptArgs[0] + '.log';

export class OllamaClient {
  #ctx;
  #adapter;
  /** req (the Request from #adapter.connect()) -> the {resolve, reject} of
      the promise #post() is currently awaiting for it - a plain Map, not
      a WeakMap, so a connection-level failure that lws can't attribute to
      any particular req (see #reject() below) can still walk every
      outstanding one instead of silently going nowhere. */
  #settled = new Map();
  #logger;
  #timeoutSecs;

  /**
   * @param {object} opts
   * @param {string} [opts.host]  Ollama server hostname
   * @param {number} [opts.port]  Ollama server port
   * @param {string} opts.model   model name, e.g. "qwen2.5-coder"
   * @param {number} [opts.timeoutSecs] how long a request may wait before
   *   lws gives up on it (see DEFAULT_TIMEOUT_SECS above)
   * @param {boolean} [opts.debug] log every request/response to
   *   DEBUG_LOG_PATH (also turned on by the `DEBUG` env var, regardless
   *   of this flag)
   */
  #timeoutMs;

  constructor({ host = 'localhost', port = 11434, model, timeoutSecs = DEFAULT_TIMEOUT_SECS, debug = false } = {}) {
    this.host = host;
    this.port = port;
    this.model = model;
    this.#timeoutMs = timeoutSecs * 1000;
    this.#timeoutSecs = timeoutSecs;

    this.#logger = new RequestLogger(DEBUG_LOG_PATH, debug);

    this.#adapter = httpClient((req, resp) => this.#take(req)?.resolve(resp), { error: (req, err) => this.#reject(req, err) });

    this.#ctx = this.#newContext();
  }

  /** Builds a fresh `LWSContext` bound to `#adapter`. */
  #newContext() {
    return createContext({ protocols: [{ name: 'http', ...this.#adapter }], timeoutSecs: this.#timeoutSecs });
  }

  #take(req) {
    const record = this.#settled.get(req);
    this.#settled.delete(req);
    return record;
  }

  /**
   * Rejects the pending post() promise for `req` with a clear reason - or,
   * if lws couldn't attribute the failure to any particular req (a
   * connection-level error, e.g. the peer resetting the connection, can
   * fire before the request that would have matched it ever finished
   * registering - see #post() below), every still-outstanding one, so a
   * failure is never silently dropped and a turn never hangs forever
   * waiting on a callback that already happened.
   */
  #reject(req, err) {
    const reason = new Error(`Ollama connection failed: ${err.message}`);

    if(req) {
      this.#take(req)?.reject(reason);
      return;
    }

    for(const { reject } of this.#settled.values()) reject(reason);
    this.#settled.clear();
  }

  /** Shared connect+await-response half of chat()/chatStream() below. */
  async #post(payload) {
    const url = `http://${this.host}:${this.port}/api/chat`;
    const headers = { 'content-type': 'application/json' };

    this.#logger.request('POST', url, headers);
    this.#logger.body(payload);

    const { req, wsi } = await this.#adapter.connect(this.#ctx, url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    // Registered synchronously, right after connect() resolves - no
    // `await` in between - so no native callback can fire in the gap and
    // find nothing here to reject/resolve yet.
    const resp = await this.#awaitResponse(req, wsi);

    this.#logger.response(resp.status, resp.statusText, resp.headers);

    /* Not `resp.ok`: Response's `.ok` is computed once at construction
       time (lib/lws/response.js), before HttpClientProtocol patches in
       the real status on establishment (see onEstablishedClientHttp,
       lib/lws/protocols.js) - it's always true regardless of the actual
       response code. Check `.status` directly instead. */
    if(resp.status < 200 || resp.status >= 300) {
      const headers = {};
      resp.headers?.forEach((v, k) => headers[k] = v);
      const body = await resp.text().catch(() => '');
      throw new Error(`Ollama HTTP ${resp.status}\nheaders: ${JSON.stringify(headers, null, 2)}\nbody: ${body}`);
    }

    return resp;
  }

  /**
   * Awaits the pending response for `req`, backstopped by `this.#timeoutMs`
   * (mirrors the `timeoutSecs` already given to `this.#ctx`) - not because
   * lws's own per-connection timeout (wsi-timeout.c) shouldn't already
   * catch a dead connection, but because the REPL's "Thinking..." spinner
   * has no way out of its own if that native timer ever fails to fire (a
   * missed re-arm, a callback lws never dispatches, a stalled write on the
   * *request* side never completing so the "waiting for reply" clock never
   * even starts, ...) - relying on a single layer's bookkeeping being
   * correct, with an unbounded UI hang as the failure mode, isn't good
   * enough here. On firing, this closes `wsi` itself (rather than trusting
   * a hung connection to notice and clean up on its own) so a wedged
   * socket isn't left around for the next request to try to reuse.
   */
  #awaitResponse(req, wsi) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#take(req);
        wsi?.close();
        reject(new Error(`Ollama: no response after ${(this.#timeoutMs / 1000).toFixed(0)}s - connection appears dead, aborting`));
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

  /**
   * Cancels whatever request is currently awaiting a response (see
   * #awaitResponse above) - closes its connection and rejects its pending
   * promise, same as that method's own timeout path, just triggered by the
   * caller (the REPL's Ctrl-C handler, see lib/chat-repl.js) instead of a
   * timer. A no-op, returning false, when nothing is actually pending (e.g.
   * mid-stream, past the initial #awaitResponse wait - see chatStream()'s
   * own per-chunk #readWithTimeout, which this doesn't reach into).
   * @returns {boolean} whether a pending request was actually aborted
   */
  abort() {
    if(!this.#settled.size) return false;

    for(const { reject, wsi } of this.#settled.values()) {
      wsi?.close();
      reject(new Error('aborted (Ctrl-C)'));
    }

    this.#settled.clear();
    return true;
  }

  /**
   * Converts this project's shared message format (see API.md) into
   * Ollama's own `messages` shape: a `tool` message's `content` is
   * stringified if it isn't already a string (Ollama wants a plain string
   * there, unlike Gemini's object-shaped `functionResponse.response`), and
   * an assistant message's `toolCalls` becomes `tool_calls: [{ function:
   * { name, arguments } }]` - Ollama's own field name is `arguments`, not
   * this project's `args`.
   */
  #toMessages(messages) {
    return messages.map(({ role, content, toolCalls, name }) => {
      if(role === 'tool') return { role, content: typeof content === 'string' ? content : JSON.stringify(content), tool_name: name };
      if(toolCalls?.length) return { role, content: content ?? '', tool_calls: toolCalls.map(tc => ({ function: { name: tc.name, arguments: tc.args } })) };
      return { role, content };
    });
  }

  /** `tools` (see API.md) -> Ollama's `{ type: 'function', function: {...} }` wrapping. */
  #toTools(tools) {
    return tools?.map(({ name, description, parameters }) => ({ type: 'function', function: { name, description, parameters } }));
  }

  /**
   * Pulls `{ content, toolCalls }` (see API.md) out of one Ollama
   * `message` object - shared between chat()'s single response and
   * chatStream()'s per-chunk `message`. `id` is synthesized here
   * (`name#index`); Ollama's own `tool_calls` entries don't carry one.
   */
  #toResult(message, toolCallOffset = 0) {
    const toolCalls = message?.tool_calls?.map((tc, i) => ({ id: `${tc.function.name}#${toolCallOffset + i}`, name: tc.function.name, args: tc.function.arguments ?? {} }));
    return { content: message?.content ?? '', toolCalls: toolCalls?.length ? toolCalls : undefined };
  }

  /**
   * POSTs one non-streaming `/api/chat` request over the kept-alive
   * connection. `messages`/`options` follow this project's shared
   * message/tool-use format - see API.md. `toolChoice` is accepted but
   * silently ignored: Ollama's `/api/chat` has no forced-call knob, it
   * always behaves like Gemini's `AUTO` mode.
   *
   * @returns {Promise<{content: string, toolCalls?: object[]}>}
   */
  async chat(messages, { think = false, tools, toolChoice, ...options } = {}) {
    const payload = { ...options, model: this.model, messages: this.#toMessages(messages), stream: false, think, ...(tools ? { tools: this.#toTools(tools) } : {}) };

    const resp = await this.#post(payload);
    const data = await resp.json();
    this.#logger.body(data);

    if(!data?.message) throw new Error(`unexpected Ollama response: ${JSON.stringify(data)}`);

    const result = this.#toResult(data.message);
    if(!result.content && !result.toolCalls) throw new Error(`unexpected Ollama response: ${JSON.stringify(data)}`);

    return result;
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
   *   can (and often does) contain a partial line or several complete
   *   ones. Never fires for a `tool_calls` chunk - see API.md, those
   *   arrive whole rather than token-by-token, and only show up in the
   *   returned object.
   * @returns {Promise<{content: string, toolCalls?: object[]}>}
   */
  async chatStream(messages, { think = false, tools, toolChoice, ...options } = {}, onToken) {
    const payload = { ...options, model: this.model, messages: this.#toMessages(messages), stream: true, think, ...(tools ? { tools: this.#toTools(tools) } : {}) };

    const resp = await this.#post(payload);
    const reader = resp.body.getReader();

    let buf = '';
    let full = '';
    const toolCalls = [];

    for(;;) {
      const { done, value } = await this.#readWithTimeout(reader);

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
        this.#logger.body(chunk);

        const { content: token, toolCalls: chunkCalls } = this.#toResult(chunk.message, toolCalls.length);
        for(const tc of chunkCalls ?? []) toolCalls.push(tc);

        if(token) {
          full += token;
          onToken(token);
        }

        if(chunk.done) {
          // Ollama's own payload-level "done" can arrive before the HTTP
          // response stream itself is fully drained (e.g. a trailing
          // chunked-encoding terminator still in flight) - returning
          // without cancelling left the reader's lock on the underlying
          // stream (lib/lws/protocols.js's per-connection `session.stream`)
          // unreleased, since only draining to the stream's own `done` or
          // cancelling releases it (see ReadableStreamAsyncIteratorImpl in
          // lib/lws/streams.js). Same cleanup #readWithTimeout's timeout
          // path already does below.
          await reader.cancel().catch(() => {});
          return { content: full, toolCalls: toolCalls.length ? toolCalls : undefined };
        }
      }

      /* Reaching here means the underlying HTTP stream itself ended
         (CLOSED_CLIENT_HTTP/COMPLETED_CLIENT_HTTP, lib/lws/protocols.js)
         without ever seeing Ollama's own payload-level "done" line above -
         a well-behaved response always sends that line before closing, so
         this is a genuine premature close (dropped connection, server
         crash, ...), not a valid empty/short reply. Surface it as an error
         rather than silently returning whatever partial content arrived -
         see chatRound()/repl.js's error-flow for how the "Thinking..."
         spinner stops and this gets shown to the user. */
      if(done) throw new Error('Ollama: connection closed before the response finished');
    }
  }

  /**
   * Same backstop as #awaitResponse() above, but per network chunk once
   * streaming has actually started: `this.#ctx`'s `timeoutSecs` (and
   * #awaitResponse()'s own timer) only guard the initial wait for a
   * reply to *begin* - once headers/the first bytes arrive, lws considers
   * the request "established" and nothing native times out a stream that
   * then goes silent mid-response. Cancelling `reader` on timeout runs
   * the stream's cancel algorithm (see the `httpClient()` response body's
   * `cancel()`, lib/lws/protocols.js), which closes the underlying `wsi`.
   */
  #readWithTimeout(reader) {
    let timer;

    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reader.cancel().catch(() => {});
        reject(new Error(`Ollama: stream stalled - no data for ${(this.#timeoutMs / 1000).toFixed(0)}s, aborting`));
      }, this.#timeoutMs);
    });

    return Promise.race([reader.read(), timeout]).finally(() => clearTimeout(timer));
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
