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
  (`src/`) attaches up to `MAX_DIR_FILES` (4) of its source files instead
  of failing to resolve - top-level files first, then newest-first within
  each depth, not just "whatever's newest anywhere in the tree" (which
  tended to pick every result from one deeply-nested subdirectory).
  Referencing one specific file also has its direct local imports/
  `#include`s extracted (`lib/imports.js`, a regex-based parser +
  `os.readdir()`-backed resolver) and named - not attached - in a note
  after its content, so the model can `READ:` whichever of them it
  actually turns out to need instead of every reference dragging its
  whole dependency chain along unasked.
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
- **Project awareness (LIST:/READ:/RUN:).** The system prompt
  tells the model it can ask the REPL to list files (`lib/tool-
  requests.js`, restricted to JS/C/HTML/CSS/Markdown + README\*), read a
  file or glob, run a shell command itself - to grep/search the codebase,
  test a change (including a quick `qjsm -e '<code>'` one-liner to check
  a JS/C-binding API call actually works before writing it into a file),
  or drive `git` (status/diff/log). The model's told to do all of this proactively, as soon as it's unsure
  about something, rather than guessing. Each reply is scanned for these
  request lines; if any are found, they're run and the results fed back
  as the model's next turn automatically (up to `MAX_TOOL_ROUNDS` rounds
  per prompt, in `repl.js`) before the final answer is shown. `RUN:`
  commands are never run silently - you're shown the exact command and
  asked to approve it (`ChatREPL#confirm()`, `lib/chat-repl.js`) before it
  executes; a declined command is reported back to the model as declined.
- **Automatic project scan at startup.** Before the first prompt, the
  REPL seeds the conversation with a shallow, top-level-only listing of
  the project root (filtered to `SOURCE_EXT`, `lib/file-refs.js`, and
  whatever `.gitignore` already excludes) plus the root `README.md` and
  `CMakeLists.txt` if present (`gatherProjectContext()`, `repl.js`) - the
  same way Claude Code reads project context up front instead of waiting
  to be asked. Deliberately shallow: a full recursive listing plus every
  README\* in the tree used to be seeded here, which ran to tens of KB
  before a single word had been exchanged; a top-level overview is enough
  to know the project's shape; `LIST:`/`READ:` reaches anything deeper.
  `/reset` clears conversation history but keeps this initial scan.
- **QuickJS/qjs-modules awareness.** The system prompt points the model at
  `quickjs.h` (the QuickJS C API) and the qjs-modules JS built-ins
  (`fs`/`console`/`process`/`util`) by name rather than paraphrasing their
  API inline - mentioning either in a prompt attaches the real file
  (`lib/reference-files.js`), same as any project file, so the model reads
  the actual source instead of a summary of it. The sibling `qjs-*`
  native-module projects checked out next to this repo (`qjs-modules`,
  `qjs-ffi`, `qjs-net`, ...) are real prior art for how a binding is
  structured - `LIST:`/`READ:` can reach into any of them by directory
  name (e.g. `LIST: qjs-modules`, `READ: qjs-ffi/ffi.c`), not just this
  project.
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

## Using `OllamaClient`/`GeminiClient` directly

Both `lib/ollama-client.js` and `lib/gemini-client.js` are usable on their
own from a `qjsm` REPL, independent of `repl.js`'s own chat loop - handy for
poking at a model manually, or for driving real API-native tool/function
calling, which `repl.js`'s own `LIST:`/`READ:`/`RUN:` loop doesn't use (that
loop is a plain-text protocol parsed out of the reply body, not either
provider's actual tool-calling API). See `API.md` for the full design and
more examples; short version:

```js
import { OllamaClient } from './lib/ollama-client.js';
// or: import { GeminiClient } from './lib/gemini-client.js';

const client = new OllamaClient({ model: 'qwen2.5-coder' });
const { content } = await client.chat([{ role: 'user', content: 'hi' }]);
console.log(content);
```

`chat()`/`chatStream()` accept a `tools: [{ name, description, parameters
}]` option (`parameters` a JSON Schema object) and return `{ content,
toolCalls? }` - `toolCalls` (`[{ id, name, args }]`) is present whenever the
model asks to call one. Feed the result back as a `{ role: 'tool', name,
content }` message to continue the exchange - same message shapes work
against either client. `API.md` has a full round-trip example.

## Requirements

- `--provider ollama` (the default): a running Ollama server with the
  model pulled:
  ```sh
  ollama pull qwen2.5-coder
  ```
- `--provider gemini`: `GEMINI_API_KEY` exported in the environment (a
  free-tier key from https://aistudio.google.com/apikey works).
- `lws.so` built (see the repo root's build instructions).

## Run

```sh
qjsm examples/ollama-repl/repl.js [--provider ollama|gemini] [--model NAME] [--host localhost] [--port 11434] [--root .] [--stream] [-x] [--failsafe]
```

(`qjsm`, not `qjs` - the REPL's service loop needs `os`/`std` available as
globals, which `qjsm` does by default; plain `qjs` needs `--std` for the
same effect.) Once installed (see the repo root's `CMakeLists.txt`), it's
just `ollama-repl [...]` from `bin/`.

`--root` is the project directory file references and writes are resolved
against - defaults to the current directory.

`--failsafe` strips out all of the REPL's own scaffolding: no system
prompt, no automatic project scan, no file-ref attachment, no
LIST:/READ:/RUN: tool loop, no "File:" auto-write. Each turn is just the
message you typed, sent to the model as-is (conversation history is still
kept across turns) - useful when you want a plain chat against the model
itself, or when the scaffolding is what you're trying to rule out.

`-x` (or the `DEBUG` env var, regardless of `-x`) logs every raw Ollama
request/response - and, with `--stream`, every individual NDJSON chunk -
to `ollama-repl-debug.log` (append mode, `inspect()`-formatted, full
depth) instead of the terminal.

## REPL commands

- `/reset` - clear the conversation history (keeps the initial project scan)
- `/exit` / `/quit` - quit (Ctrl-D also works)
- `/help` - list commands
- `/run <command>` - run a shell command yourself, immediately - no model
  round trip, no approval prompt (that's only for the model's own `RUN:`
  requests - see above)
- `/status` - model/connection/session info
- `/files` - dump this session's file exchange (sent, received, diffs)
- `/context` - inspect the full context about to be sent to the model
  (system prompt + project scan + conversation) - a one-line-per-message
  summary by default, or the raw message objects (`console.log`, so
  `inspect()`-formatted and colored on a TTY) when run with `-x`
- `/log` - same, but just the conversation so far (no system
  prompt/project scan)
- `/binding <text>` - force-attach the native-binding reference material
  (see below) for this prompt, even if it doesn't happen to contain a
  word the auto-detect heuristic looks for

## Demo: writing a native QuickJS binding

A worked example of the kind of session this project is meant for -
asking the model to write a new native (C) QuickJS binding, grounded in
this project's own conventions rather than guessed from memory. Works the
same against either provider:

```sh
qjsm examples/ollama-repl/repl.js --provider ollama   # or --provider gemini
```

Any prompt that looks like a binding request (contains "binding",
"native module", "quickjs module", ...) auto-attaches three small,
curated references before it's sent - no need to ask for them by name:
`examples/fib.c` (plain function export), `examples/point.c` (class
binding), and `examples/ollama-repl/reference/quickjs-binding-api.md` (a
~150-line cheat sheet excerpted from `quickjs.h`'s 1041 - the signatures
that actually recur across bindings, each with the ownership rule that
matters, grouped by concern: values/conversion, exceptions, classes &
opaque data, memory, ArrayBuffer in/out, module registration). Use
`/binding <prompt>` to force this even for a prompt that doesn't happen
to contain a trigger word.

```
you> write a small native QuickJS module that binds compress2()/
     uncompress()/crc32() from zlib as deflate()/inflate()/crc32() -
     sketch the JS-facing API first, then implement it
```

A reasonable turn from here looks roughly like:

1. A one- or two-line API sketch as plain text before any C - e.g.
   `crc32(data): number`, `deflate(data): ArrayBuffer`, `inflate(data,
   expectedSize): ArrayBuffer` (`uncompress()` needs the caller to
   know/guess the output size up front - worth the model noticing and
   asking about, or documenting a "guess, retry larger on `Z_BUF_ERROR`"
   fallback).
2. `READ: /usr/include/zlib.h` (or `LIST: /usr/include`) - the real
   `compress2()`/`uncompress()`/`crc32()`/`compressBound()` signatures,
   found locally rather than guessed.
3. A `File: examples/ollama-repl/zlib-binding.c` block with the binding -
   grounded in the auto-attached `point.c`/cheat-sheet shapes (§ above)
   for the class-vs-plain-function boilerplate and the `js_malloc` +
   `JS_NewArrayBuffer(..., free_func, ...)` pattern for the compressed-
   output buffer.
4. Compiled and smoke-tested standalone - **not** through this project's
   own `CMakeLists.txt`/`build/` (that pulls in libwebsockets and a
   multi-minute link for something that needs none of it):
   `RUN: gcc -shared -fPIC -I<quickjs-source-dir> -o zlib-binding.so
   examples/ollama-repl/zlib-binding.c -lz -DJS_SHARED_LIBRARY`, then
   `RUN: qjsm -e 'import("./zlib-binding.so").then(m =>
   console.log(m.crc32("hello")))'` - real output shown before it's
   called done, same as `point.c` itself verifies (`new Point(3,4).norm()
   === 5`, no CMake involved).
5. `RUN: git diff --stat` / `RUN: git status` - a sanity check on what
   actually changed, same as a human would before considering a change
   finished.

None of this is scripted or special-cased in `repl.js` beyond the
auto-attach step above - it's the same `LIST:`/`READ:`/`RUN:` loop (see
above) the system prompt already describes generically, plus the system
prompt's own explicit "writing a new native (C) binding" guidance
pointing at these same steps. A smaller/less capable local model may need
more nudging in the prompt itself to actually follow through on every
step (verify via `RUN:` instead of just describing code, in particular)
than a larger hosted one does - see `TODO.md` item 3 for the broader
"push the model harder toward using the harness" gap this demo exercises
end to end.

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
