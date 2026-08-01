# ollama-repl

A small Claude-Code-style REPL for chatting with a local [Ollama](https://ollama.com)
model (`qwen2.5-coder` by default) about the files in your project.

- **Kept-alive HTTP client.** `lib/ollama-client.js` talks to Ollama's
  `/api/chat` endpoint directly through the `httpClient` protocol adapter
  (`lib/lws/protocols.js`) - the same building block `fetch()` uses - with
  its own `LWSContext` and `LCCSCF_PIPELINE` connect flag, so every prompt
  in a session reuses one persistent HTTP/1.1 connection instead of paying
  a fresh TCP connect per turn.
- **File/glob detection.** Type a path or glob straight into your prompt
  ("fix the bug in `src/foo.js`", "review `*.md`") and it's read off disk
  and attached to the request automatically (`lib/file-refs.js`,
  `lib/glob.js`) - no special `@file` syntax needed.
- **File output.** When you ask the model to create or modify a file, it's
  instructed (via the system prompt in `repl.js`) to reply with a
  `File: path` line followed by a fenced code block. Every such block in
  a reply is parsed out and written into your project tree automatically
  (`lib/file-blocks.js`), and printed as `modified: path`.

## Requirements

- A running Ollama server with the model pulled:
  ```sh
  ollama pull qwen2.5-coder
  ```
- `lws.so` built (see the repo root's build instructions).

## Run

```sh
qjs examples/ollama-repl/repl.js [--model qwen2.5-coder] [--host localhost] [--port 11434] [--root .]
```

`--root` is the project directory file references and writes are resolved
against - defaults to the current directory.

## REPL commands

- `/reset` - clear the conversation history (keeps the system prompt)
- `/exit` / `/quit` - quit (Ctrl-D also works)
- `/help` - list commands

## Notes / limitations

- Non-streaming only (`stream: false`) - a reply is printed once it's
  complete, not token-by-token.
- File detection is a best-effort token scan (`lib/file-refs.js`), capped
  at 20 files / 1&nbsp;MiB total per prompt so a broad glob can't flood the
  request; skipped matches are reported.
- File writes reject any path that would escape `--root` (`../..`, an
  absolute path, `~`) - see `isSafeRelativePath()` in `lib/file-blocks.js`.
- The "only emit a `File:` block when asked" instruction in the system
  prompt is just that - an instruction. Smaller/less-steerable models may
  still emit one unprompted on occasion; review `modified: path` lines
  before trusting them blindly, same as you would any AI-applied edit.
