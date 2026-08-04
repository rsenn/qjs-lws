# ollama-repl

A small Claude-Code-style REPL for chatting with a local [Ollama](https://ollama.com)
model (`qwen2.5-coder` by default) about the files in your project.

- **Kept-alive HTTP client.** `lib/ollama-client.js` talks to Ollama's
  `/api/chat` endpoint directly through the `httpClient` protocol adapter
  (`lib/lws/protocols.js`) - the same building block `fetch()` uses - with
  its own `LWSContext` and `LCCSCF_PIPELINE` connect flag, so every prompt
  in a session reuses one persistent HTTP/1.1 connection instead of paying
  a fresh TCP connect per turn.
- **Token streaming (`--stream`).** Ollama's own HTTP API streams
  newline-delimited JSON when asked (`stream: true`) over that same
  connection - no child process or second connection needed. `chatStream()`
  reads the response body (a real `ReadableStream`) incrementally via
  `getReader()` and prints each token as it arrives.
- **File/glob/directory detection.** Type a path or glob straight into
  your prompt ("fix the bug in `src/foo.js`", "review `*.md`", or
  `src/**.ts` to recurse a whole tree for one extension) and it's read off
  disk and attached automatically (`lib/file-refs.js`, `lib/match.js`) -
  no special `@file` syntax needed. A directory reference ending in `/`
  (`src/`) attaches its `MAX_DIR_FILES` (5) most-recently-modified source
  files instead of failing to resolve. Referencing one specific file also
  pulls in its direct local imports/`#include`s (`lib/imports.js`, a
  regex-based parser + `os.readdir()`-backed resolver, bounded depth/count)
  so its immediate dependencies come along without asking for each by name.
- **File exchange tracking.** Every file attached (project -> model) and
  every file the model writes back (model -> project) is recorded for the
  session (`lib/file-exchange.js`); `/files` dumps the full history. A
  written file that already existed gets diffed against its previous
  content first, and the diff is saved to `<model>-diffs/NNN-name.diff` -
  reviewable, and revertible with `patch -R < that-file`.
- **File output.** When you ask the model to create or modify a file, it's
  instructed (via the system prompt in `repl.js`) to reply with a
  `File: path` line followed by a fenced code block. Every such block in
  a reply is parsed out and written into your project tree automatically
  (`lib/file-blocks.js`), and printed as `modified: path`. Any OTHER
  fenced code block in a reply - one without a `File:` label - is saved
  too, as `<model>-output-N.ext` (extension guessed from the block's
  language tag, `lib/sent-files.js` tracks the numbering across a run so
  it never collides with a previous run's output files) - nothing the
  model writes is silently dropped just because it skipped the
  convention. The system prompt asks it to suggest a real filename for
  every snippet it writes (even a quick example), so the auto-numbered
  fallback is mostly a safety net rather than the common case.
- **Project awareness (LIST:/READ:/RUN:).** The system prompt tells the
  model it can ask the REPL to list files (`lib/tool-requests.js`,
  restricted to JS/C/HTML/CSS/Markdown + README\*), read a file or glob,
  or run a shell command itself - to grep/search the codebase, inspect a
  directory, or debug something (`lib/run-command.js`, output-capped and
  time-bounded) - and to do so proactively, as soon as it's unsure about
  something, rather than guessing. Each reply is scanned for these
  request lines; if any are found, they're run and the results fed back
  as the model's next turn automatically (up to `MAX_TOOL_ROUNDS` rounds
  per prompt, in `repl.js`) before the final answer is shown. `RUN:`
  commands are never run silently - you're shown the exact command and
  asked to approve it (`ChatREPL#confirm()`, `lib/chat-repl.js`) before it
  executes; a declined command is reported back to the model as declined.
- **Automatic project scan at startup.** Before the first prompt, the
  REPL runs its own `LIST:`/`READ:` of the project root - every README\*
  and `CMakeLists.txt` if present - and seeds it into the conversation
  automatically (`gatherProjectContext()`, `repl.js`), the same way Claude
  Code reads project context up front instead of waiting to be asked.
  `/reset` clears conversation history but keeps this initial scan.
- **QuickJS/qjs-modules awareness.** The system prompt gives the model a
  concise primer on the QuickJS C API (`JSValue`/`JSContext`, the class +
  opaque-struct pattern, `JS_CFUNC_MAGIC_DEF`/`JS_CGETSET_MAGIC_DEF`,
  module registration, exceptions) and the qjs-modules JS built-ins
  (`fs`/`console`/`process`/`util`), enough to work on qjs-\* native
  modules without re-deriving the API from scratch every session.
  Mentioning any QuickJS interpreter header by name (`quickjs.h`,
  `cutils.h`, `list.h`, ...) or one of the qjs-modules built-ins
  (`fs.js`, `console.js`, `process.js`, `util.js`) in a prompt attaches
  the real file (`lib/reference-files.js`), same as any project file -
  so the primer covers the shape, the actual source is a name-drop away
  when a question needs it verbatim. The sibling `qjs-*` native-module
  projects checked out next to this repo (`qjs-modules`, `qjs-ffi`,
  `qjs-net`, ...) are real prior art for how a binding is structured -
  `LIST:`/`READ:` can reach into any of them by directory name (e.g.
  `LIST: qjs-modules`, `READ: qjs-ffi/ffi.c`), not just this project.
- **Real line editing + persisted history + Tab-completion.**
  `lib/chat-repl.js` drives the prompt loop through qjs-modules' built-in
  `REPL` (module `'repl'`) instead of a plain `std.in.getline()` loop -
  up/down arrow recalls previous prompts, `^R` reverse-searches them,
  history persists across runs (`~/.<scriptname>_history` by default,
  qjs-modules' convention, not this project's), and Tab completes
  filesystem paths (relative to `--root`) instead of the base REPL's
  default JS-identifier completion. Input is plain bright white, not the
  base REPL's live JS-syntax highlighting (meaningless for a chat prompt).
- **Session log.** Every prompt (with what was attached), reply, tool
  result, and file written is appended, timestamped, to `<model>.log` in
  the current directory (`lib/session-log.js`) - independent of the
  terminal, and across runs (opened in append mode).
- **Thinking indicator.** A small animated "▘ Thinking..." spinner (cycling
  through the four Unicode quadrant-block glyphs) shows while waiting on
  the model, replaced by the reply the moment the first token (or the
  whole non-streamed reply) arrives; a dim "Cogitated for N.Ns" line
  follows once a turn is fully done.

## Requirements

- A running Ollama server with the model pulled:
  ```sh
  ollama pull qwen2.5-coder
  ```
- `lws.so` built (see the repo root's build instructions).

## Run

```sh
qjsm examples/ollama-repl/repl.js [--model qwen2.5-coder] [--host localhost] [--port 11434] [--root .] [--stream]
```

(`qjsm`, not `qjs` - the REPL's service loop needs `os`/`std` available as
globals, which `qjsm` does by default; plain `qjs` needs `--std` for the
same effect.) Once installed (see the repo root's `CMakeLists.txt`), it's
just `ollama-repl [...]` from `bin/`.

`--root` is the project directory file references and writes are resolved
against - defaults to the current directory.

## REPL commands

- `/reset` - clear the conversation history (keeps the initial project scan)
- `/exit` / `/quit` - quit (Ctrl-D also works)
- `/help` - list commands
- `/run <command>` - run a shell command yourself, immediately - no model
  round trip, no approval prompt (that's only for the model's own `RUN:`
  requests - see above)
- `/status` - model/connection/session info
- `/files` - dump this session's file exchange (sent, received, diffs)

## Notes / limitations

- Non-streaming (full reply printed at once) by default; pass `--stream`
  for token-by-token output.
- File detection is a best-effort token scan (`lib/file-refs.js`), capped
  at 20 files / 1&nbsp;MiB total per prompt so a broad glob can't flood the
  request; skipped matches are reported.
- File writes reject any path that would escape `--root` (`../..`, an
  absolute path, `~`) - see `isSafeRelativePath()` in `lib/file-blocks.js`.
- The "only emit a `File:` block when asked" instruction in the system
  prompt is just that - an instruction. Smaller/less-steerable models may
  still emit one unprompted on occasion; review `modified: path` lines
  before trusting them blindly, same as you would any AI-applied edit.
