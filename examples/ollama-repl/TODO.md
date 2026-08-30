# TODO

## Assessment (2026-08-04, updated 2026-08-30)

`repl.js`'s tool loop was rewritten (2026-08-30) to drive real provider-
native tool-calling (`tools`/`toolCalls` - see `API.md`) instead of a
plain-text `LIST:`/`READ:`/`RUN:` protocol parsed out of the reply body -
`TOOLS`/`executeTool()` (`lib/tool-requests.js`): `list_directory`,
`read_file`, `run_command` (a real shell script via `shish -c`, falling
back to `/bin/sh -c` if `shish` isn't installed - multi-line, heredocs,
`find`/`xargs`, not just one command line), and the previously-missing
`ask_user` (item 1 below - done). Verified live against a real OpenAI-
compatible endpoint (`qwen3.8-flash`/`qwen3-coder-flash`): a
`list_directory` round-trip, and a `run_command` round-trip where the
model wrote and ran its own heredoc-based shell test script unprompted,
guided only by the tool's own description text - see `API.md`'s "what's
out of scope" section, now updated.

**Not yet done / still open:**

- **Not verified against the actual target model (`qwen2.5-coder` via a
  local Ollama server)** - this environment's Ollama install has been
  fighting system-level problems all session (a failed `snap install
  ollama`, a working `curl -fsSL https://ollama.com/install.sh | sh`
  install left `/usr/local/bin/ollama` at mode `700 root:root` - unreadable
  by a normal user, and the `ollama.service` unit stuck restart-looping on
  `Permission denied`/`status=203/EXEC` for the same reason - and running
  the binary as root via `sudo` segfaults immediately even on `--version`,
  which smells like leftover AppArmor confinement from the earlier failed
  snap install (`snap.ollama.*` profiles visible in `dmesg`) colliding with
  the native binary of the same name). Not resolved this session - next
  session should retry `ollama list`/`ollama pull qwen2.5-coder` once
  that's sorted, then actually run the two PoC coding tasks below through
  `--provider ollama --model qwen2.5-coder` and read the resulting
  `qwen2.5-coder.log` conversation transcript to see how the real target
  model behaves (all live verification so far used an OpenAI-compatible
  proxy with a different model family, as a stand-in).
- **Two PoC coding tasks, chosen as the harness's actual bar to clear**
  (per direct instruction): (1) write a small JS class using only
  QuickJS's own `std`/`os` modules (a first attempt was started this
  session against `qwen3-coder-flash` - a `RingBuffer` class writing to a
  file via `std.open()` - but the session was interrupted before
  completion, see the note below); (2) write a small C library routine
  against `quickjs.h` - e.g. a class with a couple of "exotic" methods
  (something beyond a trivial getter/setter, closer to the fib.c/point.c
  reference shape). Both should go through the *real* interactive
  `repl.js` harness (not a bypassed direct-client script), and the
  resulting `<model>.log` should be read back afterward to find concrete,
  specific things to fix in the system prompt/tool loop - not just "it
  didn't work," but *what specifically* the model got wrong or guessed at
  instead of checking.
- **Unconfirmed oddity, not yet root-caused**: the interrupted PoC run
  above (piped `<prompt>\n/exit\n` into `qjsm repl.js`, non-interactively)
  hit a 90s timeout without ever finishing, after the model had already
  made one `run_command` tool call that hit `ChatREPL#confirm()`'s y/n
  gate. Plausible innocent explanation: the piped `/exit` line doesn't
  match `confirm()`'s `/^y(es)?$/i` check, so the command is declined and
  the tool loop correctly continues to a second live network round - which
  on a slow/loaded API can easily exceed a 90s wrapper timeout on its own,
  with no actual hang involved. But this wasn't confirmed either way before
  the session ended - worth deliberately re-testing piped, non-interactive
  input against a `confirm()`/`ask()` prompt specifically (not just as a
  side effect of a PoC run) before trusting non-interactive testing of this
  harness in general.

## 1. Add an ASK: request type (user feedback loop) - done (2026-08-30)

Implemented as the `ask_user` tool (`lib/tool-requests.js`'s `TOOLS`), not
a text-prefix request type - part of the same native tool-calling rewrite
as item 3 below. `ChatREPL#ask()` (`lib/chat-repl.js`, mirrors the
existing `#confirm()`) prompts and waits for a typed answer;
`executeTool('ask_user', ...)` returns it as the tool result, fed back the
same way any other tool result is. Counts toward `MAX_TOOL_ROUNDS` like
every other tool call, same as originally planned. Not yet exercised by an
actual live model turning ambiguous scope into a real `ask_user` call
(neither PoC run this session reached one) - worth specifically prompting
for during the next live session (see the "PoC coding tasks" item above).

## 2. Rework the system prompt and context mechanism

Partly addressed: the prompt's QuickJS C API primer and the qjs-modules
built-ins paragraph (the bulk of the "reference material" this item
originally flagged) are gone - replaced with a one-line pointer telling
the model to `READ:`/name-drop `quickjs.h`/`fs.js`/etc. instead of
carrying a paraphrase of them inline. `SYSTEM_PROMPT` went from ~9.6KB to
~2.6KB. `gatherProjectContext()`'s own payload dropped from a full
recursive listing (up to 300 entries) plus every `README*` in the tree to
a shallow top-level-only listing (filtered to `SOURCE_EXT`,
`lib/file-refs.js`, and whatever `.gitignore` excludes) plus just the
root `README.md`/`CMakeLists.txt` - on this project that's roughly an
80KB first-turn payload down to the ~10-35KB range depending on `--root`.

Also since (2026-08-30): the `LIST:`/`READ:`/`RUN:` text-contract
paragraph is gone entirely, replaced by real tool declarations (`TOOLS`,
`lib/tool-requests.js`) sent to the provider natively - the system prompt
now only says *when*/*why* to prefer tools over guessing, not their exact
syntax, since that's carried structurally by the `tools` schema instead.
Also added: explicit guidance to check (via the tools) whether a project
already imports qjs-modules' `process`/`fs`/`util`/`child_process` before
defaulting to QuickJS's own `std`/`os`, and a note that the QuickJS-not-
Node constraint only applies to code meant to run inside qjs/qjsm itself,
not browser-side JS. Unverified: whether this actually changes qwen2.5-
coder's behavior in practice - see the "not yet done" PoC items above.

Still open:
- Consider re-injecting a short reminder of the tool-use rule
  periodically (e.g. appended to each `tool`-role result message in
  `runToolLoop`) rather than relying on it surviving from the system
  prompt alone across a long conversation.
- `gatherProjectContext()`'s scan is now deliberately shallow and fixed at
  startup - good for payload size, but it means work centered on a
  particular subtree (e.g. `lib/lws/`, a single `qjs-*` binding) still
  gets no automatic help beyond the top level, and the scan never
  updates as a session goes on. That's an intentional trade for size
  right now; if it turns out to cost too many extra `LIST:`/`READ:`
  rounds in practice, consider letting the model broaden its own view
  more cheaply instead of widening the automatic scan back out.
- No memory of what's already been read: nothing stops the model from
  re-`READ:`ing the same file every round. A per-session "already shown"
  set (like `SentFiles`/`FileExchange` already track outgoing/written
  files) would let the system prompt say "don't re-request a file you've
  already been shown" truthfully, and would shrink context growth over a
  long session.

## 3. Push the model harder toward using the harness - tool-calling rewrite done (2026-08-30), still needs live pressure-testing

The mechanism changed (native `tools`/`toolCalls` instead of a text
protocol - see the top of this file and `API.md`), but the underlying goal
- get the model to actually *prefer* checking over guessing - still needs
real qwen2.5-coder sessions to confirm it worked, not just that the wiring
is correct. Specific gaps to watch for once live:

- C/QuickJS work: read the actual binding file and `quickjs.h` (via the
  `lib/reference-files.js` name-drop mechanism, or the `read_file` tool)
  before describing or editing JS<->C glue, rather than recalling the API
  from the primer in the system prompt alone.
- Native-module work specifically: now that `nativeModules()` can guess
  which sibling project a compiled `.so` came from, that guess isn't
  surfaced to the model anywhere yet (it's dead code from the model's
  point of view) - either inject it into the system prompt or expose it as
  another tool argument (e.g. resolving a bare `.so` name to its guessed
  project) so the model actually uses it instead of guessing which qjs-*
  project a given native module lives in.
- Anything it's about to write a `File:` block for: `read_file` the target
  file first if it already exists, so the rewrite is grounded in the
  current contents rather than the model's assumption of what's there -
  the system prompt says this now, but it's unverified whether the model
  actually follows it.
- `MAX_TOOL_ROUNDS` is still 4 (now enforced by dropping `tools`/forcing
  `toolChoice: 'none'` on the capping round instead of just discarding a
  still-pending request, see the top of this file) - worth revisiting now
  that `ask_user` is real, heavier tool use, since a real "explore, then
  ask, then read, then answer" sequence can burn through that quickly on a
  non-trivial question, and sibling-project exploration adds more rounds a
  session might need. The "write a native binding" demo (README.md) is a
  concrete case that can plausibly need more than 4: list a sibling
  project, read a template file, read quickjs.h, run the build, run a
  smoke test - that's 5-6 tool calls before a final answer even on a clean
  run, before counting a build failure or a wrong-signature retry. The two
  PoC coding tasks above are a good live test of whether 4 is actually too
  tight in practice.

## 4a. Follow-ups from the message-format/tool-use rewrite (2026-08-06)

`OllamaClient`/`GeminiClient` now share one message/tool-use format instead
of Gemini being forced through Ollama's flat `{role, content}` shape - see
`API.md` for the full design, and its "What's explicitly out of scope here"
section for the two biggest deliberate omissions (multimodal parts,
wiring this into `repl.js`'s own tool loop). Concretely still open:

- Real `tools`/`toolCalls` round trip now verified (2026-08-30), but only
  against `GeminiClient` (got real 503s - "high demand" - fast and
  correctly surfaced as errors, no hang, confirming the request framing
  with `tools` attached is sound) and `OpenAIClient` against an OpenAI-
  compatible proxy (`qwen3.8-flash`/`qwen3-coder-flash` - a full
  successful `list_directory` and `run_command` round trip each, see the
  top of this file). `OllamaClient`'s own wire format (and its streaming
  `tool_calls`-mid-chunk path specifically) is still unverified - no
  reachable Ollama server this session either (see the "not yet done"
  section at the top of this file for why).
- ~~`repl.js`'s own `LIST:`/`READ:`/`RUN:` loop doesn't use this~~ - done
  (2026-08-30): `runToolLoop()` now drives `TOOLS`/`executeTool()`
  natively - see the top of this file and `API.md`.
- No multimodal message parts (images/audio/PDFs via `inlineData`/
  `fileData`) - not needed for this project's text-only workflow yet;
  `API.md` sketches how it'd extend the format if it ever is.

## 4. Smaller/related gaps noticed while assessing

- `/files` and the session log record what was sent/written; `/context`
  and `/log` (`repl.js`, added 2026-08-06) now give REPL-side visibility
  into the raw conversation too (LIST:/READ:/RUN: tool results are
  embedded in the `user`-role messages they were fed back as, so they
  show up there), closing most of what this bullet used to describe. Not
  covered: a *filtered* view of just the tool-call history (request +
  result pairs, without the surrounding chat turns) - still only in
  `<model>.log` if that's specifically what's wanted.
- `qjsProjectDirs()`/`referenceFiles()`/`nativeModules()` all re-`readdir()`
  their directories on every call (once per chat prompt, at minimum) -
  fine at current scale, but worth caching per-session if it's ever
  noticeably slow.
- Done: `OllamaClient`/`GeminiClient`/`OpenAIClient` each used to build
  their own debug `Console` inline, inconsistently (only `OllamaClient`
  set `maxStringLength: Infinity`, so a large attached-context body could
  get truncated in `gemini-repl-debug.log`/`openai-repl-debug.log`), and
  only logged the JSON body, never the request/response headers. Pulled
  into a project-level, generic `RequestLogger` (the project root's
  `lib/logger.js`, not chat-repl-specific - wraps `std.open()` + `Console`)
  that all three now construct identically: `request()`/`response()` log
  the method/status line plus headers, one per line, plain text;
  `body()` logs the request/response body (or one streamed chunk) as a
  still-live JS value via `colors: false`, `compact: -1`,
  `reparseable: true`, `maxStringLength: Infinity`,
  `maxArrayLength: Infinity` - so nothing truncates, a logged JSON body
  stays copy-pasteable, and every client's debug log formats the same way.

## 5. Redesign the binding-writing context (see DEMO.md) - implemented, unverified live

`DEMO.md` (2026-08-06) reconsidered from scratch what gets sent to the
model for a "write a native (C) QuickJS binding" request, using zlib
(`compress2`/`uncompress`/`crc32`, real signatures checked against
`/usr/include/zlib.h`) as the worked example; its proposals are now
implemented (full detail/rationale stays in `DEMO.md`, §9 tracks exactly
what changed where):

- `examples/ollama-repl/reference/quickjs-binding-api.md`: curated
  ~150-line cheat sheet (was: naming "quickjs.h" attached the whole
  1041-line header, `lib/reference-files.js`, for a request that only
  ever needs ~60 lines of it). The full header is still one `READ:` away.
- `lib/binding-context.js` (new): auto-attaches
  `examples/fib.c`/`examples/point.c`/the cheat sheet whenever a prompt
  looks like a binding request (keyword heuristic) *or* the new
  `/binding <prompt>` REPL command is used (explicit override) -
  `DEMO.md`'s two detection options resolved as "support both" rather
  than picking one.
- System prompt's binding paragraph (`repl.js`) now asks for a one/two
  line JS-API sketch before any C gets written, and points verification
  at a standalone `gcc -shared -fPIC ... -DJS_SHARED_LIBRARY` compile
  instead of this project's own `CMakeLists.txt`/`build/` (libwebsockets,
  multi-minute link) - root-caused as (plausibly) why the one live demo
  attempt never returned; the standalone recipe was verified directly
  with `point.c` (`new Point(3,4).norm() === 5`, no CMake involved).
- `/context` (`repl.js`) now reports a total char count alongside the
  message count, so context size is visible per-session instead of
  eyeballed - a diagnostic, not an optimization target (curation quality
  matters more than raw size).
- README.md's demo walkthrough rewritten to match: the zlib
  `deflate`/`inflate`/`crc32` design, the auto-attach/`/binding` step,
  and the standalone build/smoke-test recipe.

Still open: the live re-run this was all meant to unblock
(`BUGS: ollama-native-binding-demo-never-replies` - does the smaller,
curated context actually fix the never-replies case?) needs a reachable
Ollama server or `GEMINI_API_KEY`, neither available where this work was
done - see item 4a above for the same live-verification gap.

## Done

- Session persistence and `/clear` (2026-08-17): the conversation
  (`messages`, plus the `/reset` baseline `baseMessageCount`) is now saved
  to `<model>.json` (`lib/session-store.js`) after every completed turn
  and after `/reset`/`/clear`, and reloaded from there at startup instead
  of always re-running the automatic project scan - a killed or restarted
  REPL picks the session back up where it left off (same model name, same
  `--root`; a different model or a fresh directory just starts clean, no
  file to load). `/clear` wipes the conversation *and* the `/reset`
  baseline completely (no system prompt, no project scan - a full restart
  in place), unlike `/reset`, which keeps the initial project scan.
  `/context` (already existed, see the entry below) is the way to inspect
  what's currently held, resumed or not.
- "Only the first prompt gets a reply, every one after it just hangs"
  (2026-08-09, superseded 2026-08-23): originally mitigated by discarding
  the kept-alive/pipelined (`LCCSCF_PIPELINE`) connection and reconnecting
  if a request started more than `IDLE_RECONNECT_MS` (30s) after the
  previous one - aimed at a real but *different* failure (the connection
  going silently dead server-side after ~90s idle). That mitigation didn't
  actually cover the common case: further investigation (prompted by a
  live Gemini repro showing `ESTABLISHED_CLIENT_HTTP`/
  `SERVER_NEW_CLIENT_INSTANTIATED` firing spuriously with no
  `CLIENT_APPEND_HANDSHAKE_HEADER`/`CLIENT_HTTP_WRITEABLE` ever following,
  then a timeout) root-caused the real, always-hit trigger to a
  vendored-libwebsockets gap: an h1 client request queued onto an
  already-idle pipelined connection - which is what any real, human-paced
  pause between prompts produces, regardless of the 30s threshold - is
  never promoted out of `LRS_H2_WAITING_TO_SEND_HEADERS`
  (`lws_wsi_mux_apply_queue()` only handles h2/h3/mqtt roles; see BUGS:
  h1-late-queued-pipeline-never-promoted for the full native trace). Not
  fixable at this layer. `OllamaClient`/`GeminiClient`/`OpenAIClient`
  (`lib/ollama-client.js`/`lib/gemini-client.js`/`lib/openai-client.js`)
  now open a fresh connection per request instead of reusing one across
  turns - `LCCSCF_PIPELINE` and `IDLE_RECONNECT_MS` removed entirely.
  Verified against a real Ollama server with an explicit multi-second
  pause between turns. `GeminiClient` needed a second fix on top of
  removing `LCCSCF_PIPELINE`: a live repro (real `GEMINI_API_KEY`) still
  hit the exact same symptom on a 2nd paused request even with the flag
  gone, because `GeminiClient` (unlike `OpenAIClient`) never pinned ALPN
  and was negotiating h2 with Google's servers - h2 has its own
  connection-reuse behavior independent of the app-level pipeline flag.
  Forcing `alpn: 'http/1.1'` (mirroring `OpenAIClient`'s own existing
  workaround for a different h2 bug) fixed it; see BUGS:
  gemini-client-h2-second-request-queued-never-promoted for the exact
  trace and why the root mechanism wasn't fully pinned down. Verified live
  against real Gemini: 3 sequential paused requests, previously reliably
  failing on the 2nd, all completed correctly after the ALPN change.
  `OpenAIClient` not re-verified live (same live-verification gap as the
  rest of it, see item 4a above).

- `--provider gemini`: `lib/gemini-client.js` (`chat()`/`chatStream()`,
  same shape as `OllamaClient`) and `repl.js --provider gemini` wiring it
  in. Verified working end to end, streaming and non-streaming both, for
  both a short standalone prompt and a request carrying a large (~20-28KB)
  attached-context body - the large-body case used to intermittently hang
  or drop the connection (see BUGS: tls-client-large-body-hangs-or-closes,
  found while wiring this in - fixed in `lib/lws/protocols.js`, not in
  this subproject) but now returns a normal response every time.
- `--provider gemini` always failing with "Gemini connection failed:
  closed" (2026-08-06, reported after the item above had already marked
  this "Done"): a real, separate, previously-undiscovered bug, not the
  quota-exhaustion false alarm the item above's old caveat suspected -
  see BUGS: tls-client-large-body-closes-above-16kb. Any request body over
  exactly 16384 bytes deterministically closed the connection before a
  response ever arrived - turned out to be HTTP/2's own default max
  DATA-frame size (this project's traffic negotiates h2 via ALPN), not a
  TLS record-size limit as first suspected; `repl.js`'s own automatic
  project-scan payload is routinely ~20-30KB, so this hit *every* Gemini
  session, not just ones with a large attached file. Fixed natively in
  `lws-socket.c` (`socket_flush()`), not in this subproject or even in
  JS at all - `wsi.write()` now handles a body of any size transparently,
  same as it always could for a small one - see the BUGS entry for the
  full story (two earlier fix attempts landed in the wrong place/layer
  and were reverted) and how the final fix was verified (100-100000 byte
  bodies against the real endpoint, spanning several chunk boundaries,
  plus a full `repl.js --provider gemini` session with its real ~29KB
  startup payload).
- Ctrl-C during "Thinking..." now aborts just the in-flight
  chat()/chatStream() call instead of doing nothing on the first press and
  killing the whole REPL on a second, impatient one (2026-08-08):
  `OllamaClient#abort()`/`GeminiClient#abort()` (`lib/*-client.js`) close
  the pending connection and reject its promise, same as the existing
  per-call timeout path; `ChatREPL#sigintHandler()` (`lib/chat-repl.js`)
  calls it (wired via a new `onAbort` constructor param, `repl.js`) when a
  request is actually pending, falling through to the base REPL's normal
  (idle) Ctrl-C handling otherwise. Only covers the pre-first-token wait
  (`#awaitResponse`) - a `chatStream()` call that's already past that (mid-
  stream, spinner already stopped) isn't abortable this way; out of scope
  since the spinner it was reported against is gone by then anyway.
- `OllamaClient#destroy()`/`GeminiClient#destroy()` (both `lib/*-
  client.js`) made idempotent (2026-08-06): root-caused a user-reported
  "Ctrl-C doesn't stop the REPL, then a TypeError" - a double Ctrl-C runs
  every registered cleanup handler twice (a bug in the vendored qjs-
  modules `repl.js`'s own `controlC()`/`exit()`, confirmed with a
  standalone repro, not fixed here since it's a different project's code)
  - and `destroy()` unconditionally called `this.#debugFile?.close()`
  with no guard, throwing "invalid file handle" on the second call. That
  throw happened *inside* the REPL's own `exit()`, before its
  `std.exit()` call, so it silently prevented the process from ever
  actually exiting - not just a cosmetic error. See BUGS:
  repl-controlc-double-invokes-cleanup-handlers for the full mechanism
  and repro. A `#destroyed` guard on both classes makes a second
  `destroy()` call a safe no-op instead.
- A `SEARCH:` request type (web search via Google's Custom Search JSON
  API) was built and then dropped again before landing: every keyless
  scraping target tried as an alternative (DuckDuckGo html/lite, Bing,
  several public SearXNG instances) came back bot-walled or rate-limited
  from this environment's IP, and the user decided against shipping a
  key-gated API for this. `LIST:`/`READ:`/`RUN:` remain the only request
  types.
- System prompt (`repl.js`) extended with explicit "writing a new native
  (C) QuickJS binding" guidance (read an existing sibling `qjs-*`
  binding as a template, read `quickjs.h` for real signatures, verify via
  `RUN:`/`qjsm -e` rather than just describing code) and a worked demo of
  the same in README.md.
  `RUN:`'s underlying `runCommand()` (`lib/run-command.js`) already ran
  arbitrary shell commands via `/bin/sh -c` with no changes needed -
  confirmed directly that both `git log`/`git status` and
  `qjsm -e '<code>'` work through it exactly as the demo assumes. The
  demo walkthrough itself describes the intended tool-use sequence rather
  than a transcript of a real model run: no reachable Ollama server or
  valid `GEMINI_API_KEY` in this environment to actually drive a live
  multi-turn session end to end and confirm a model follows every step -
  see item 3's `MAX_TOOL_ROUNDS` note above for a concrete gap this
  scenario would likely hit first.
- `/context` and `/log` REPL commands added (`repl.js`) - inspect the
  full outgoing context (system prompt + project scan + conversation) or
  just the conversation so far, without leaving the REPL. Default output
  is a one-line-per-message summary; run with `-x` and they instead
  `console.log()` the raw message array - full-depth, `inspect()`-colored
  on a TTY, same formatting the existing `-x` debug log already used for
  request/response payloads, just live in the terminal instead of a file.
