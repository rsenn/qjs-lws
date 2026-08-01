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
- **File/glob detection.** Type a path or glob straight into your prompt
  ("fix the bug in `src/foo.js`", "review `*.md`") and it's read off disk
  and attached to the request automatically (`lib/file-refs.js`,
  `lib/glob.js`) - no special `@file` syntax needed.
- **File output.** When you ask the model to create or modify a file, it's
  instructed (via the system prompt in `repl.js`) to reply with a
  `File: path` line followed by a fenced code block. Every such block in
  a reply is parsed out and written into your project tree automatically
  (`lib/file-blocks.js`), and printed as `modified: path`.
- **QuickJS/qjs-modules awareness.** The system prompt gives the model a
  concise primer on the QuickJS C API (`JSValue`/`JSContext`, the class +
  opaque-struct pattern, `JS_CFUNC_MAGIC_DEF`/`JS_CGETSET_MAGIC_DEF`,
  module registration, exceptions) and the qjs-modules JS built-ins
  (`fs`/`console`/`process`/`util`), enough to work on qjs-\* native
  modules without re-deriving the API from scratch every session.
  Mentioning `quickjs.h`, `fs.js`, `console.js`, `process.js`, or
  `util.js` by name in a prompt attaches the real file from its installed
  location (`lib/reference-files.js`), same as any project file - so the
  primer covers the shape, the actual source is a name-drop away when a
  question needs it verbatim.

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

- `/reset` - clear the conversation history (keeps the system prompt)
- `/exit` / `/quit` - quit (Ctrl-D also works)
- `/help` - list commands

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
