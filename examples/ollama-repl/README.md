# ollama-repl

A small Claude-Code-style REPL for chatting with a local [Ollama](https://ollama.com)
model (`qwen2.5-coder` by default) about the files in your project. It also
works against Gemini, any OpenAI-compatible endpoint, and - through
`examples/chat-bridge` - the free chat websites (DeepSeek, Mistral, Qwen, ...)
driven in your own browser (`--provider bridge`).

- **Dedicated HTTP client.** `lib/ollama-client.js` talks to Ollama's
  `/api/chat` endpoint directly through the `httpClient` protocol adapter
  (`lib/lws/protocols.js`) - the same building block `fetch()` uses - with
  its own `LWSContext`. Each prompt opens its own fresh connection rather
  than reusing one across turns - see BUGS:
  h1-late-queued-pipeline-never-promoted for why.
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
  `/reset` clears conversation history but keeps this initial scan; `/clear`
  wipes it too, for a session with no scan at all.
- **Session persistence.** The conversation is saved to `<model>.json`
  (`lib/session-store.js`) after every turn and after `/reset`/`/clear`. If
  that file already exists at startup, the REPL resumes from it instead of
  running the automatic project scan again - kill and restart the REPL
  (same `--model`, same working directory) and the conversation picks up
  where it left off. `/clear` (see above) is the way to discard a resumed
  session and start over.
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
  terminal, and across runs (opened in append mode). This is a read-only
  transcript; `<model>.json` (see "Session persistence" above) is the
  actual resumable conversation state.
- **Thinking indicator.** A small animated spinner (cycling through the
  four Unicode quadrant-block glyphs) shows while waiting on the model,
  replaced by the reply the moment the first token (or the whole
  non-streamed reply) arrives; a dim line like "Made it so in 3.2s"
  follows once a turn is fully done. Instead of "Thinking..." the spinner
  tells nerd jokes from Star Trek, Monkey Island, Discworld and the
  Indiana Jones games (`lib/quips.js`), a new one every 4 seconds, picked
  by phase: "Hailing frequencies open" while sending, "Look behind you, a
  three-headed monkey!" while waiting, "Using the rubber chicken on the
  problem" while a tool runs. In the TUI the facts follow the joke. All three clients cap how long it can
  spin: `timeoutSecs` (15 minutes by default - see `DEFAULT_TIMEOUT_SECS`
  in `lib/ollama-client.js`/`lib/gemini-client.js`/`lib/openai-client.js`)
  bounds both the initial wait for a reply to begin and, separately, any
  gap between chunks once a streamed reply is under way - a connection
  that goes silent past that window is force-closed and the turn fails
  with a clear error instead of leaving the spinner running forever.

## Using `OllamaClient`/`GeminiClient`/`OpenAIClient` directly

`lib/ollama-client.js`, `lib/gemini-client.js` and `lib/openai-client.js`
are all usable on their own from a `qjsm` REPL, independent of `repl.js`'s
own chat loop - handy for poking at a model manually, or for driving real
API-native tool/function calling, which `repl.js`'s own `LIST:`/`READ:`/
`RUN:` loop doesn't use (that loop is a plain-text protocol parsed out of
the reply body, not any provider's actual tool-calling API). See `API.md`
for the full design and more examples; short version:

```js
import { OllamaClient } from './lib/ollama-client.js';
// or: import { GeminiClient } from './lib/gemini-client.js';
// or: import { OpenAIClient } from './lib/openai-client.js';

const client = new OllamaClient({ model: 'qwen2.5-coder' });
const { content } = await client.chat([{ role: 'user', content: 'hi' }]);
console.log(content);
```

`chat()`/`chatStream()` accept a `tools: [{ name, description, parameters
}]` option (`parameters` a JSON Schema object) and return `{ content,
toolCalls? }` - `toolCalls` (`[{ id, name, args }]`) is present whenever the
model asks to call one. Feed the result back as a `{ role: 'tool', name,
content }` message to continue the exchange - same message shapes work
against any of the three clients. `API.md` has a full round-trip example.

## Requirements

- `--provider ollama` (the default): a running Ollama server with the
  model pulled:
  ```sh
  ollama pull qwen2.5-coder
  ```
- `--provider gemini`: `GEMINI_API_KEY` exported in the environment (a
  free-tier key from https://aistudio.google.com/apikey works).
- `--provider openai`: `OPENAI_API_KEY` exported in the environment (a
  key from https://platform.openai.com/api-keys), or set `opts.apiKeyEnv`
  to use a different environment variable for other OpenAI-compatible
  providers (Mistral, Together, Groq, local servers, etc.).
- `--provider bridge`: a Chrome/Chromium started with
  `--remote-debugging-port=9222`, logged in to the chat sites you want to
  use; see [Using the chat sites (`--provider bridge`)](#using-the-chat-sites---provider-bridge).
- `lws.so` built (see the repo root's build instructions).

## Run

```sh
qjsm examples/ollama-repl/repl.js [--provider ollama|gemini|openai|freellm|bridge] [--model NAME] [--host localhost] [--port 11434] [--root .] [--stream] [-x [-x]] [--failsafe] [--no-tui]
        [--num-ctx N] [--think [MODE]] [--temperature T] [--max-rounds N] [--yes]
```

(`qjsm`, not `qjs` - the REPL's service loop needs `os`/`std` available as
globals, which `qjsm` does by default; plain `qjs` needs `--std` for the
same effect.) Once installed (see the repo root's `CMakeLists.txt`), it's
just `ollama-repl [...]` from `bin/`.

`--root` is the project directory file references and writes are resolved
against - defaults to the current directory.

`--model list` prints the chat-capable models the API key can use (name,
token limits, display name) and exits with `--provider gemini`; with
`--provider ollama` it prints the output of `ollama list`; with
`--provider openai` and `--provider bridge` it lists the endpoint's
`/v1/models`.

`--num-ctx` (default 16384) is the context window asked of Ollama - its own
default is 4096 tokens, which the project scan plus a couple of attached
files already fills, and it then truncates silently (empty reply,
`done_reason: "length"`; the client now reports that as an error).
`--think [MODE]` (ollama only) sets the `think` field: `detect`
(default: true when `/api/show` lists the "thinking" capability, else
false; re-checked after `/model`), on, off, `auto` (field omitted, the
model's own default applies) or low|medium|high. A model that cannot
think rejects `on`. The reasoning text is not
shown, only the answer.
`--temperature` (default 0.2) keeps edits repeatable. `--max-rounds`
(default 40) caps tool-calling rounds per prompt. `--yes` runs
`run_command` without asking.

## Using the chat sites (`--provider bridge`)

```sh
qjsm examples/ollama-repl/repl.js --provider bridge [--model deepseek] [--cdp-host 127.0.0.1] [--cdp-port 9222]
```

Starts `examples/chat-bridge` itself on a free port (an OpenAI-compatible
endpoint that types your prompts into the chat websites open in the
browser) and talks to it with the OpenAI client; the bridge is stopped on
exit. Without `--model` the models (one per site) are used in turn, so load
spreads over the free tiers. The browser is not started for you. Details,
the site table and per-site quirks: `../chat-bridge/README.md`,
`../chat-bridge/PROVIDERS.md`.

- **Automatic failover.** On `auto` / `auto:AXIS` the bridge routes by
  itself (next site, transcript replayed, see `../chat-bridge/README.md`). For
  a site pinned by name: when it hits its message limit, asks you to
  log in, or does not take the prompt, the turn is retried on the next
  available site (one line says so; never `auto`). The conversation is compacted first
  (`lib/handoff.js`): system prompt and project scan kept, the last
  `--handoff-turns N` (3) user turns kept with big tool results clipped,
  older turns summarized by a small local model (`--handoff-model`,
  default `qwen3:4b-instruct`, needs a running ollama; without it a plain
  digest is used). `--no-handoff` replays everything, `--no-failover`
  stays on the chosen model. Failover only applies when the endpoint is a
  chat-bridge (`gateway.isBridge`). When `auto` itself ran out of sites, the
  round runs `/model skip` by itself instead (see `/model skip`).
- **No tools, files as text (`--no-tools`).** For sites that ignore tool
  calls: the files named in the prompt are attached as text and the model
  answers with whole `File: path` blocks, which are written to disk. deepai,
  duck and chatgpt fixed the small slugify task this way. With
  `--provider bridge` the system prompt is a short one and the project scan
  is skipped (`--scan` brings it back), because some sites cap a message
  (duck.ai: 16000 characters).
- **Billing guard.** Pay-as-you-go sites (openrouter) are skipped unless
  `--allow-paid` is given.
- Tool calls are emulated in text by the bridge; DeepSeek, Mistral, Qwen,
  Gemini and Kimi passed a small coding task, ChatGPT, duck.ai and DeepAI
  answer chat but do not use the tools (see PROVIDERS.md).

## Free models through freellmapi (`--provider freellm`)

[freellmapi](https://github.com/tashfeenahmed/freellmapi) is an
OpenAI-compatible router over the free tiers of many providers. It picks a
model per request and falls over to the next one on a 429 or 5xx.

```sh
export FREELLMAPI_KEY=freellmapi-...   # FREELLMAPI_URL too when it is not on localhost:3001
qjsm examples/ollama-repl/repl.js --provider freellm [--model auto|auto:fast|auto:smart|<model id>]
```

`--provider freellm` is the OpenAI client with these defaults:
- base URL: `FREELLMAPI_URL`, else `http://localhost:3001/v1` (not `OPENAI_API_URL`, which
  may name another OpenAI-compatible service);
- key: `FREELLMAPI_KEY`, else `OPENAI_API_KEY`;
- model: `auto`.

`--provider openai` finds a gateway too: at startup the REPL asks
`/v1/usage`, and a freellmapi answers it. If no `--model` was given, the
model then becomes `auto`.

Each request records what the gateway says about it. The line under every
reply names the model that actually served it:

```
Engaged at warp 9 in 3.2s - auto:fast -> kilo/nvidia/nemotron-3.5-lightning:free, 2.3k+539 tok, 503 reasoning, 2.1k cached, 3.2s
```

| Command | Shows |
|---|---|
| `/last [N]` | Everything about the last request, or request #N of `/requests`: requested model, served model, routed platform/model (`X-Routed-Via`), upstream provider, request id (`X-Request-ID` = `execution_id`), HTTP status, finish reason, prompt/completion/reasoning/cached tokens, cost, time to headers / first token / end, failed hops before it (`X-Fallback-Attempts`, `-Trail`, `-Detail`), compression, cache, rate limit left |
| `/requests [N]` | The last N (10) requests of the session, one line each |
| `/usage` | Session totals, then a table per routed model and per platform |
| `/gateway usage` | The gateway's month across all clients: requests and tokens per platform and key, with caps |
| `/gateway providers` | Health of every upstream platform (healthy, rate limited, cooldown end, invalid key) |
| `/gateway forecast` | Request quotas the providers reported, low balance, reset time |
| `/gateway quota [FILTER]` | Per-model quota windows (requests/min, requests/day, tokens/min used vs limit) and monthly token budget, the models used today first (needs a dashboard session, see below) |
| `/gateway models [FILTER]` | Models a request can use right now, with context window |
| `/status` | Also the last route and the session's token totals |

Per-model quotas live only in freellmapi's dashboard API. Give ollama-repl
a dashboard session to see them, in `/gateway quota` and in the status
line:
- `FREELLMAPI_DASHBOARD_TOKEN`: a session token, valid for 30 days;
- or `FREELLMAPI_EMAIL` + `FREELLMAPI_PASSWORD`, which log in at startup.
- or nothing: at startup ollama-repl asks the browser on `--cdp-host`/
  `--cdp-port` (127.0.0.1:9222) for the token of a logged-in dashboard
  tab. The dashboard keeps it in localStorage. `/gateway login` also
  opens a dashboard tab in the background when none is open. The browser
  must run with a debugging port, for example:

  ```sh
  brave-browser --remote-debugging-port=9222 --remote-allow-origins='*' \
    --user-data-dir="$HOME/.config/BraveSoftware/Brave-debug" http://localhost:3001
  ```

  Recent Chromium builds ignore the port on the default profile, hence the
  separate `--user-data-dir`. Log in to the dashboard once in that
  profile.

Without a session, the quota shown is the gateway's month total
(`/v1/usage`) and its per-minute rate limit.

Streams ask for a final usage chunk (`stream_options.include_usage`), so
streamed replies have token counts too. `/last` lists every `x-*`
response header and the raw `usage` object, so nothing the gateway
reports is lost. Other OpenAI-compatible servers
also get these records, with whatever they report (usually `model` and
`usage`). Failed requests are recorded with their error. The dashboard's
per-request attempt ladder (`/api/analytics/requests/:id`) needs a
dashboard login, so it is not queried.

## Terminal interface (TUI)

On a terminal a model's reply starts with a small beach scene in the
theme gradient, `≋≈☼` (waves rising into the sun), instead of the old
`provider>` prefix; piped output (scripts, `ollama-repl-ctl`) keeps
`provider> `. Status notes of newer features start with a teal `≋`
(`waveNote()` in `lib/look.js`).

On a terminal, ollama-repl keeps its input and three status rows at the
bottom of the screen, in its own teal-to-amber look (`lib/tui.js` for
the layout, `lib/look.js` for the style, both on qjs-modules' `terminal`
widgets):

```
 ▄▀▀▀▄ █     █     ▄▀▀▀▄ ...           ╭─ about ─────────────────────────╮
 █   █ █     █     █▀▀▀█ ...           │ version   qjs-lws fb78c9f ...   │
                                       │ model     freellm/auto          │
● session initialized                  ╰─────────────────────────────────╯
Tips for getting started: ...
> read a.txt and list its content
● read_file a.txt
  ⎿ 2 lines, 4 chars
freellm> The content of a.txt is:
• bye
── ▘ Consulting the Librarian (ook)… · waiting for the model 3s ── (gradient)
auto> _
────────────────────────────────────────────────────────── (gradient)
 edits  ~/src/x        dots-3-note-preview:free via AtlasCloud     ctx ██······ 21% 44k/205k
last 1.4k+66 · session 2 req 3.0k tok · req/min ██·· 3/10 · gateway ██▋· 65% of 641M · Shift-Tab mode
```

- At startup: the name in block letters, an about panel (version = git
  commit, model, endpoint, gateway, mode, root, session name, log), and
  tips. `/about` shows it again.
- The rule above the input shows the spinner and the elapsed time while
  the model works.
- The status rows:
  - the mode as a badge and the project directory;
  - the model that actually answered, as the provider reported it, with
    its upstream host and the model name sent;
  - a context meter against that model's window (dashboard model table
    or `/v1/models`, `--num-ctx` for ollama);
  - last and session tokens, the per-model quota as small meters
    (requests/min, requests/day, tokens/min, month budget; needs a
    dashboard session), the gateway's month budget and rate limit,
    fallbacks;
  - `verbose` and `remote:NAME` while those are on.
- Replies are rendered markdown, line by line as they stream: headings,
  lists, quotes, tables, inline code, and code blocks in a frame with
  strings, numbers, comments and keywords colored.
- A tool call is one line (`● read_file a.txt`) with its result below
  (`⎿ 31 lines, 231 chars`). A file change shows as a panel with the
  file's line numbers, - lines red and + lines green.
- The output of every `/command` is a panel titled with the command line,
  red when it reports an error. `/help` is a sectioned panel. Pipes and
  `ollama-repl-ctl` clients get the plain text as before.
- Panels are at most half the screen high. The full text of every panel
  is kept: `/view N` opens panel N (the last one without N) in a
  full-screen pager on the terminal's alternate screen. Keys: arrows and
  j/k, PgUp/PgDn and space, Home/End and g/G, the mouse wheel; q (or Esc
  Esc) goes back. Output that arrives meanwhile waits and appears after it.
- The transcript scrolls back: PgUp/PgDn and the mouse wheel. The TUI
  keeps the last 10000 lines itself, because the terminal (and tmux) do
  not keep lines that scroll out of the transcript area. While scrolled
  back the rule says how far, new output is kept but not shown, and any
  other key returns to the end. The wheel needs mouse reports, which are
  on by default: select text with Shift-drag then, or turn them off with
  `/mouse off`.
- Approvals are dialogs. The change (or command) is shown in a yellow
  panel, then a choice in the input rows: ↑/↓ and Enter, a digit, y for
  the first and n (or Esc Esc, Ctrl-C) for the last, v shows the whole
  change in the pager:

  ```
  ? Apply this change?
    ● Yes, allow once
    ○ Yes, allow edit_file for the rest of this session
    ○ No
  ```

  "for the rest of this session" stops asking for that tool (or for every
  command). A line sent over the control socket answers a dialog the same
  way (a number, y or n).
- Shift-Tab (or Alt-Tab, if the window manager passes it on) cycles the
  mode: plan, auto, manual, edits. `/mode NAME` and `--mode NAME` set it.

  | mode | file changes | run_command | tools |
  |---|---|---|---|
  | plan | refused | refused | read-only: list, read, grep, ask. The prompt asks for a plan |
  | auto | run | run | all (same as `--yes`) |
  | manual | asks first, with a diff | asks first | all |
  | edits (default) | run | asks first | all |

- The rule above the input says what is happening: sending the request
  (its size), waiting for the model, waiting for the first token,
  receiving or streaming the reply (chunks, rate, bytes), receiving a tool
  call, running a tool, waiting for you.
- `/split [diff|git|status|off]` opens a pane right of the transcript
  (80 columns at least): `diff` this session's file changes, newest first,
  as numbered diffs; `git` the project's `git diff`, refreshed after each
  turn; `status` the live state - the phase, the current request (route,
  bytes out and in, chunks, time to headers and first token, proxied),
  the sockets the process owns with the traffic over each (`ss`), memory
  and descriptors, refreshed every second. `/split` alone toggles.
- `/proxy` reports the socks proxy the gateway sends upstream requests
  through (here the anon service): its settings, bypassed platforms,
  per-key proxies, the latency it adds and the time to first byte per
  platform in this session. `/proxy probe` measures it (curl to an LLM
  host, direct and through the proxy, median of 3), `/proxy exit` asks
  for a new exit (`tor-change-exitnode.sh`), shows the exit address
  before and after and measures again. The status rows show the measured
  overhead (`proxy +430ms`), `/last` whether a request was proxied.
  `/proxy off` and `/proxy on` switch the global proxy of the gateway
  (dashboard setting `enabled`, the URL stays saved, effective for the next
  request; needs a dashboard session, also works through `ollama-repl-ctl`).
- `/gateway limits [FILTER]` and `/gateway limited [FILTER]` (dashboard
  session needed) say what the gateway limits: per provider row the
  requests and tokens used of each period (minute, day, month budget) and
  what stops it now - a minute or day window, the monthly budget or a key
  cap, a cooldown (exact end), a key without credits or outside the model's
  scope, and cooldowns whose errors point at the IP or region (marked
  `IP limit?`: `/proxy exit` or `/proxy off` may lift them). The gateway
  only says a model is exhausted; the end is worked out from the key
  cooldowns, the windows (a minute window frees within 60 s, a day window
  within 24 h, shown `<=`) and the budget (start of the next UTC month). A
  key scope never ends by waiting. `/model list` is one line per model (it fits the window: below 72 columns the strength column goes, below 56 the provider too) and shows the real providers
  behind each model id and moves the limited models to a second table with
  their return time; models the gateway has no key for (or that are disabled) are hidden, `/model list all` appends them; they get no number, a glob skips them and
  `/model NAME` refuses them with the reason.
- `/standby` (`--standby` starts it on, freellmapi gateway only) keeps a
  second model warm: the one the gateway would use after the current one
  (its routing scores, best first, only models that are enabled, keyed and
  not limited, see `/gateway limited`). It is probed in the background after
  turns, at most every 10 minutes, with one small pinned request that offers
  a `ping` tool, so it shows whether the model answers, how fast and whether
  it can call tools (a model that fails its probe is set aside for 10
  minutes and the next one is tried). `/standby switch` takes it over at
  once, `/standby MODEL` pins a choice, `/standby auto` unpins, `probe`
  refreshes now. When the current model fails with a limit or an outage
  (429, 5xx, dead connection) the turn is retried on the standby by itself,
  with a note. `spawn_agent` with `model: "standby"` runs a sub-agent on it.
  The status line shows `standby MODEL ✓ 3.1s`. The probes use the
  gateway's free quota, so it is off unless asked for.
- Global configuration lives in `~/.config/ollama-repl/` (`$XDG_CONFIG_HOME`
  honoured): `settings.json` holds defaults for command-line options
  (provider, model, mode, compactAt, standby, ...; a command-line option
  wins), `delegates.json` what the sub-agent models did. `/config` shows
  saved and current values, `/config set KEY VALUE` and `/config unset KEY`
  write the file (used by the next start).
- Delegation: unless `--no-delegate` or `/delegate off`, the primary model's
  system prompt says it may hand documentation, build-system wiring,
  summaries and simple repetitive jobs to weaker sub-agents
  (`spawn_agent`, with `kind` docs|build|summary|repetitive). With no model
  named the harness chooses: candidates are discovered (the gateway's
  enabled, usable, tool-capable models that are reliable and fast but not the
  strongest, or the installed Ollama models no stronger than the primary),
  plus the ones set by hand (`/delegate add MODEL [KIND..]`, `pin KIND MODEL`,
  `ban`), ranked by a memory in `delegates.json`: per model and kind the runs
  that finished and answered, those that failed or came back empty, the
  mean time and your votes (`/delegate good|bad` rates the last run). One
  lucky run does not win (a prior), an untried model gets tried now and then,
  and a model that fails three times in a row for a kind is left out of it
  for a day. `/delegate` shows the ranking per kind and the memory.
- Delegation to another instance: `ollama-repl --worker --provider gemini
  --root .` starts a worker (it listens like `--listen`, is named
  `worker-PROVIDER`, never delegates itself). A session on the same project
  root finds workers through the control sockets (the protocol of
  `ollama-repl-ctl`) and counts them among the delegates, tried first: the
  task goes in as one input line after a `/reset` (so every task starts
  clean), what the worker prints until it is idle again is the answer (spinner,
  echo and timing lines removed), a read-only task runs with `/mode plan`.
  A worker that is busy or waits for an approval at its own terminal is
  reported to the primary, not counted against it. Any other live session
  can be named by hand: `spawn_agent` with `model: "peer:NAME"` or
  `/delegate add peer:NAME` (no `/reset` then: it keeps its conversation).
  `/delegate` lists the workers it found. Workers run their own provider,
  model, tools and approvals, so a Gemini or a local Ollama instance can do
  the documentation while the primary stays on the gateway.
- Tab completes the arguments of the commands too, not only file names:
  `/mode pl` -> plan, `/proxy`, `/verbose`, `/stream`, `/mouse` (on, off,
  probe, exit), `/split`, `/provider`, `/gateway` subcommands, `/model` (list,
  all, skip, unskip and the model names), `/fallback`, `/route` (axes and
  models), `/standby`, `/delegate` (verbs, model names, kinds), `/config set`
  (the setting names, then true/false, the mode or the provider names),
  `/skill` (skill names), `/system` (default, file, off), `/help` (command
  names). The model names are the ones that can be chosen now: the gateway's
  ready ones (limited and unavailable models are left out), the host's or the
  endpoint's list. `/cd`, `/run`, `/each` and unknown commands still complete
  file names.
- Tab completion of a `/command` shows what Tab would add, dark grey after
  the cursor (`/gat` -> `/gat`**`eway`**): the part all matching commands
  share, nothing when they differ at once (`/mo`: mode, model, mouse). The
  same hint shows for an argument (`/mode pl` -> `an`).
- `/skill` lists the skills found in `~/.config/ollama-repl/skills/` (its
  own; a directory with a `SKILL.md`, or a plain `NAME.md`) and
  `~/.claude/skills/` (the Claude Code ones, symlinks followed; the first
  directory wins on a name clash). `/skill NAME` puts the skill's text (the
  front matter dropped, cut at 30000 characters) into the conversation as a
  message that names its file, so the model follows it and can read the
  files next to it; `/skill NAME request...` then answers the request as a
  normal prompt. A name may be abbreviated when it is unique, Tab completes
  it. `/skill loaded` and `/skill off [NAME]` show and unload (loading again
  replaces the old copy). A loaded skill is part of the conversation: it
  survives `/restart` and is summarized by a compaction like any message.
- While the model works, a line you type is queued behind it - except the
  commands that only flip a flag or show something, which act at once and
  print beside the running reply: `/verbose`, `/proxy` (show, on, off),
  `/mode`, `/help`, `/status`, `/usage`, `/last`, `/requests`, `/tools`,
  `/about`, `/gateway` (the reports), `/standby` (show, off), `/delegate`
  (show, on, off), `/config` (show), `/skill` (list, loaded), `/rename`. Their
  output goes straight into the transcript, not into a panel (a panel
  captures stdout and would swallow the streamed reply). Anything that
  changes the conversation (`/model`, `/clear`, `/compact`, a prompt, ...)
  still waits its turn, and piped input keeps its order.
- Ctrl-O (or `/verbose`, `--verbose`) shows everything the model gets and (in the TUI, for the past of the session too: the panels are always kept, hidden, and a toggle redraws the transcript, the compact tool lines going away while it is on)
  says, each in its own panel (the reasoning panel shows always, not only here): the messages new since the last request
  (system prompt, project scan, prompts, tool results, roles colored),
  every tool call with its arguments and its full result,
  and every response with all gateway headers.
- You can type while the model works. The text stays in the input, and
  Enter queues it behind the running prompt.
- The input grows to several rows for a long line.
- Esc or Ctrl-C cancels the running request (the status line says `Esc cancels`; a lone Esc with nothing running is ignored). A terminal sends a lone Esc as one byte and arrows and Alt-keys as one whole sequence, which is how the two are told apart; a sequence split by a slow link right after its ESC byte would count as an Esc press. On an empty line, pressing it
  twice quits.
- Ctrl-L clears the transcript. Resizing the window redraws the bottom
  rows.
- `ask_user` answers are typed in the input, and the answer is echoed
  into the transcript.

The TUI is on only when stdin and stdout are both terminals. A pipe gets
the plain line mode described below; there approvals are a numbered
question answered with a number, y or n. `--no-tui` keeps the old
scrolling output on a terminal. Tab-completion lists and `/js` output are
written by the base REPL and do not go through the transcript.

The TUI needs a qjsm built from qjs-modules after 2026-11-19 (its
`terminal` module gained the widgets used here).

### Colours in verbose mode

Ctrl-O (`/verbose`) shows the raw content in colour (`lib/rawcolor.js`, in
the theme palette). The colouring only adds colour: with the escape
sequences removed the text is exactly what was sent or received
(`test-rawcolor.js`, run by `smoke.sh`).

- **request panel**: the system prompt dim, every other message by what its
  lines are: a JSON document (keys teal, strings lime, numbers amber,
  `true`/`false`/`null` violet), fenced code highlighted, `File: path`
  headers, diff lines (`+` green, `-` red, `@@` violet), grep lines
  (`path:line:`), error lines red, and the `[handoff]`/`[compacted]` notes
  violet. The calls of the assistant show their arguments as coloured JSON.
- **tool call panel**: the arguments as `key: value`; a text with line
  breaks (an edit's old and new text, a file being written) is a block of
  highlighted lines under its key, not one line of `\n` escapes.
- **tool result panel**: the same colouring, a file read by `read_file`
  highlighted as code.
- **response panel** (gateway): keys dim, the status by class (2xx green,
  4xx amber, 5xx red), routes teal, numbers with their units amber, the
  `x-*` headers violet.
- **reasoning**: dim italic.
- On a terminal without the TUI (`--no-tui`) tool results are coloured the
  same way; piped output stays plain.

## Coding work

Tools the model has: `list_directory`, `read_file` (optional line range),
`grep`, `insert_above`, `edit_file`, `write_file` (all confined to the
project root; `/undo` restores what the last prompt changed, `/diff` shows
`git diff`), `for_each`, `run_command`, `ask_user`.

`/cd DIR` changes the project directory the model works in mid-session
(`~`, `~user`, quotes, and `-` for the previous directory; Tab completes
directories, also below `~/` and absolute paths) -
file references and writes are resolved against it, `run_command` runs with
it as its working directory, and the project scan (if any) is redone on the
next prompt. It's the in-session equivalent of `--root`:

```
qjsm repl.js --root /path/to/project
# ... later, in the REPL:
/cd ../other-project
```

Repetitive jobs ("a comment above every function in lib/path.h, from
lib/path/<name>.c") work best split up: `for_each` (or `/each` by hand)
runs the same task once per item, each in its own short conversation.
By hand:

```
/each grep -o 'path_[a-z_]*(' lib/path.h | tr -d '(' | sort -u :: In lib/path.h add a 1-2 line comment directly above the declaration of {}, saying what it does. Infer that from lib/path/{}.c (read it first). Change nothing else.
```

`--failsafe` strips out all of the REPL's own scaffolding: no system
prompt, no automatic project scan, no file-ref attachment, no
tool-calling loop, no "File:" auto-write. Each turn is just the
message you typed, sent to the model as-is (conversation history is still
kept across turns) - useful when you want a plain chat against the model
itself, or when the scaffolding is what you're trying to rule out.

`--no-system` drops only the built-in system prompt: tools, the project scan
and file attachment stay. Meant for a controller (Claude Code over
`--listen`) that brings its own: `ollama-repl-ctl send '/system file
PROMPT.md'` sets it, `send /clear` empties the whole context to try again from
scratch. A resumed session's saved system prompt is dropped too.

Three separate logs, not one - each answers a different question:

- `<model>.log` - the conversation transcript (prompts/replies/tool
  calls/files written), always on.
- `-x`/`--debug` (or the `DEBUG` env var set to any non-empty value - not
  a numeric "level", `DEBUG=1` and `DEBUG=anything` behave identically)
  logs every raw request/response - and, with `--stream`, every
  individual streamed chunk - to `<provider>-repl-debug.log` (e.g.
  `ollama-repl-debug.log`; append mode, `inspect()`-formatted, full
  depth) instead of the terminal.
- `TRAFFIC=<path>` (an env var, not a flag) additionally logs native
  socket-level RX/TX traffic for the underlying HTTP connection itself
  (connect/write/read/close), not the request/response bodies, to that
  file - for when the connection rather than the model traffic is what's
  under suspicion. Setting `DEBUG` also prints lws's own error/warning
  lines straight to the terminal, independent of `TRAFFIC`.

## Driving it from a script, LLM or agent (piped mode)

When stdout is not a tty, the underlying qjs-modules `REPL` runs in line
mode (needs a `repl` module with "Piped mode", qjs-modules `doc/js/repl.md`),
and ollama-repl follows it: no escape sequences or colors, no spinner, no
raw tty mode. A controller writes one command or prompt per line and reads
the output up to the next `<model>> ` prompt, which is printed exactly once
each time the REPL is ready for input:

```sh
printf 'what does lib/run-command.js do?\n/status\n' | qjsm repl.js --stream > out.txt
```

- lines run strictly in order; EOF on stdin ends the session only after
  the last line (including a running model request) has finished
- the model's `run_command` approval (`[y/N]`) and `ask_user` (`(answer)>`)
  questions read their answer from the next input line, so a controller
  sees the question, then sends `y`/`n` or the answer text
- `/exit`, Ctrl-D equivalents and `SIGINT` all end the session; the
  session log and saved session are written on the way out

## Sharing a running session (`--listen`)

`ollama-repl --listen [PATH]` opens a unix socket (default
`$XDG_RUNTIME_DIR/o<pid>.s`, short on purpose (a Unix socket path holds 107 bytes at most), a `--listen PATH` longer than that is refused with a message; plus `$XDG_RUNTIME_DIR/ollama-repl/<pid>.json`, directory mode 0700, describing the session) so another process - Claude Code, a
script - can type into the session you are using on the terminal and read what
it prints. It is the same conversation, not a new one: the terminal shows the
remote line, in full and in green, as `[remote]> ...`, then the usual output:
attachments, spinner, the model's reply, tool calls. Anything the REPL adds to
the conversation behind the scenes is shown too: `(nudge: ...)` when it sends
the model back to work, `(added to the prompt: ...)` for the for_each hint.

```sh
ollama-repl --listen --name alpha       # in a terminal (--name: default is the model name)
ollama-repl-ctl list                    # name, pid, model, root, socket of live sessions
ollama-repl-ctl send 'summarize lib/chat-repl.js'   # prints the reply, exits when idle
ollama-repl-ctl -s alpha send /diff     # -s: session name, pid, model fragment or socket path
ollama-repl-ctl watch                   # follow the session's output
ollama-repl-ctl monitor                 # what the model does now: reasoning, answer, tool calls and results, as they happen (--json: raw 'activity' events)
ollama-repl-ctl steer 'use b, not a'    # like Ctrl-X Ctrl-S: goes ahead of the queue, cancels the running request, waits like send
ollama-repl-ctl -s alpha restart        # /restart: smoke test, new process, same conversation; waits until the session is back (exit 1 when refused)
```

A session started without `--listen` can open its socket later with
`/remote-control [PATH]` (like Claude Code's), and close it with
`/remote-control off`. `/rename NAME` renames the session for
`ollama-repl-ctl -s NAME`. The status line shows `remote: NAME` while the
socket is open.

Several sessions can listen at once (each has its own socket); `--name` tells
them apart, a duplicate name gets `-2`, `-3`, ... With no matching session
`ollama-repl-ctl` waits for one to appear (a note on stderr says so, `-t SECS`
bounds the wait, default 600) - it never starts one itself.

`send` exits 0 when every submitted line has been handled, 3 when the session
waits for the user at the terminal, 124 on timeout (`-t SECS`, default 600;
the session keeps working). The wire format (plain input lines, one JSON event
per line out: `hello`, `accepted`, `output`, `waiting`, `ready`) is documented
at the top of `lib/control-socket.js`; `--json` makes `ollama-repl-ctl` print
the raw events.

- The model's `run_command` approval (`[y/N]`) and `ask_user` questions are
  never answerable over the socket: a remote line sent meanwhile is queued
  behind them, and `send` reports exit status 3. Only the terminal user
  approves commands.
- Access is by file permissions only (same user): do not point `--listen` at a
  world-accessible path.
- A remote line sent while you are typing discards your half-typed line.

## REPL commands

- `/undo` - restore every file the model changed while handling the last prompt
- `/diff` - `git diff` of the project
- `/each <cmd> :: <task>` - run `<task>` once per output line of `<cmd>` (`{}` = the item), each in a fresh conversation
- `/reset` - clear the conversation history (keeps the initial project scan)
- `/clear` - wipe the conversation history completely, including the
  initial project scan
- `/exit` / `/quit` - quit (Ctrl-D also works)
- `/help` - list commands
- `/run <command>` - run a shell command yourself, immediately - no model
  round trip, no approval prompt (that's only for the model's own `RUN:`
  requests - see above)
- `/status` - model/connection/session info
- `/model [NAME|list]` - show the model in use; `NAME` switches to another installed model (`ollama list`; never pulls one) and keeps the conversation, the prompt and `ollama-repl-ctl list` follow; `list` shows the installed ones. Also works over `--listen`.
  - `/model list` - table of the available models: number, name (coloured by strength tier, violet strongest to green weakest or unknown; on a gateway the strength column is the gateway's intelligence score in percent, else guessed from the name), provider, strength label, advertised token limits and status. Models on cooldown are left out until it ends.
  - `/model skip [PATTERN]` / `/model unskip [PATTERN]` - put the model in use (or the one the gateway last routed to, or every model matching `PATTERN`) on a 10 minute cooldown and switch to the next best model that is not skipped; `unskip` lifts it. Skipped models are left out of automatic selection. When a gateway answers "All models exhausted" (429 routing_exhausted) or that every route failed upstream (502 upstream_failed, empty completions), the round does this by itself and asks again (up to four skips a round).
  - `/model GLOB` (a pattern with `*`, e.g. `qwen*`) - switch to the first matching model; repeating the same pattern cycles through the matches.
- `!COMMAND` - at the start of a prompt: run the shell command yourself (merged stdout and stderr, shown with a `$` prefix), hand the output to the model as a `run_command` result that names the command, and start a model round at once so the model reacts to it.
- `/export` - export the whole conversation as a plain-text transcript (speaker labels, tool calls inline, nothing clipped): copy it to the clipboard when a clipboard tool is installed, or save it to `<YYYY-MM-DD-HHMMSS>-<session>.txt` in the working directory.
- `/route [list|smart|fast|cheap|reliable|balanced|auto|profile NAME|MODEL|new]` - freellmapi routing control, see [Routing](#routing-through-the-gateway).
- `/compact [N]` - summarize the older turns now and keep the last `N` (default 3) verbatim, see [Compaction](#compaction).
- `/fallback [MODEL|off]` - show, set or clear the fallback model (`--fallback-model`) used when the current one fails.
- `/provider [NAME]` - show the provider; with a name, restart into that provider (see `/restart`) with the conversation kept. `--model` is dropped, the new provider's default applies.
- `/restart` - start a new process with the same command line and the current session (messages, model, mode, fallback model, skip list), in the same terminal.
- `/tools`, `/stream [on|off]` - list the model's tools, show or toggle streaming
- `/mode [NAME]`, `/verbose [on|off]` - see [Terminal interface](#terminal-interface-tui)
- `/usage`, `/last [N]`, `/requests [N]`, `/gateway [usage|status|providers|forecast|quota|models [FILTER]]` - where requests went and what they cost; `/gateway status` probes the gateway and shows which providers answer and how many of their models are not exhausted (also printed at startup), see [Free models through freellmapi](#free-models-through-freellmapi---provider-freellm)
- `/system` - print the system prompt. It can also be changed mid-session
  (`/clear` removes it along with everything else; `--failsafe` starts
  without one, but still never gives the model tools):
  - `/system default` - set it to the full default prompt
  - `/system default N-M` (or `N`) - only lines N..M of the default prompt
  - `/system <text>` - replace it; `/system +<text>` appends a line
  - `/system file <path>` - load it from a file
  - `/system off` - remove it

  `/reset` keeps whatever system prompt is set.
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

## Compaction

A long session outgrows the context window (the status line shows the use
as `ctx NN%`). The older turns are then replaced by one summary, written by
a small local ollama model (`--handoff-model`, default `qwen3:4b-instruct`;
a plain digest of what was asked and which files were touched if it cannot
be reached), and the last `--handoff-turns` turns (default 3) stay verbatim
with long tool results clipped. The system prompt and project scan are
never touched. It is the same code as the failover handoff
(`lib/handoff.js`).

- **Automatic**: before a request, when the estimated use (characters / 3.5
  plus the tool schemas) reaches `--compact-at PCT` (default 80, 0 = off)
  of the context window. The window is known for ollama (`--num-ctx`) and
  behind a freellmapi gateway (the model that answered); elsewhere nothing
  is compacted automatically. After a compaction the conversation has to
  grow by 20000 characters before the next one, so a conversation that
  stays large (one huge recent turn) is not re-summarized every round.
- **`/compact [N]`** does it at once, whatever the use.
- A long transcript is summarized in chunks (12000 characters each, the
  newest ten) and the chunk summaries together, so the start of a long
  session is kept, not just its end.
- Separately, old tool results are replaced by one-line stubs when the
  history outgrows the window (`elideOldToolResults`); it now uses the
  gateway's real window, not `--num-ctx`, which freellm ignores.
- An aborted or failed turn is rolled back by finding its own user message,
  not by an index, so a compaction in the middle of it cannot corrupt the
  history.

## Routing through the gateway

What the gateway reads from a request (freellmapi
`server/src/services/router.ts`, `resolveRoutingChain`): the `model` field
only. `/route` is the short way to set it:

| `/route ...` | model sent | the gateway does |
|---|---|---|
| `auto` | `auto` | its active fallback chain |
| `smart`, `fast`, `cheap`, `reliable`, `balanced` | `auto:smart` ... | every enabled model, sorted by that axis (`/v1/models` does not list these, so `/model auto:fast` was refused) |
| `profile NAME` | `auto:NAME` | a named chain from its dashboard (listed in `/v1/models`) |
| `MODEL` | the model id | exactly that model, **no failover to others** |

- `/route` alone shows what the current setting means, where the last reply
  was served (platform/model, fallbacks before it) and the sticky id;
  `/route list` is the table above with the profiles of your gateway.
- **Sticky routing**: every request carries `x-session-id: ollama-repl-...`,
  an id made at start and kept over `/restart`, so the gateway keeps one
  conversation on one route and can hand context over when it must switch.
  `/route new` starts a new id.
- **No exclusion**: the gateway has no way to say "not this model" in a
  request. `/model skip` while on `auto` therefore pins the next best model
  itself (and says so); `/route auto` hands the choice back.

## Provider failover (bad key, quota, outage, stale model)

When a request fails for a reason a retry cannot fix, the route is put out of
use for a cool-down and the same request (the whole conversation is kept) is
retried on the next candidate, without the user (`lib/provider-fallback.js`,
`chatRound()` in `repl.js`):

| failure | cool-down | what happens |
|---|---|---|
| 401 / 403 (bad key) | 30 min, the whole endpoint | the local Ollama model takes over |
| 404 `model_not_found` / "no longer available" | the model, 12 h in the failover, 10 min in `/model skip` | the gateway skips that model and goes on with the next one |
| 402 / 429 (quota, rate limit) | 5 min | next model, then the local model |
| 5xx, timeout, connection error | 1-2 min | next model, then the local model |

The last resort is a local Ollama model: `--local-model NAME`, else
`qwen3:4b-instruct` if installed, else the first installed one;
`--no-failover` turns the local switch off. A switch is one line
(`openai/auto 401 Invalid API key -> ollama/qwen3:4b-instruct`), also an
event on the control socket (`ollama-repl-ctl monitor`), so it holds for
`ollama-repl-ctl send` jobs too. When every route failed with a limit or an
outage the round waits 30, 45 and 60 s (Esc ends the wait) and tries again
before it gives up with one line naming each route and why. HTTP errors are
one line (`OpenAI HTTP 401: Invalid API key`); the headers and body are
printed only in verbose mode (Ctrl-O). "the gateway ran out of models" skips
only the models of the exhausted providers that the gateway reports as
limited, and says why and when they are back.

### While a request runs

Commands that need no model call (`/context`, `/files`, `/system`, `/cd`,
`/model list`, `/help`, `/status`, ...) act at once, beside the running
request, typed or sent with `ollama-repl-ctl`; they are never queued.
`/model NAME` switches at once, cancels the running request and sends its
prompt again to the new model (the conversation is kept). A steering line
that is only `stop`, `cancel`, `abort` or `halt` (Ctrl-X Ctrl-S,
`ollama-repl-ctl steer stop`, or simply `ollama-repl-ctl cancel`) cancels
the request and is not sent to the model. A streamed request that shows
no first token or reasoning within `--first-token-timeout SECS` (default
90, 0 = off) is cancelled and fails over like an error.

## Sub-agents, restarting and failover on upstream errors

Added overnight on 2026-11-19 (commit 2fcdcc1, which had no description);
documented afterwards, and only read, not run - see TODO.md.

- **`spawn_agent`** (tool): runs a bounded task in an isolated conversation
  and gives only its final summary back to the parent. Arguments: `task`,
  optional `model` (another model for the sub-agent), `max_turns` (default
  10) and `read_only` (when true the write tools, `run_command`, `for_each`
  and `ask_user` are withheld). The status line shows the `sub-agent`
  phase while it runs.
- **`restart_harness`** (tool), `/restart`, `/provider` and **`--resume FILE`**:
  the model (or you) restarts ollama-repl with the same command line and
  the current session (messages, model, fallback model, mode, skip list).
  The new process runs in the foreground, this one waits and exits with its
  status. Safety, since the model may have edited the harness itself:
  - **The source tree**: it is the running one when `smoke.sh` sits next
    to `repl.js`, otherwise the `examples/ollama-repl` found at or above
    the project root (`--root`, `/cd`), so the installed `ollama-repl` run
    from a checkout works on that checkout. The edits, the system prompt
    note and the restart below all concern it; with none found the
    running script is only checked with `--help`.
  - **Check first**: the restart runs `smoke.sh` on the edited source
    tree. A failing check refuses the restart, the running session is
    untouched, and the failure output goes back to the model to fix.
    `smoke.sh` imports every `lib/*.js`, runs `test-rawcolor.js` and starts
    the REPL in a pty (with `--listen`, plus `SMOKE_ARGS`) with a fixed
    command set. An installed copy that is told to restart then runs the
    source tree's `repl.js` and says so (`≋ restarting from the source
    tree ...`).
  - **Fallback**: a copy of what runs (source: `repl.js`, `ctl.js`, `lib/`
    in `examples/.ollama-repl-snap-PID`, the same depth so the relative
    imports resolve; installed: the script and its `lib/` in the control
    directory; removed at exit, stale ones of dead processes purged) is
    run instead, resuming from a backup of the state, when the new process
    exits with an error within 15 seconds.
  - **Edits to the harness ask**: `edit_file`, `insert_above` and
    `write_file` on the source tree's files always ask first, also in
    `auto` mode and under `--yes`, and the answer is never remembered;
    `--self-edit` turns the question off for unattended runs. When the
    project contains the harness (for example `--root` at the repo), the
    system prompt tells the model how: edit in small steps, run
    `smoke.sh`, call `restart_harness`.
  - Every restart leaves the previous process waiting for its child, so N
    restarts mean N `qjsm` processes (QuickJS has no `execve`); they all
    end when the last one exits.
  - Identical tool calls within one turn are answered from the first
    result, but not after an edit or a command ran in between, and never
    for `restart_harness` and `spawn_agent` - so edit, `smoke.sh`, edit,
    `smoke.sh` works.
- **`--fallback-model NAME`**: model to switch to when the current one
  fails; also set with `/fallback`.
- **Failover on upstream failures**: besides rate limits and logins, a
  5xx status, a `timeout`/`gateway_error`/`upstream_error` code or a
  message such as "no response after", "timed out", "502", "503", "bad
  gateway" now counts as a model failure (`Failover.isUpstreamFailure`,
  `lib/failover.js`). The note says "upstream failure" and the model is
  reported as `(MODEL: REASON - skipped for 10m)`.
- **Repeated tool calls**: results of identical tool calls within one turn
  are cached and returned again; rounds made only of repeats withdraw the
  tools (`MAX_REPEAT_ROUNDS`).
- `read_file` returns up to 64 KB (was 16 KB).

## Demo: writing a native QuickJS binding

A worked example of the kind of session this project is meant for -
asking the model to write a new native (C) QuickJS binding, grounded in
this project's own conventions rather than guessed from memory. Works the
same against any provider:

```sh
qjsm examples/ollama-repl/repl.js --provider ollama   # or --provider gemini / openai / bridge
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

## Prompt queue and skipping exhausted providers

- Enter while the model works queues the prompt (`/queue` lists the queue,
  `/queue drop N` and `/queue clear` remove entries; the status line shows `N
  queued`). Ctrl-X Ctrl-S sends the typed prompt now: it goes first and the
  running request is cancelled. The queue is saved with the session (the
  `queue` field of `<model>.json`, and of a restart's resume file) and runs
  again, in order, when the session is resumed.
- When the gateway ends a request with "All models rate-limited ... Attempt
  trail: ...", the next bare `/model skip` skips every model of the
  providers named in that trail, not only the last one.

## chat-bridge as a backend

`Gateway` (lib/freellm.js) answers for both a freellmapi gateway and a
chat-bridge: `/v1/usage` says which one (`source: "chat-bridge"`, `gateway.kind`,
`gateway.isBridge`). For a bridge, `/gateway usage|providers|forecast|models`
work as they are, and `loadAvailability()` (lib/availability.js) builds the same
picture from the bridge's own endpoints: a site is a model and a provider at
once, a site that hit its limit is blocked until its cooldown ends (`/gateway
limits`, `/gateway limited`, `/model list`), its learned request budget stands
in the day window. `gateway.hasLimits` (a dashboard session or a bridge) guards
what needs per-model limits. `/route` works for a bridge (`auto` and `auto:smart|fast|reliable|cheap|balanced`, a pinned site; no named profiles), the session id keeps a conversation on its site, and `--provider bridge` starts on `auto`. Not for a bridge: `/proxy`, `/gateway
login|quota`. The standby and delegation
discovery skip sites that cannot call tools. A plain `--provider openai` against
a bridge URL (`OPENAI_API_URL`) works the same as `--provider bridge`.
