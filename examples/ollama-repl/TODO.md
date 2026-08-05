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

## Done

- `--provider gemini`: `lib/gemini-client.js` (`chat()`/`chatStream()`,
  same shape as `OllamaClient`) and `repl.js --provider gemini` wiring it
  in. Verified working end to end, streaming and non-streaming both, for
  both a short standalone prompt and a request carrying a large (~20-28KB)
  attached-context body - the large-body case used to intermittently hang
  or drop the connection (see BUGS: tls-client-large-body-hangs-or-closes,
  found while wiring this in - fixed in `lib/lws/protocols.js`, not in
  this subproject) but now returns a normal response every time. That
  BUGS entry has a caveat worth rereading: the ~20-28KB range specifically
  wasn't fully reverified after the fix, since testing ran into Gemini's
  free-tier daily request quota partway through.
