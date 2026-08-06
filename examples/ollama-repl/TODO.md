# TODO

## Assessment (2026-08-04, updated 2026-08-04)

Current state: still not very useful yet as a working tool for QuickJS C
native-module or JS coding via `qjsm`. The pieces (file attach, LIST:/READ:/
RUN:, file-block writeback, session log) all work individually, but the
model doesn't reliably *drive* them the way Claude Code drives its own
tools - it tends to answer from guesswork instead of grounding itself in
the actual codebase first, and it still has no way to ask the user
anything. The harness's *reach* has grown a lot since the original
assessment - it's no longer confined to `--root`, basic prompting/
answering actually works now, and context is built more deliberately
(dependencies named instead of dumped) - but the model still has to be
told when to use that reach, and the "ask the user" half of the plumbing
is still entirely missing.

## 1. Add an ASK: request type (user feedback loop)

Still not implemented. There is no way for the model to ask the *user* a
clarifying question mid-turn. `LIST:`/`READ:`/`RUN:` all round-trip
through the REPL automatically; the model can request information from
the filesystem but not from the human. For anything genuinely ambiguous
(which of two similarly-named files, whether to overwrite, what behavior
is actually wanted) it currently either guesses or asks in prose that the
REPL just prints as its final answer - no reply comes back to it, so the
"question" is a dead end.

- New request type `ASK: <question>`, handled in `lib/tool-requests.js`
  next to `extractRequests`/`runRequests`.
- In `repl.js`'s `runToolLoop`, an `ASK:` result should suspend the loop,
  print the question, read one line from the user (reuse
  `ChatREPL#confirm`-style prompting, or a plain `readline`), and feed the
  answer back as the next turn's tool result - same shape as a LIST/READ
  result today.
- System prompt: tell the model `ASK:` exists and *when* to prefer it over
  guessing (ambiguous scope, destructive-looking change, missing info
  only the user has) - mirroring the "prefer asking over assuming"
  language already there for file contents, but pointed at the user
  instead of the filesystem.
- Should count toward `MAX_TOOL_ROUNDS` like the others so a model that
  gets stuck asking can't loop forever.

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

Still open:
- Consider re-injecting a short reminder of the tool-use rule
  periodically (e.g. appended to the "Tool results:" continuation message
  in `runToolLoop`) rather than relying on it surviving from the system
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

## 3. Push the model harder toward using the harness

Even with ASK: added and the prompt restructured, qwen2.5-coder needs to
be told, explicitly and repeatedly, to *prefer* LIST:/READ:/RUN:/ASK: over
answering from memory - especially for:

- C/QuickJS work: read the actual binding file and `quickjs.h` (via the
  `lib/reference-files.js` name-drop mechanism) before describing or
  editing JS<->C glue, rather than recalling the API from the primer in
  the system prompt alone.
- Native-module work specifically: now that `nativeModules()` can guess
  which sibling project a compiled `.so` came from, that guess isn't
  surfaced to the model anywhere yet (it's dead code from the model's
  point of view) - either inject it into the system prompt or expose it
  as another LIST:/READ: shortcut (e.g. resolving a bare `.so` name to
  its guessed project) so the model actually uses it instead of guessing
  which qjs-* project a given native module lives in.
- Anything it's about to write a `File:` block for: `READ:` the target
  file first if it already exists, so the rewrite is grounded in the
  current contents rather than the model's assumption of what's there.
- `MAX_TOOL_ROUNDS` is 4 - worth revisiting once ASK:/heavier tool use
  land, since a real "explore, then ask, then read, then answer" sequence
  can burn through that quickly on a non-trivial question, and sibling-
  project exploration adds more rounds a session might need.

## 4a. Follow-ups from the message-format/tool-use rewrite (2026-08-06)

`OllamaClient`/`GeminiClient` now share one message/tool-use format instead
of Gemini being forced through Ollama's flat `{role, content}` shape - see
`API.md` for the full design, and its "What's explicitly out of scope here"
section for the two biggest deliberate omissions (multimodal parts,
wiring this into `repl.js`'s own tool loop). Concretely still open:

- Not yet verified against a live Gemini/Ollama *tool-calling* exchange -
  this environment had no reachable Ollama server or a valid
  `GEMINI_API_KEY` to test against (only a deliberately-invalid one, to
  confirm connectivity/request framing - see BUGS:
  tls-client-large-body-closes-above-16kb, found via that same testing).
  Checked so far: both files parse and import cleanly, both classes
  instantiate/`destroy()` without error, `GeminiClient` was confirmed to
  reach the real endpoint and get a real (well-formed, non-"closed")
  response across a wide range of body sizes, and the request/response
  shapes were reviewed against the vendored API docs (see `API.md`'s
  research section). What's still unverified is a real `tools`/
  `toolCalls` round trip specifically - re-verify with a valid key/server
  before relying on it, especially `OllamaClient`'s streaming path, since
  a `tool_calls` chunk arriving mid-stream (per Ollama's own docs) was
  never observed directly here.
- `repl.js`'s own `LIST:`/`READ:`/`RUN:` loop (`runToolLoop()`,
  `lib/tool-requests.js`) still doesn't use this - it's a separate
  plain-text-in-the-reply-body protocol, untouched by this rewrite. Using
  real `tools`/`toolCalls` there instead (or alongside) is a bigger,
  separate change - see `API.md`.
- No multimodal message parts (images/audio/PDFs via `inlineData`/
  `fileData`) - not needed for this project's text-only workflow yet;
  `API.md` sketches how it'd extend the format if it ever is.

## 4. Smaller/related gaps noticed while assessing

- `/files` and the session log record what was sent/written, but there's
  no equivalent visibility into the LIST:/READ:/RUN:/ASK: tool-call
  history from inside the REPL itself (only in `<model>.log`) - a
  `/tools` command mirroring `/files` might help a user debug why the
  model went down a particular path.
- `qjsProjectDirs()`/`referenceFiles()`/`nativeModules()` all re-`readdir()`
  their directories on every call (once per chat prompt, at minimum) -
  fine at current scale, but worth caching per-session if it's ever
  noticeably slow.
- `OllamaClient`'s debug `Console` now sets `maxStringLength: Infinity` in
  its `inspectOptions` (so a large attached-context body in a logged
  request/response doesn't get truncated); `GeminiClient`'s debug
  `Console` (`lib/gemini-client.js`) still only sets `depth: Infinity` and
  will truncate long strings in `gemini-repl-debug.log`. Worth matching
  the two if `GeminiClient`'s debug log is ever used to inspect a large
  payload.

## Done

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
