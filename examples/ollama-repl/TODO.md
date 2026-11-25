# ollama-repl TODO (status 2026-11-25)

Only open work is listed here. What is done lives in git history, in `README.md` (user
view) and in `doc/ARCHITECTURE.md` (implementor view). Defects are in `BUGS`.
Tests are in `tests/` (`qjsm tests/test-x.js`, run from this directory) with the installed
`qjsm` (it has `terminal/*` since 2026-11-25; built from
`~/Sources/quickjs/qjs-modules/build/x86_64-linux-gnu`). After every change under `lib/`
run `cmake .` before `cmake --install`. Checks before a commit:
`for t in tests/test-*.js; do qjsm $t >/dev/null 2>&1 || echo FAIL $t; done` and
`node --expose-internals check-names.cjs repl.js lib/*.js` (undeclared and doubly
declared names). Bare test file names in this file mean the files in `tests/`.

## 1. Now

- **Commit the open working-tree changes** (needs the user's explicit OK; the last attempt to commit
  the hop-line files was blocked): the hop line (`repl.js`, `lib/hop-line.js`, `tests/test-hop-line.js`),
  the move of the tests into `tests/` (with `smoke.sh` and the doc paths) and the doc cleanup of
  2026-11-25. Tests pass. The hop line is not seen in a terminal, its colour wiring (`hopText`,
  `modelName`) has no test, and a manual `/model skip` keeps its own notes. Not to be committed:
  the untracked `strace.log*` files (110 MB, safe to delete).
- **Restart the running sessions** so they use the code of Phases 1 to 3 (attempt rows, probe
  budget, rating reliability, exploration order, Tor host).
- **Health plan, what is left** (`doc/HEALTH-EXPERIMENTS.md`):
  - 4.2 after table: a day of traffic on the new code, then `qjsm usage-baseline.js --days 1`
    and fill the "after" column.
  - 3.4 failover prefers a provider with headroom over the biggest one (`/gateway quota`); 3.5
    switch at once on "All models exhausted" for a pinned model; 3.11 the req/day meter
    (openrouter nemotron-3.5-lightning:free 34/50) feeds failover and the automatic exit
    decision. All three change `chatRound` / `/model skip` in `repl.js`: do them after the
    working-tree commit above, and measure against the baseline (kilo share after failures,
    failure run length).
  - 3.10 the quota bar's month budget (584M of 2.3G) vs 876M in `/gateway usage`: which
    tokens does `budget.totalUsed` count (question in `doc/GATEWAY-PROPOSALS.md`).
  - 4.1 left over: the base `nemotron-3.5-lightning` was not testable (cooldown, one provider key
    rejected as invalid); repeat when it is usable.
- **Decisions waiting for the user:** whether kilo (67 to 77 % of the traffic) stays behind
  Tor (22 keys were routed through `socks5://192.168.178.52:9050` by the proxy policy; gateway
  key state, it outlives the harness); who takes the gateway proposals 3.6 to 3.9
  (`doc/GATEWAY-PROPOSALS.md`).
- **Open `BUGS` entries:** `availability-load-uncoalesced-and-429-swallowed`,
  `reasoning-test-never-ran` (`tests/test-rawcolor-reasoning.js` has a wrong import path and no `assert`).
- **Kilo facts to remember** when touching the key spread: Kilo reports no usage per key
  (tokens are JWTs with a `kiloUserId`; analytics break down by user, org, model, provider,
  project); two of the three tokens in `~/Documents/accounts.txt` belong to one user, so the
  keys may share one limit (then spreading over them gains nothing); the three Kilo tokens in
  that file are rejected (INVALID_TOKEN), so `usageAnalytics.getBreakdown/getSummary` was not
  tried. Experiment rule: scripts that talk to the gateway use `FREELLMAPI_URL` and
  `FREELLMAPI_KEY`, never `OPENAI_API_URL` (another service here).

## 2. Never seen live (verification debts)

Everything below is unit tested or run on mock data only. Each needs one real session
(a live gateway, a terminal, a Tor proxy) to be called done.

- **Gateway and routing:** the failover work of 2026-11-24 (Retry-After skips, task-type
  header, trail soft-skip, `/last` trail, turn repair, routing-health segment, early skip
  release); the startup likely-routes list; key restriction `/model key:ID`; `/model health`
  columns; the persisted quota stand-in; `/gateway usage` key spread; the dashboard success
  path (only a refused token and a wrong password were tried).
- **Proxy and Tor:** `autoExit` (every keyless provider exhausted: new exit, at most every
  10 minutes; the gap and the "all exhausted" rule are guesses to tune), `exploreKeylessAgain`,
  the exit-change pane, `/proxy keyless fix` (only pieces: fake control port, direct probe,
  candidate logic), the automatic proxy policy (keyless and multi-key through the proxy, single
  key direct, proxy on exhaustion) and the `SOCKS`/`DIRECT` chips; the PATCH/DELETE key calls
  follow the freellmapi source, not a run.
- **Exploration:** tier 0/1 probes and the diagnosis (the retry cannot pin a provider route, so
  a model that fails through one provider and works through another reads as flaky); takeover
  end to end (`considerTakeover`; only the decision and step helpers are tested); the needles
  are fixed, so a provider that caches prompts may answer from cache (vary them if it shows).
- **Terminal:** the net pane (`/split net`) and its colours, the split pane keys (F2, Alt-n,
  Ctrl-X chords; a terminal may eat F2 or send Meta differently), live panels, tool call
  panels, the `/model` chooser filter and the scrolling picker dialogs, `/brief save`, sync
  frames and the undo at exit, the reply colour `REPLY`, the hop line.
- **Local models:** `/brief` needs a brief built by the local model; Ollama and Gemini
  `onMeta` token counts (`test-client-usage.js`) were never run against a live server, and a
  failed request emits no record for them; `OllamaClient` with `tools` and its streaming
  `tool_calls` path are unverified (the round trip was verified with Gemini and OpenAI only).
- **Agents:** `spawn_agent` with `kind`, the read-only switch, a worker waiting for approval,
  `restart_harness` as a model tool call, the self-edit dialog, SELF_NOTES use by a real
  model, `ask_user` by a live model, the repeat guard `MAX_REPEAT_ROUNDS`, the standby
  switch-over on a real 429/5xx, `ollama-repl-ctl monitor` (`waiting` event, two clients,
  a client that stops reading).
- **Bridge (`--provider bridge`):** names and the context meter in `/model list` (only the data
  was tested), the standby switch-over, strength "unknown" (no scores), `x-ratelimit-*` still
  says "/min" in the status line, a prompt that stopped accepting input after "OpenAI
  connection failed: dropped" (not reproduced; check `/proc/<pid>/fd/0` of the bridge child).

## 3. Gaps and follow-ups, by area

**Gateway failover**
- The provider-fallback 5 minute cool-down (`lib/provider-fallback.js`) ignores Retry-After, and a
  plain "Soonest cooldown reset ~3m" text without the header is not read.
- The trail soft-skip is per model; a platform-wide skip needs the key outcome per platform.
- Availability is not refreshed on a timer: skips are released, and the routing-health numbers
  move, only when `/model list`, `/model skip` or another refresh runs.
- Failover covers `chatRound()` only: a limit in the middle of a streamed reply is not handled;
  when every model is unavailable a hint with the earliest `resets_at` would help.
- After a switch to the local model the next round still starts on the failed client (routed by
  the cool-down); the status line keeps the old route.
- The monthly-quota vs daily-limit split needs a dashboard session; without it the per-provider
  skip of the attempt trail applies.
- A throw inside tool execution itself is untested against `lib/turn-repair.js`.
- The provider fallback and `/handoff-model` are not part of the one next-model order yet.

**Proxy and exit address**
- Tor cookie authentication is not supported (password only); a remote Tor needs an ssh tunnel.
- Tor answers 250 OK to NEWNYM more often than once per 10 s without a new circuit: an exit change
  right after another may keep the circuit.
- A keyless platform the gateway lists only as a provider (no key row) cannot get a proxy.
- Which limits an address change lifts is a guess (windows, cooldown, exhaustion, IP errors).
- `/proxy keyless fix` tests the strongest limited model per provider only; a provider whose other
  models stay limited is reported as working. Its steps are not events yet.
- A keyed provider limited per IP gets a proxy for its key too, which adds the proxy's latency to
  every request of that key. The transient/real split is a regex over the error text.

**Exploration, rating, picking**
- Exploration: only OpenAI-compatible gateways are explored; each model costs 2 requests of free
  quota (tier 0) and the top 30 a 3 to 12k token tier 1; no time-to-first-token (not streamed);
  `/model explore` skips limited models instead of queueing them and has no argument for the tier
  or the concurrency; the explored identity is not used for routing; entries of the older
  three-prompt code count as verified; the live refresh runs only with `/model health`, not on a
  timer; the TCP check connects to the gateway, not to the model's upstream.
- Rating: the weights (55 intelligence, +-25 learned, reliability +-10, latency, probe, state) are
  a first guess, to tune on real use; `/gateway limits|quota|keys` keep their own orders; a route
  that is not a catalog id gets a record of its own name.
- Strength column: the gateway's intelligence scores are coarse (many at 74 % or 50 %); find a better
  source (a benchmark table by model family, or measured results) as a tie-break inside a score group.
  The `MODEL_STRENGTH_PATTERNS` tiers are hard-coded name patterns, unknown models get tier 9.
- Model lists: `/model a,b,c` and the last sweep are not saved with the session or shown in `/status`
  (a pasted sweep line does not survive wrapping over several lines); the request-rate window left
  is not in the `/model next` line; other `compactTable` tables (`/model list`, limits) still have one
  flexible column; only `/model health` is selectable (the other pagers could take `select` too);
  column filters are plain substring matches; no mouse selection; shift+arrows need `ESC [ 1;2 A/B`
  (J and K work everywhere); `smoke.sh` does not run `test-pager-select.js` under a pty.
- `/gateway limits|models`: the day window's exact reset is unknown (shown `<= 24 h`), IP limits are a
  text heuristic, `/model list FILTER` does not exist yet; `/gateway limited` loses the detail and the
  providers on a narrow terminal; freellmapi fusion, `x-freellm-cache`/`compress` and profile
  management are not exposed.

**Events, stats, persistence**
- Events not reported yet: learned cooldown changes, a rating that moved by 10 or more, key quota,
  the persisted-quota stand-in being replaced, the keyless IP fix steps, `/gateway providers`
  changes, the standby used as a sub-agent. The key status is compared only when `/gateway keys` is
  looked at; events are not persisted.
- `quota.jsonl` is written but nothing reads it (a `/gateway forecast` trend could); the status bar
  shows the preloaded quota as fresh until the first refresh; a killed process loses at most 20 s
  of quota and 5 s of cooldowns.
- Other clients (explore, standby, sub-agent) are not logged in `usage.jsonl`; could be, with a `label`.
- Config: briefs still live in `~/.config/ollama-repl/brief-*.json` (`lib/project-brief.js`
  `cachePath`) not in the cache; the restored `/model` pattern is announced only, it does not
  restore the cycle position; `/rename` after start does not move the session files; old
  `<model>.json/.log/-diffs` in project directories are not migrated; the provider debug logs
  (`lib/logger.js`) still go to the cwd; no unit test for `lib/session-cache.js` and the env parser.
- `/handoff`, `/compact`, `/handoff-model` summaries and `/each` use local-model calls
  (`lib/handoff.js`) without the verbose panels; `/brief` panels show whole documents (behind
  `/view N`); the compaction type of the net pane needs those calls watched with a label (they go
  through `localTrace`, not `watchNet`).

**Terminal UI**
- Net pane: the exploration's requests show with the label `explore`; the elapsed bar counts
  against a fixed 90 s; non-streamed OpenAI replies show no reply tail; requests are paired to sockets
  by the peer port only (two parallel requests to one host share the first socket); no scrolling,
  a long list is clipped; the gateway sends the key only as an ordinal, so the pane cannot name it,
  and a successful request shows no key; handoff and `/compact` prompts show the first line of the
  user message (give them a short subject if that reads badly).
- Live panels redraw the whole window every 120 ms (changed rows only would be cheaper); exploration
  panels scroll away as the chat goes on; a tool that throws leaves its panel on the failure line only
  when `runToolLoop` catches it; `repl.js` cannot be imported by a test (it runs `main()`), so helpers
  like `inKind`, the context subcommands and the dialog state are only mirrored in tests.
- Kitty keyboard and focus events stay off: `ChatREPL#termReadHandler` would need a layer that runs
  `decodeKeys()` and hands `handleKey()` the legacy string (needs a kitty terminal); the line editor
  is the base REPL of qjs-modules, `terminal.LineEditor` would replace `ChatREPL`'s whole base class;
  `showColors` is off in chat, so the grey suggestion and preview do not show.
- Verbose: no per-language highlighting (`markdown.js highlight()` is generic); the `/last` panel,
  plain `--verbose` lines and the unified diff of an edit tool call are not coloured as a diff;
  panels are kept for the whole session (`HISTORY_MAX`), the oldest drop first; Ctrl-O in plain mode shows
  only new traffic.
- Smaller: `/context` subcommands could apply to `/log`; no switch to turn the quips off; the
  "thinking:" label is unchanged; the live in-transcript scroll of the latest panel was not done (the
  pager covers it); a terminal sending another sequence for Alt-PgUp/PgDn needs an entry in
  `chat-repl.js`; the TUI start pushes the screen into the scrollback (needs a cursor position query);
  `/js` output and Tab lists come from the base REPL; the status line is clipped, not wrapped;
  Ctrl-C while a stream flows does not cancel it (`abort()` only knows requests waiting for headers);
  the lws connections of control-socket clients and CDP show in `/split status` only while connected.
- Move to qjs-modules `terminal` (not asked of that session yet, probably as sibling modules):
  `piped`, `termWidth`, `wrapHanging` (ansi.js), `Pager`, `colorJson`, `MarkdownStream`; the rest of
  `look.js` (`highlight`, `helpPanel`, `note`, `pctCell`) needs a theme design first. The faster
  `terminal.js` width functions live in qjs-modules (see tool-registry `PROPOSALS.md`).
- Files: attachment limits are constants in `lib/file-refs.js` (no option; a file the user names could
  be allowed up to 100 KB); a glob attach also fires on a `*.js` inside quoted prose (attach only
  standalone path-like tokens, or add a `/noattach` and leading `!` prefix); `read_file` resolves
  relative to the harness root (allow an absolute path under an extra root, or let `/cd` follow the job);
  `/log` and `/context` have no filtered view of only the tool-call history.

**Context, compaction, handoff**
- The compaction trigger is an estimate (chars / 3.5), not the provider's token count; the summarizer is the
  local ollama model also when the main provider is a gateway, and a 4B model can drop or garble details;
  after a handoff `/reset` keeps the base messages but the compacted turns are gone from the local history;
  a compaction may summarize a loaded skill away; a single long turn is cut by the auto compaction (nothing
  older to summarize).
- Takeover: the in-flight request finishes before the pause takes effect (no abort); only the main
  conversation is held.
- A handoff-aware prompt budget for duck's 16000 characters; `tools: false` in `/v1/models` so the repl
  switches to `--no-tools` by itself and a failover skips chatgpt, duck and deepai.
- System prompt: re-inject a short tool-use reminder periodically (e.g. on each tool result in
  `runToolLoop`); `gatherProjectContext()` is shallow and fixed at startup; no memory of files already
  read (a per-session "already shown" set); `qjsProjectDirs()`/`referenceFiles()`/`nativeModules()` re-read
  directories on every call (cache per session if it gets slow); `nativeModules()`' guess of the project
  a `.so` came from is not shown to the model; unverified: whether the shorter system prompt changes
  `qwen2.5-coder`, and whether the model reads a file before rewriting it.

**Agents, peers, sessions**
- Several conversations ("agents") in one ollama-repl, picked with up/down + Enter (a refactor: the
  closure in `main()` becomes an `Agent` class, module state in `tool-requests.js` and `repl.js` becomes
  per agent, a TUI agent list with replay on switch); `ollama-repl-ctl -a NAME` and a `multi` mode with an
  NDJSON stream per agent.
- Make `spawn_agent` non-blocking (returns an id, runs in the background, the result comes back as a
  notification message) with a running/finished list (up/down + Enter).
- Claude Code sessions as a provider: headless `claude -p --input-format stream-json --output-format
  stream-json` as a child process is the best fit (unverified: `--resume` with `--input-format
  stream-json`, attaching the Agent SDK to a running session); `~/.claude/sessions/<pid>.json`
  discovery works, the per-session socket protocol is internal and not worth targeting; tmux
  `send-keys`/`capture-pane` is the fallback. The other direction already works (a Claude session
  drives ollama-repl through `ollama-repl-ctl`).
- Peers: a worker's mode is not updated on `/mode`, no way to cancel a running peer task, the primary is
  not told which models are candidates, Gemini has no delegation; N restarts leave N waiting `qjsm`
  processes (no `execve` in QuickJS); a session started before the AF_UNIX fix holds the abstract
  socket name (restart it); a process started from the fallback is not a source tree itself.
- `/skill`: the model cannot load a skill itself (no tool), skills are not listed in the system prompt,
  plugin skills and `allowed-tools`/`argument-hint` are ignored.
- Delegation lesson: two agents edited `chat-bridge.js` at once and the weaker worker left a half-done
  edit: give each delegated task its own file or a lock and review the diff before the next dispatch.
  A local-model brief for other projects wants a goal, milestones and an out-of-scope list instead of
  "find weaknesses" (see `~/Sources/bass-doctor/TODO.md`; `lib/project-brief.js`).
- Bridge parity (plan in `../chat-bridge/doc/HARNESS.md`, failover plan in `../chat-bridge/TODO.md`):
  `--provider bridge` has none of the gateway functions (limits, `/route`, `/standby`, usage meters);
  needs chat-bridge to serve the metadata and a backend interface here (`lib/gateway.js` with freellmapi
  and bridge backends); the browser is not started for you (the bridge prints the command), a hard-killed
  repl can leave the bridge child running, no `--new-tabs` option.

## 4. Coding-quality ideas (assessments of 2026-08 to 2026-10, none verified live)

- The model does not always pick `for_each` (one run did 25 edits itself and deleted three declarations):
  a harness nudge when the prompt matches `/every|each|all .* (function|file)/` and edits start without
  `for_each`, or run the item extraction in the harness (`/each`-style).
- Verify after edit: a per-task check hook (a comment-only task: `git diff` has no removed lines and no added
  non-comment lines, else auto-`/undo` that item and retry); a `max_lines` check on `insert_above`; verify that
  the anchor line of a `for_each` insert contains the item name.
- `think: true` for the planning round and `think: false` for sub-items; Gemini `thinkingConfig.thinkingLevel`
  as a client option (`"low"` works on `gemini-3.8-flash`, `"minimal"` does not); a busy Gemini 503 outlasts all
  5 retries (retry longer, or skip a busy item); `for_each` could pack several items per request to save quota.
- Larger refactors (rename across files) are untested (needs `grep` -> `for_each(files)` and a build/test step).
- The target model `qwen2.5-coder` via a local Ollama was never run here (the Ollama install was broken:
  snap leftovers, mode 700, AppArmor); retry `ollama pull qwen2.5-coder`, run the two PoC tasks (a `RingBuffer`
  class on `std.open()`, a small C routine against `quickjs.h`) and read the `<model>.log`. `qwen2.5-coder`
  still inserts comments above a neighbouring declaration and ends items with a text `run_command` call.
- `ask_user`/`[y/N]` at EOF of piped stdin ends the session without an answer: re-test piped input against a
  `confirm()`/`ask()` prompt (a PoC run piped as `<prompt>\n/exit\n` hit a 90 s timeout).
- The binding-writing demo (`doc/DEMO.md`) has not been re-run live: needs an Ollama server or a
  `GEMINI_API_KEY`; the outcome decides whether the curated context fixed the old never-replies case
  (its `BUGS` entry is gone), record it in `doc/DEMO.md` section 9.
