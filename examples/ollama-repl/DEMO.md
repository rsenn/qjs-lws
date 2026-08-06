# Demo redesign: writing a native QuickJS binding (zlib as the worked example)

## 0. Example prompts: what this REPL is actually good for

The binding-writing walkthrough below is one worked example, not the only
shape of session this REPL supports. Grounded in what the code actually
does (`repl.js`, `lib/file-refs.js`, `lib/tool-requests.js`,
`lib/file-blocks.js`), here's the range of prompts worth trying, roughly
in order of how much of the machinery each one exercises:

- **Plain question, no project involvement.**
  `what's the difference between JS_FreeValue and JS_FreeValueRT?`
  Exercises nothing but `chat()`/`chatStream()` itself - no file attach,
  no tool loop. `--failsafe` mode (no system prompt/project scan/tools at
  all) is the purest version of this - useful for comparing the model's
  raw behavior against what the scaffolding adds.

- **Reference a file or glob directly to attach it.**
  `explain what lib/chat-repl.js is doing` or `review *.md for
  inconsistencies` - `file-refs.js` token-scans the prompt for
  path-/glob-shaped text, reads matching files off disk (up to
  `MAX_FILES`/`MAX_TOTAL_BYTES`), and attaches their contents before the
  prompt is sent, same as Claude Code's own `@file` convenience, just
  without the explicit `@`.

- **Ask it to investigate rather than attaching yourself.**
  `why does the spinner in repl.js sometimes keep running after an
  error?` - nothing attached up front, so the model has to `LIST:`/`READ:`
  its way to an answer (bounded by `MAX_TOOL_ROUNDS`) instead of pattern-
  matching from the question alone. Good for checking whether the model
  actually grounds itself or guesses.

- **Ask it to run something and reason about the output.**
  `run the tests and tell me what's failing` or `what does git diff show
  for lib/session-log.js?` - drives a `RUN:` request (shell command,
  confirmed with you first via `repl.confirm()`) rather than a `LIST:`/
  `READ:`.

- **Ask for a fix or small feature, expecting a file write back.**
  `fix the bug in lib/sent-files.js where...` - the model's reply, if it
  includes a `File: path` block, gets parsed out and written to disk
  automatically (`file-blocks.js`) - the same mechanism a "write a new
  binding" prompt uses, just against an existing file instead of a new
  one. Worth trying on a small, well-scoped bug first, before a
  multi-file change.

- **Multi-file change spanning more than one write.**
  `rename the SentFiles class to FileTracker across the codebase` - more
  than one `File:` block in a single reply; tests whether the model keeps
  the edits mutually consistent (matching signatures/imports across
  files) without being shown every call site up front, since only what it
  `READ:`s or what's attached is actually in context.

- **Write a new native (C) QuickJS binding.**
  The rest of this document - the most demanding case: requires the
  model to combine several QuickJS-specific conventions (§1) correctly,
  not just imitate one file's shape. Treated separately below because
  getting it right needs curated reference material (§2-§4), not just
  the general LIST:/READ:/RUN: loop.

Trying a few of the earlier, cheaper cases first - before jumping to the
binding demo - is a useful sanity check on its own: if a plain question or
a small single-file fix doesn't come back correctly, a binding won't
either, and it's much faster to find that out on the small case.

The current "write a native binding" demo (README.md's "Demo" section) was
never actually verified end to end - the one live attempt
(`qwen2.5-coder:latest`, asked to bind `crc32()`) ran for 900s and never
produced a reply (see `BUGS: ollama-native-binding-demo-never-replies`).
Before retrying it, this document reconsiders what we actually hand the
model to work with - both what's attached automatically and what it has to
`READ:`/`LIST:` for itself - rather than assuming more context is better.
Zlib is the running example throughout (`compress2()`/`uncompress()`/
`crc32()` - all bounded, non-streaming, real local signatures, checked
against `/usr/include/zlib.h` on this box), but the conclusions apply to
any "bind a C library" request.

## 1. What the model actually needs to know

Writing a correct QuickJS binding is not "know the whole C API" - it's a
small, fixed set of concerns that show up in almost every binding,
regardless of which library is underneath:

1. **JSValue lifecycle.** `JSValue` is refcounted; `JSValueConst` in an
   argument position means "borrowed, don't free it"; a `JSValue` a
   function *returns or stores* must eventually be freed with
   `JS_FreeValue(ctx, v)` (or `JS_FreeValueRT` from a finalizer, where
   there's no `ctx`) by whoever owns it. Getting this wrong is the single
   most common source of leaks/crashes in a hand-written binding, and it's
   also the thing a model is likeliest to get wrong via pattern-matching
   from unrelated C code instead of QuickJS's actual convention.
2. **Exceptions are values, not control flow.** `JS_EXCEPTION` is a real
   `JSValue` a C function returns to signal failure (after calling a
   `JS_Throw*`); there's no C-level `try/catch` - every call that can fail
   must be checked and propagated (`goto fail` is the idiom both example
   files use).
3. **Opaque binding for a class.** `JSClassID` + `JS_NewClass()` +
   `JS_SetOpaque()`/`JS_GetOpaque()`/`JS_GetOpaque2()` + a finalizer is the
   entire mechanism for attaching a C struct to a JS object - the same
   four-piece shape every time, demonstrated end to end in `point.c`
   below.
4. **Memory: `js_malloc`/`js_mallocz`/`js_free` (context-bound) vs.
   `js_free_rt` (runtime-bound, needed in a finalizer, which only has
   `JSRuntime*`)** - not libc `malloc`/`free`, and not two different
   allocators mixed on the same pointer.
5. **ArrayBuffer in/out**, specifically for zlib-shaped bindings:
   `JS_GetArrayBuffer(ctx, &size, obj)` to read input bytes without
   copying, and `JS_NewArrayBuffer(ctx, buf, len, free_func, opaque,
   is_shared)` to hand back an owned buffer with a custom free callback -
   the shape `compress2()`/`uncompress()` need directly (allocate a
   `js_malloc`'d output buffer up front, call the C function into it, wrap
   the result).

None of this is exotic, but none of it is guessable from generic C
experience either - `JSValueConst`, the refcounting convention, and the
opaque/finalizer dance are QuickJS-specific and have to come from
QuickJS's own source, not the model's training-data prior for "how C
extension modules usually work" (which skews Python/Node-flavored and
will actively mislead it on ownership rules).

## 2. The reference material that already exists, and what's actually load-bearing in each

| file | lines | what it demonstrates | worth attaching whole? |
|---|---:|---|---|
| `examples/fib.c` | 73 | Plain function export: `JSCFunctionListEntry` + `JS_CFUNC_DEF` + `js_init_module`/`JS_NewCModule` - the minimum viable binding | yes - small, self-contained |
| `examples/point.c` | 152 | Class binding: `JSClassID`, finalizer, `JS_NewObjectProtoClass`+`new_target` in the constructor, `JS_GetOpaque2`, magic-numbered getter/setter pair, `JS_SetConstructor` | yes - small, self-contained, covers concern #3 above completely |
| `qjs-modules/quickjs-arraybuffer-sink.c` | 211 | The `JS_NewArrayBuffer(ctx, buf, size, free_func, ...)` pattern with a real custom free callback (`js_arraybuffer_sink_free`) - the exact shape zlib's compressed-output buffer needs | mostly - but it also pulls in `DynBuf`/`InputBuffer`/`js_input_args` from qjs-modules' own `buffer-utils.h`, which isn't part of QuickJS itself and would send the model chasing an unrelated internal API. **Better: excerpt just the `METHOD_FLUSH`/finalizer shape (roughly lines 88-112 + 149-157), not the whole file.** |
| `quickjs.h` | 1041 | Every public API signature that exists | **no** - see below |

Checked directly: of `quickjs.h`'s 1041 lines, ~60 lines are the
signatures that actually recur across bindings (`JS_New{Int32,Uint32,
Float64,Bool}`, `JS_To{Int32,Uint32,Int64}`, `JS_{Get,Set}Opaque{,2}`,
`JS_NewClassID`/`JS_NewClass`, `JS_New{Object,ObjectProtoClass}`,
`JS_{New,Get}ArrayBuffer`, `js_{malloc,mallocz,free,free_rt}`,
`JS_Throw{Type,Range,Internal}Error`, `JS_FreeValue`, `JS_IsException`,
`JSCFunctionListEntry`/`JS_CFUNC_DEF`/`JS_CGETSET_MAGIC_DEF`). The other
~94% is timer/promise/proxy/module-loader/bytecode/debugger internals
that essentially never come up in an ordinary binding. Right now, naming
"quickjs.h" in a prompt (`lib/reference-files.js`) attaches all 1041
lines - full noise-to-signal ratio, working against the model rather than
for it.

## 3. Proposal: a curated cheat sheet, not the raw header

Add `examples/ollama-repl/reference/quickjs-binding-api.md` (or `.h` - a
real excerpted header compiles fine as a sanity check that the signatures
weren't mistyped): the ~60-80 lines above, grouped by concern (values &
conversion / exceptions / classes & opaque data / memory / array
buffers / module registration), each with a one-line note on the
ownership rule that matters (e.g. "`JS_GetArrayBuffer` returns a pointer
*into* the buffer - don't free it; freeing the buffer is the ArrayBuffer
object's job, via its own `free_func`"). This becomes the thing
auto-attached instead of full `quickjs.h`, with a note in the system
prompt that the full header is still one `READ: quickjs.h` away for
anything not covered (exact struct layout, a rarer function, BigInt
handling, etc).

This is strictly additive to what `reference-files.js` already does - it
doesn't remove the ability to `READ: quickjs.h`, it just stops that being
the *first and only* option, the way pointing a junior engineer at a
one-page cheat sheet beats pointing them at the full header and hoping
they skim to the right section.

## 4. What to auto-attach vs. what to let the model request

Current behavior for *any* prompt: automatic top-level project scan
(README/CMakeLists.txt), then whatever the prompt's own file-references
pull in. Nothing binding-specific is attached until the model itself
issues `LIST:`/`READ:` requests - which is the right instinct (build up
what's needed, don't front-load), but it means the model has to already
know to ask for `point.c`/`quickjs.h` in the first place, with no
example of the *shape* of a good binding to imitate before it starts
generating code.

Proposed startup context, specifically when the prompt looks like a
binding-writing request (detect the same way file-refs.js already detects
a file/glob reference - a lightweight heuristic, e.g. "bind", "binding",
"native module", "quickjs module" in the prompt text, nothing fancier):

- **Auto-attached** (small, always relevant, imitation-worthy):
  `examples/fib.c`, `examples/point.c`, the curated cheat sheet (§3).
  Rough budget: fib.c (73) + point.c (152) + cheat sheet (~80) ≈ 300
  lines / ~9KB - two orders of magnitude smaller than today's "attach the
  whole 1041-line header" default.
- **Left for the model to `READ:`/`LIST:` on demand**: the full
  `quickjs.h` (a rarer signature, exact field layout), the target C
  library's own header (`zlib.h` here - `READ: /usr/include/zlib.h` or
  `LIST: /usr/include` if the model doesn't already know the path), any
  qjs-modules binding beyond the excerpted snippet (`LIST: qjs-modules`
  then `READ:` a specific file it picks as most relevant to its own
  design, e.g. `quickjs-arraybuffer-sink.c` for a buffer-heavy binding,
  or a class-with-no-buffers one for something simpler).

This is the same "shallow auto-scan + `LIST:`/`READ:` for depth"
philosophy `gatherProjectContext()` already uses for the project itself
(see its own doc comment on why full recursive attach used to blow up to
tens of KB) - applying it to binding-specific reference material that
currently has no equivalent discipline at all.

## 5. Is "KB sent to the model" a useful metric?

Partially, but as a **budget/smell-test, not an optimization target in
itself.** Two supporting reasons:

- Cutting `quickjs.h` from 1041 lines to an 80-line curated excerpt is a
  ~13x reduction that also happens to be a *quality* improvement (higher
  signal-to-noise, less chance of the model latching onto an unrelated
  API it noticed in the header). That's the good case: size and quality
  point the same direction because the cut is curation, not truncation.
- But minimizing raw bytes as the goal itself would reward the wrong
  thing - e.g. truncating `point.c` to save space would remove exactly
  the ownership/lifecycle detail (§1) that's the point of attaching it.
  A shorter but incoherent excerpt is worse than a longer coherent one.

Concretely: track context size as a **diagnostic**, not a goal - `/context`
(added this session, `repl.js`) already reports message count and can
report byte counts too (cheap to add: sum of `content.length` across
`messages`); worth watching per-session to catch a regression (an
attachment ballooning back up) without chasing a target number. A
reasonable informal ceiling for a binding-writing session's *startup*
context (system prompt + project scan + auto-attached binding material,
before any model-requested `READ:`): **under ~15KB**, roughly what
today's `quickjs.h`-alone attachment already costs by itself - so the
proposal in §4 is a wash on size but a large win on curation.

## 6. Make the model design the JS API before writing C

Neither the current system prompt nor the README demo asks the model to
decide *what the JS-facing surface should look like* before implementing
it - it jumps straight to "write the binding." For zlib specifically,
there's a real design decision to make (return `ArrayBuffer` or
`Uint8Array`? accept a `string` or require a `TypedArray`? sync-only,
given `compress2()`/`uncompress()` are both bounded, blocking C calls
with no natural async boundary?) that a human would settle before typing
`JS_NewCFunction`. Proposed addition to the system prompt's existing
"writing a new native (C) QuickJS binding" paragraph: ask for a one- or
two-line API sketch first (e.g. `deflate(data: ArrayBuffer|Uint8Array):
ArrayBuffer`, `inflate(data, expectedSize?): ArrayBuffer`, `crc32(data):
number`) as plain text before the `File:` block - cheap, catches a bad
API shape before C code is generated for it, and gives the human a
checkpoint to redirect at (same reasoning as this project's own "ask
before implementing" convention).

## 7. Zlib worked example, grounded in the real header

Checked against `/usr/include/zlib.h` on this box - these are real,
bounded (non-streaming) signatures, deliberately the easy case (no
`z_stream`/inflate-loop state machine):

```c
int compress2(Bytef *dest, uLongf *destLen, const Bytef *source, uLong sourceLen, int level);
uLong compressBound(uLong sourceLen);   // upper bound on compressed size - allocate dest with this
int uncompress(Bytef *dest, uLongf *destLen, const Bytef *source, uLong sourceLen);
uLong crc32(uLong crc, const Bytef *buf, uInt len);
```

A reasonable resulting design (what §6 should produce): `crc32(data):
number` (trivial - one call, no allocation), `deflate(data):
ArrayBuffer` (`js_malloc` a buffer sized `compressBound(len)`, call
`compress2`, wrap the *actual* compressed length - not the bound - in a
`JS_NewArrayBuffer` with `js_free_rt` as the free func, same pattern as
`quickjs-arraybuffer-sink.c`'s `METHOD_FLUSH`), `inflate(data,
expectedSize): ArrayBuffer` (uncompress needs the caller to know/guess
the output size up front - a real API wrinkle worth the model noticing
and asking about, or defaulting to a documented "guess, retry larger on
`Z_BUF_ERROR`" strategy).

## 8. Verify fast, standalone - don't route through this project's own build

The README demo currently tells the model to verify via *this project's*
`CMakeLists.txt`/`build/` machinery. That's almost certainly implicated
in why the one live attempt never returned (see `BUGS` entry linked
above) - it entangles a tiny standalone module with qjs-lws's own full
native build (libwebsockets, multiple translation units, a
minutes-long link step) for something that doesn't need any of it.

Verified directly, right now, as the actual fix: a standalone module
needs nothing project-specific -

```sh
gcc -shared -fPIC -I<quickjs-source-dir> -o crc32-binding.so crc32-binding.c -lz -DJS_SHARED_LIBRARY
qjsm -e 'import("./crc32-binding.so").then(m => console.log(m.crc32("hello")))'
```

confirmed working end to end with `point.c` itself (compiled standalone,
`new Point(3,4).norm()` returned `5`, no CMake involved). The demo
(README.md) and the system prompt's build-verification guidance should
both point at this instead - much faster, and isolates whether the
*binding* is correct from whether qjs-lws's own build happens to be
green that day.

## 9. Concrete next steps (not yet implemented - this file is the plan)

1. **Done.** `examples/ollama-repl/reference/quickjs-binding-api.md`
   (§3's curated excerpt) - grouped by concern, signatures checked
   directly against this box's own `quickjs.h`.
2. **Done.** `lib/binding-context.js` (new file) does the auto-attach:
   `looksLikeBindingPrompt()` (§4's keyword heuristic, resolved as "both"
   per the open question below - it also backs the explicit `/binding
   <prompt>` REPL command in `repl.js`, which forces the same attach
   regardless of what the heuristic thinks) and `bindingContext()`
   (reads `fib.c`/`point.c`/the cheat sheet, formatted the same way
   `attachFiles()` formats a user file reference).
3. **Done.** `/context`'s summary line (`repl.js`) now reports
   `messages.length` *and* a total char count (`totalChars()`) alongside
   the existing per-message breakdown.
4. **Done.** The system prompt's "writing a new native (C) QuickJS
   binding" paragraph (`repl.js`) now asks for the JS-API sketch first
   (§6) and points verification at the standalone `gcc -shared -fPIC`
   recipe (§8) instead of this project's own `CMakeLists.txt`/`build/`.
5. **Done.** README.md's demo walkthrough now describes the zlib
   `deflate`/`inflate`/`crc32` design from §7, the auto-attached
   reference material, `/binding`, and the standalone build/smoke-test
   recipe - replacing the old, still-unverified crc32-only version.
6. **Not done.** Re-running the live demo needs a reachable Ollama server
   or a valid `GEMINI_API_KEY`, neither available in the environment this
   work was done in (same gap noted in `TODO.md` item 4a). What *was*
   verified directly, standalone, without either provider: `point.c`
   compiles and runs correctly via the exact `gcc -shared -fPIC ...`
   recipe now in the system prompt/README (`new Point(3,4).norm() ===
   5`), `bindingContext()` successfully reads and formats all three
   reference files, and `looksLikeBindingPrompt()` matches/rejects
   correctly on sample prompts. The one open question this step was
   meant to close - whether the smaller, curated startup context fixes
   `BUGS: ollama-native-binding-demo-never-replies` - is still open; it
   needs a live model to answer.

## Open questions for a human to weigh in on

Resolved: **both** - the heuristic auto-detects (§4), and `/binding
<prompt>` (a REPL command, `repl.js`) forces the same attach explicitly
regardless of what the heuristic decides, so neither has to be "the one"
mechanism. The cheat sheet (§3) is markdown (`reference/
quickjs-binding-api.md`) - the recommended option, prose + snippets
read naturally in a chat transcript; a compilable `.h` excerpt wasn't
built (readability in-context mattered more here than "compiles as a
sanity check", and the signatures were checked against the real header
directly instead).
