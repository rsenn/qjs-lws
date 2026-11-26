# ollama-repl: plan of the open work (2026-11-25)

The pending tasks and unimplemented ideas of all markdown documents (`TODO.md`, `doc/HEALTH-EXPERIMENTS.md`,
`doc/GATEWAY-PROPOSALS.md`, `doc/ARCHITECTURE.md`, `README.md`, `BUGS`), split
into coarse tasks. `TODO.md` stays the short list; this file is the working plan: per task the goal, the steps,
where in the code, how to check it, what it depends on, and a size (S = under an hour, M = a session,
L = several sessions). Owner: H = this harness, G = the freellmapi gateway, U = the user, Q = the qjs-modules session.

How to check any change: `for t in tests/test-*.js; do qjsm $t >/dev/null 2>&1 || echo FAIL $t; done`,
`node --expose-internals check-names.cjs repl.js lib/*.js`, and for health work
`qjsm usage-baseline.js --days 1` against the baseline in `doc/HEALTH-EXPERIMENTS.md`.
Rules that apply to every task: record a design decision in a doc before building it; every fix has a test and
removes its `BUGS` entry; update `TODO.md` and the affected docs in the same change; stage files by name;
no commit trailers; every change gets an entry in `examples/ollama-repl/ChangeLog` (GNU style, see the repo `CLAUDE.md`).

Contents

- A. Decisions and housekeeping (U)
- B. Health plan, the rest
- C. Live verification (nothing below ran against a real gateway, terminal or Tor)
- D. Gateway and failover
- E. Proxy and exit address
- F. Exploration and rating
- G. Events, statistics, persistence
- H. Terminal UI
- I. Files, context, compaction
- J. Agents, peers, sessions, providers
- K. Bridge (chat-bridge) parity
- L. Coding quality of the models
- M. Documentation and demo
- N. Open bugs
- Suggested order

---

## A. Decisions and housekeeping (waiting on the user)

| # | Task | Owner | Size |
|---|---|---|---|
| A1 | **Kilo behind Tor?** (data side done 2026-11-26: usage rows carry `proxied`, the baseline splits `kilo` / `kilo +socks`, see `HEALTH-EXPERIMENTS.md`; the decision needs a day of rows.) Since 2026-11-25 the proxy policy has 22 keys on `socks5://192.168.178.52:9050`, `kilo` (67 to 77 % of the traffic) among them. It is gateway key state and outlives the harness. Compare before/after per platform (latency, ttfb, errors; split `usage.jsonl` at that time) and decide: keep, take kilo off (`/proxy keyless clear` for it), or keep only the keyless ones. Record the decision in `doc/HEALTH-EXPERIMENTS.md`. | U | S |
| A2 | **Who takes the gateway proposals** (D4 to D8 below, `doc/GATEWAY-PROPOSALS.md`)? Options: the user changes freellmapi, a patch is prepared here against `~/Sources/freellmapi`, or the harness keeps working around them. | U | S |
| A3 | **Delete the strace logs** (`strace.log`, `strace.log.copy.txt`, `strace.log.txt`, 110 MB, untracked or ignored). `harness.mp4` (14 MB) is also in the directory: keep or move out. | U | S |
| A4 | **Restart the running sessions** (`auto`, `worker-freellm`, `qjs-modules`) so they use the code of Phases 1 to 3: attempt rows, probe budget, rating reliability, exploration order, Tor host. Without it the 4.2 "after" numbers stay the old code. `ollama-repl-ctl -s NAME restart` after `smoke.sh` passes. | U / H | S |
| A5 | **Hop line in a terminal.** Look at a real automatic skip once (the line, the colours, a piped run) and say whether the wording is right (`lib/hop-line.js`). | U | S |

## B. Health plan, the rest (`doc/HEALTH-EXPERIMENTS.md`)

Phases 1 to 3 and 4.1/4.3 are built. Left:

**B1. Phase 4.2 "after" table (S, needs A4 and a day of traffic).**
Steps: restart sessions (A4); a day later run `qjsm usage-baseline.js --days 1` (and `--days 2` to split); fill the
"after" column of the table in the doc: failed turns (was 131 of 4255 = 3.2 %), failed hops by class (140; 12
harness exceptions should be 0), time to next success (median 17 s, p90 396 s, longest run 9), kilo share
(67 %), gateway retries 1+ (61), plus the rating ties (`ratings.json`: no three-way tie at the `adj` cap) and the
transient verdict share in `exploration.json` (was 160 of 178 = 90 %) and the share of verified models used within
the day (was 24 of 98). Success: the harness-exception row is 0 and no worse numbers elsewhere; if something is
worse, open a BUGS entry with the evidence.

**B2. 3.5 Faster switch on "All models exhausted" for a pinned model (M).**
Problem: the cheap 0.3 s failures repeat up to 9 times in a run (longest seen 9 requests, median 13 s to the next
success). Today `autoSkipHook` / `/model skip` already drops every model of a provider the error names
(`exhaustedPlatforms(error)`), so find first which runs still happen: read the `attempt` rows of the new code.
Steps: (1) from `usage.jsonl` list runs with `attempt` >= 2 and their errors; (2) decide per class (exhausted vs
upstream vs timeout) whether the next model can be chosen without a request (availability says it is limited) or
whether the pinned model should be dropped for the whole run after the first "All models exhausted";
(3) write the rule into `ARCHITECTURE.md` section 10 first, then change `chatRound` (`repl.js`), keep
`AUTO_SKIPS`; (4) a test on `lib/skips.js` or a new pure helper (the choice must live in a `lib/` function: `repl.js`
cannot be imported by a test). Success: failure run length and time to the next success in the baseline fall.

**B3. 3.4 Failover headroom (M, needs `/gateway quota` data).**
Prefer a provider with quota left over the biggest one in `pickNext` (standby, takeover, `/model next`, the
auto-skip choice). Steps: define headroom per platform (share of the month's token budget left, requests left in
the day window, whether its keys are cooling) from `availability` and `gateway.state.budget`; add it as a term to
`score()` (state now) or as a tie-break in `pickNext`; test with an availability fixture where kilo has 5 % left and
another provider 80 %; document the term in section 12. Success: the share of kilo after failures (17 of 38 on
2026-11-25) falls and no new failure runs appear.

**B4. 3.11 req/day meter feeds failover and the exit decision (S to M).**
`/gateway quota` shows requests-per-day used/limit (openrouter nemotron-3.5-lightning:free 34/50). Use "n requests
left" (and `rpd` windows) as a pre-emptive signal: lower the rating when under 10 % left, let `autoProxy` /
`autoExit` count a provider as "about to be exhausted". Steps: expose the meter from `Gateway.state.rate` in
`ratingInputs(id)` (`quotaLeft` exists for the month; add the day window); test `score()` and the exhausted
rule. Depends on B3 (shares the headroom definition).

**B5. 3.10 Quota bar question (S, needs G).**
"584M/2.3G budgeted tokens" vs 876M in `/gateway usage`: find out which tokens `budget.totalUsed` counts (only
budgeted platforms? only some models?). Steps: read `~/Sources/freellmapi/server/src/routes` for the budget
endpoint; if kilo has no budget, say so in the bar ("budgeted platforms only") or count all; change `lib/freellm.js`
`quotaText` accordingly, with a test; remove the question from `GATEWAY-PROPOSALS.md`.

**B6. 4.1 leftover: the base `nemotron-3.5-lightning` (S).** Repeat the 400/1500 rerun for the base model when its
routes are usable (the three variants are done). Script: see the session history (a `buildProbe(12000)` loop with
`FREELLMAPI_URL`/`FREELLMAPI_KEY`); the key is in `~/Documents/accounts.txt` line 36 (never print it). Record the result in the
4.1 table.

## C. Live verification (verification debts)

One real session each; the unit tests only cover the helpers. Do these in a live session driven through
`ollama-repl-ctl -s NAME` (see the safety rule in `doc/HEALTH-EXPERIMENTS.md`). Each item ends with a line in
`TODO.md` removed and, if it fails, a BUGS entry.

| # | What to run and what to look at | Size |
|---|---|---|
| C1 | **Failover chain** (2026-11-24 work): provoke a 429 on a pinned model; check Retry-After skips, the task-type header, the trail soft-skip, `/last` trail, turn repair, the routing-health segment, early skip release, the hop line, the give-up panel after 3 backoffs. | M |
| C2 | **Gateway views**: startup likely-routes list, `/model health` columns, `/gateway usage` key spread, the persisted quota stand-in (restart and look at the first second), the dashboard success path (a valid session, not only a refused token). | M |
| C3 | **Key restriction** `/model key:ID,ID`: the status mark, `/route` refusal, a warning for keys sharing a platform. | S |
| C4 | **Proxy and Tor**: `autoExit` when all keyless providers are exhausted (10 minute gap, the pane, `exploreKeylessAgain`), `/proxy keyless fix` end to end, the proxy policy (keyless and multi-key via proxy, single key direct, enable on exhaustion), the PATCH/DELETE key calls against the live gateway, the `SOCKS`/`DIRECT` chips against real sockets. Tune the 10 minute gap and the "all exhausted" rule from what is seen. | M |
| C5 | **Exploration**: a tier 0/1 sweep (`/model explore nemotron*`), the diagnosis steps, the "provider busy" display (`12k?`), takeover end to end (`considerTakeover`: a better model appears while a request runs; the pause, the handoff, the question), the prompt-cache question for the fixed needles. | M |
| C6 | **Terminal pass** (one sitting, a real terminal, plus tmux): net pane (colours, chips, clipping), split-pane keys F2/Shift-F2/Alt-1..4/Alt-0/Alt-\\ and the Ctrl-X chords, live panels, tool call panels (`⚙ NAME · running`), the `/model` chooser filter and scrolling pickers, `/brief save`, sync frames and the undo at exit, the reply colour `REPLY`, the reasoning panel with a long text (the `fg` fix), verbose Ctrl-O on and off. | M |
| C7 | **Local models**: Ollama and Gemini `onMeta` token counts (`tests/test-client-usage.js` is mock only) and the record of a failed request for them; `OllamaClient` with `tools` and its streaming `tool_calls`; `/brief` built by the local summarizer. | M |
| C8 | **Agents**: `spawn_agent` with `kind`, the read-only switch (no write tool leaks), sub-client destroyed on failure, a worker waiting for approval, `restart_harness` as a model tool call, the self-edit dialog and SELF_NOTES use, `ask_user` by a live model, the repeat guard `MAX_REPEAT_ROUNDS`, the standby switch-over on a real 429/5xx, `ollama-repl-ctl monitor` (`waiting` event, two clients, a client that stops reading). | L |
| C9 | **Bridge** (`--provider bridge`): names and the context meter in `/model list`, the standby switch-over, strength "unknown", the "/min" in `x-ratelimit-*` of the status line, the report of the prompt that stopped accepting input after "OpenAI connection failed: dropped" (check `/proc/<pid>/fd/0` of the bridge child if it happens again). | M |

## D. Gateway and failover

Harness side (H) unless marked G.

- **D3. Availability on a timer (S).** Skips are released and routing-health numbers move only when `/model list`,
  `/model skip` or another refresh runs. Add a low-rate refresh (every 60 s while a request is running or the
  session is idle, never in a hot path; coalesce with BUGS `availability-load-uncoalesced-and-429-swallowed`, N1).
- **D4. (G) Key spread** (3.6): kilo's three keys carry 87/12/1 %. First check the caveat: two of the three tokens
  belong to one user and Kilo reports no usage per key, so the keys may share one limit; test with a valid Kilo
  token via `usageAnalytics.getBreakdown` (dimension user) before asking for balancing.
- **D5. (G) `blocked` false negatives** (3.7): a model listed usable while its provider is `rate_limited`.
- **D6. (G) Daily resets as resets** (3.8): expose the reset kind and exact end instead of `cooldown` (01:00, 06:55 to
  07:04, 13:35); the harness then drops the `?` in the "back" column for exhausted models.
- **D7. (G) Route check for tool support** (3.9): "1 model lacks tool-calling" counted among the candidates of a
  request with tools; filter before counting routes.
- **D8. (G) Invalid upstream key** (4.1): disable or replace the provider key that fails authentication; the gateway
  could disable a key that fails authentication so it stops counting as an attempted route.
- **D9. Mid-stream limits (M).** A limit in the middle of a streamed reply, after text was printed, is not handled
  (failover covers `chatRound()` start). Steps: detect an error after first token; keep what was printed as an
  assistant prefix, drop the spent model, continue with "continue" or re-ask; design first (what the transcript
  shows, what `repairTurn` keeps).
- **D11. Local model switch leaves the old route (S).** After a switch to the local model the next round still starts
  on the failed client (routed by the cool-down) and the status line keeps the old route (the local client has no
  `onMeta`). Done: the local client has an `onMeta`. Open: should the switch stick for the next round.
- **D14. One next-model order (M).** The provider fallback and `/handoff-model` are not part of the single order
  (standby, then best rated); fold them in, or document why they stay apart.

## E. Proxy and exit address

- **E1. Tor cookie authentication (S).** `lib/proxy-probe.js newExit`: support `CookieAuthentication` by reading the
  cookie file (`/run/tor/control.authcookie`, hex) for a local Tor; a remote Tor keeps the password or the ssh
  tunnel. Test with a fake control port (the test already has one).
- **E2. NEWNYM throttling (S).** Tor answers 250 OK to a second NEWNYM within 10 s without a new circuit: `newExit`
  should wait out the 10 s (`SIGNAL NEWNYM` then check `GETINFO newnym-wait`) or the callers probe again (the
  `fixKeyless` round does; `autoExit` and `/proxy exit` do not verify the address changed).
- **E3. Keyless platform without a key row (M).** A platform the gateway lists only as a provider cannot get a proxy:
  the dashboard keeps the sentinel row. Needs the gateway to create the row; until then the pane says so.
- **E4. What an address change lifts (S).** The set (windows, cooldown, exhaustion, IP errors; not credit, tier, key
  state) is a guess: after C4, count which cleared cooldowns really came back and adjust `ipLimitedPlatforms` /
  `clearCooldowns`.
- **E5. `/proxy keyless fix` per model (M).** It tests the strongest limited model per provider only and reports a
  provider as working when its other models stay limited. Test a second model of the provider when the first works;
  turn its steps into `proxy` events (they are printed only).
- **E6. Latency of proxied keyed providers (S).** A keyed provider limited per IP gets a proxy for its key, adding the
  proxy's latency to every request of that key: show the added latency per platform in `/proxy` (exists:
  `measure`), and take the key off the proxy again when the limit is gone (`autoProxy` only adds).
- **E7. Transient/real split without a regex (M).** `isTransientProbe` and `diagnose` classify by regex over the error
  text; use the gateway's error code and status where the gateway gives them (`upstream_error`, `rate_limited`).

## F. Exploration and rating

- **F1. Non-OpenAI explorers (M).** Only OpenAI-compatible gateways are explored. Ollama and Gemini could be probed
  with the same tier 0 (ping tool) when selected; low value, do after C7.
- **F2. Quota cost of exploration (S).** Each model costs 2 requests of free quota (tier 0) and the top 30 a tier 1 of
  3 to 12k tokens, once. Add a counter (probes sent today, tokens) to `/events` or `/model health` so the cost is
  visible, and an option for tier 0 only and for the concurrency of `/model explore`.
- **F3. Queue limited models (M).** `/model explore` skips limited models; queue them until their `until` instead and
  report them as "waiting" (3.1 skips providers within one run; this is the same idea across runs).
- **F4. Use the explored identity for routing (M).** Skip models that ignore a system prompt in auto routing and show
  the identity in `/model list`. Check first whether tier 0/1 still collect identity (they do not ask for it any
  more): either re-add a cheap identity field or drop the idea and delete the stale README wording.
- **F5. Stale old entries (S).** Entries written by the old three-prompt code count as verified as they are; re-probe
  them once with tier 0 (mark a `v` version on `entry`, treat a missing one as stale).
- **F6. Live refresh (S).** The live refresh runs only with `/model health`; add a status segment and a timer
  (every 2 minutes while idle), and make the TCP check connect to the model's upstream where the gateway exposes it.
- **F7. Needles may be cached (S).** The fixed needles let a prompt-caching provider answer from cache; vary them per
  probe when a suspicious pass rate shows (`buildProbe(seed)`, `grade` uses the same seed).
- **F8. Rating tuning (M, needs data).** The weights (55 intelligence, +-25 learned, reliability +-10, latency, probe,
  state) are a first guess: after a week of `usage.jsonl`, fit them (does the rating order predict the success
  share and latency?), and add a term for the gateway's own usage evidence (kilo served 76M tokens of one model).
  Also: a provider rates as the mean of its best three models (check it still makes sense); a route that is not a
  catalog id gets a record of its own name (map provider rows to catalog ids).
- **F9. Better strength source (M).** The gateway's intelligence scores are coarse (many at 74 % or 50 %). Add a
  table by model family (benchmarks) as a tie-break inside a score group; replace the hard-coded
  `MODEL_STRENGTH_PATTERNS` name patterns (unknown models get tier 9).
- **F10. Model list state (M).** Save `/model a,b,c` and the last sweep with the session (`state.json`) and show them
  in `/status`; accept a sweep list split over several pasted lines; put the request-rate window left (req/min
  used/limit) into the `/model next` line.
- **F11. Lists and pickers (M).** `compactTable` tables (`/model list`, limits) still have one flexible column; make
  more pagers selectable (`/gateway limited`, `/gateway models`); numeric and regex column filters; mouse selection;
  run `tests/test-pager-select.js` under a pty in `smoke.sh`.
- **F12. `/gateway` details (M).** The day window's exact reset is unknown (shown `<= 24 h`; needs D6); IP limits are
  a text heuristic; `/model list FILTER` does not exist; `/gateway limited` loses detail and providers on a narrow
  terminal; fusion, `x-freellm-cache`/`compress` and profile management of the gateway are not exposed.

## G. Events, statistics, persistence

- **G1. More events (S each).** Learned cooldown changes (`recordCooldownEvent`), a rating that moved by 10 or more,
  key quota (the monthly request cap of a single key), the persisted-quota stand-in being replaced, the keyless fix
  steps, `/gateway providers` status changes (a provider turning down), the standby used as a sub-agent. The key
  status is only compared when `/gateway keys` is looked at (add it to the refresh without extra requests).
  Events are not persisted: write the important ones (`quota`, `failover`, `proxy`) to a small jsonl.
- **G2. Read the quota history (M).** `quota.jsonl` is written but nothing reads it: a trend for `/gateway forecast`
  and for B4. The status bar shows the preloaded quota as fresh until the first refresh answers: mark it stale.
- **G4. Config cleanup (M).** Briefs still live in `~/.config/ollama-repl/brief-*.json` (`lib/project-brief.js
  cachePath`), move to the cache; the restored `/model` pattern does not restore the cycle position; `/rename` after
  start does not move the session files (the key is fixed at startup); old `<model>.json/.log/-diffs` in project
  directories are not migrated; provider debug logs (`lib/logger.js`) still go to the cwd; add unit tests for
  `lib/session-cache.js` and the env parser.
- **G6. Local-model panels (M).** `/handoff`, `/compact`, `/handoff-model` summaries and `/each` use local-model calls
  (`lib/handoff.js`) without the verbose panels, and they go through `localTrace`, not `watchNet`, so the net pane's
  compaction type needs them labelled; `/brief` panels show whole documents (up to the 8k-token window, behind
  `/view N`): add panels and labels, cap the brief panel.

## H. Terminal UI

- **H1. Net pane (M).** Scrolling (a long list is clipped); the elapsed bar counts against a fixed 90 s (use the
  client's first-token and stall timeouts); non-streamed OpenAI replies show no reply tail; a wrapped Ollama `chat()`
  shows it only when the call ends; pair requests to sockets by more than the peer port (two parallel requests to one
  host share the first socket); the exploration's requests show with the label `explore` (filter option); name the
  key (needs the gateway to send more than the ordinal; D-level G ask); a short subject for handoff and `/compact`
  prompts instead of the first line of the user message.
- **H2. Live panels (M).** A repaint every 120 ms redraws the whole window; repaint changed rows only; the exploration
  panels scroll away as the chat goes on (pin them in the split pane, or a `/events` follow mode); a tool that throws
  leaves its panel on the failure line only when `runToolLoop` catches it (make every path close its panel).
- **H3. Testability of `repl.js` (rest, S).** Done 2026-11-25: `hopStyle` (`lib/hop-line.js`), `makeModelName`,
  `routeFailure`, `soonestReset`, `servedIds`, `exploreOrder` (`lib/transcript-text.js`) and `Tui#inKind` have tests.
  Done 2026-11-26: the `/context` and `/log` helpers and the `/context` argument parsing (`lib/context-view.js`).
  Still only in `repl.js`: the dialog state of `ChatREPL` and the rest of the wiring; move pure parts out as they are touched.
- **H4. Kitty keyboard and focus events (L).** Off today. `ChatREPL#termReadHandler` needs a layer that runs
  `decodeKeys()` and hands `handleKey()` the legacy string of each key (press events only); focus events could pause
  repaints. Needs a kitty terminal.
- **H5. Line editor (L).** The editor is the base REPL of qjs-modules (`lib/repl.js`); `terminal.LineEditor` would
  replace `ChatREPL`'s whole base class (history, `^R`, completion, queue, dialogs). `showColors` is off in chat, so
  the grey suggestion and preview do not show; decide between turning it on and moving to `LineEditor`.
- **H6. Verbose colouring (M).** Per-language highlighting (`markdown.js highlight()` is one generic tokenizer); the
  `/last` panel and the plain `--verbose` lines are not coloured; the unified diff of an edit tool call is not shown
  as a diff in the call panel; panels are kept for the whole session (`HISTORY_MAX`, oldest drop first); Ctrl-O in the
  non-TUI mode shows only new traffic.
- **H7. Small things (S each).** `/context` subcommands for `/log`; a switch for the quips; the "thinking:" label;
  a live in-transcript scroll of the latest panel (the pager covers it); an entry in `chat-repl.js` for terminals that
  send other sequences for Alt-PgUp/PgDn; the TUI start pushes the screen into the scrollback (needs a cursor position
  query before the REPL owns stdin); `/js` output and Tab lists come from the base REPL; the status line is clipped,
  not wrapped; Ctrl-C while a stream flows does not cancel it (`abort()` only knows requests waiting for headers);
  the lws connections of control-socket clients and CDP show in `/split status` only while connected.
- **H8. Move widgets to qjs-modules `terminal` (Q, M).** Not asked of that session yet, probably as sibling modules:
  `piped`, `termWidth`, `wrapHanging` (ansi.js), `Pager`, `colorJson`, `MarkdownStream`. The rest of `look.js`
  (`highlight`, `helpPanel`, `note`, `pctCell`) needs a theme design first. The faster `terminal.js` width functions
  live in the qjs-modules repo (tool-registry `PROPOSALS.md`): check the installed `qjsm` has them, then drop the
  `Pager#decorate` workaround note in ARCHITECTURE section 22.

## I. Files, context, compaction

- **I1. File attachment (S each).** The limits are constants in `lib/file-refs.js`: add an option and a command, and
  allow a file the user names explicitly up to 100 KB; a glob attach fires on a `*.js` inside quoted prose: attach only
  standalone path-like tokens, or add a `/noattach` and a leading `!` prefix; `read_file` resolves relative to the
  harness root: allow an absolute path under an extra root, or let `/cd` follow the job.
- **I2. Filtered histories (S).** `/log` and `/context` have no filtered view of only the tool-call history (request
  and result pairs without the chat turns); it is only in `<model>.log`.
- **I3. Compaction accuracy (M).** The trigger is an estimate (chars / 3.5 plus the tool schemas), not the provider's
  token count: use `usage.prompt` of the last answer as ground truth; the summarizer is the local ollama model also
  when the main provider is a gateway (offer a gateway model, with a quota note); a 4B model can drop or garble
  details (strict headings only reduce it); after a handoff `/reset` keeps the base messages but the compacted turns
  are gone from the local history (the session file is saved compacted too); a compaction may summarize a loaded skill
  away (pin skills); a single long turn is cut by the auto compaction (nothing older to summarize: compact the tool
  rounds of the running turn more gently).
- **I4. Takeover (M).** The in-flight request finishes before the pause takes effect (no abort); only the main
  conversation is held (sub-agents run on). Add an abort option for expensive requests, hold sub-agents too.
- **I5. Bridge sites (M).** A handoff-aware prompt budget for duck's 16000 characters; `tools: false` in `/v1/models`
  so the repl switches to `--no-tools` by itself and a failover skips chatgpt, duck and deepai (chat-bridge idea 5).
- **I6. System prompt and context (M, needs live runs).** Re-inject a short tool-use reminder periodically (for
  example on each tool result in `runToolLoop`); `gatherProjectContext()` is shallow and fixed at startup (let the model
  broaden its view cheaply rather than widening the automatic scan); no memory of what was already read (a per-session
  "already shown" set like `SentFiles`); `qjsProjectDirs()`, `referenceFiles()`, `nativeModules()` re-read directories
  on every call (cache per session when it gets slow); `nativeModules()`' guess of which sibling project a `.so` came
  from is not shown to the model (inject it, or expose it as a tool argument); unverified: whether the shorter system
  prompt changes `qwen2.5-coder`, whether the model reads a file before rewriting it, whether it prefers checking over
  guessing in C/QuickJS work (read the binding and `quickjs.h` first).

## J. Agents, peers, sessions, providers

- **J1. Several conversations in one process (L).** Picked with up/down + Enter. `main()` keeps everything in one
  closure (messages, client, opts, stats, log, store, sentFiles, fileExchange, baseMessageCount, abortRef, the busy
  queue): turn it into an `Agent` class; module-global state becomes per agent (`tool-requests.js` undo journal and
  `writeCount`, `repl.js` failoverHook, approveWrite, ui); the event loop already runs several requests at once; the
  TUI gets an agent list (down on an empty input, or a key), output buffered per agent and replayed on switch, and
  background approvals queued and shown in the status line. Depends on H3.
- **J2. `ollama-repl-ctl` for agents (M).** `-a NAME` or `@name line` over the socket, events tagged with agent and
  session, and a `ctl multi` mode that holds several sessions open and prints one NDJSON stream (`ready`, `waiting`,
  `output`, per agent) for a controller such as Claude Code. Depends on J1.
- **J3. Non-blocking `spawn_agent` (M).** Returns an id at once, runs in the background, the result comes back to the
  parent as a notification message; a list of running and finished agents (up/down + Enter opens one). Today the
  parent turn blocks until the sub-agent is done. Could precede J1 as a smaller step.
- **J4. Claude Code as a provider (L, research first).** Best fit: a child `claude -p --input-format stream-json
  --output-format stream-json --verbose` that reads JSON user messages on stdin and emits NDJSON; `--resume <id>` or
  `--session-id <uuid>` picks the conversation. Verify first: `--resume` together with `--input-format stream-json`,
  and whether the Agent SDK can attach to a session running in another process. Fallbacks: tmux `send-keys` and
  `capture-pane` into the session's pane (named in `~/.claude/sessions/<pid>.json`), `claude -p --resume` for a
  headless turn. Not worth targeting: the internal per-session socket protocol. The other direction already works.
- **J5. Peers and delegation (M).** A worker's mode is taken from its info and not updated on `/mode`; no way to
  cancel a running peer task; the primary is not told which delegate candidates exist; Gemini has no delegation; "ok"
  means the sub-agent finished and said something (quality comes only from the user's votes: add an automatic check
  for kinds that have one); N restarts leave N waiting `qjsm` processes (no `execve` in QuickJS; document or find a
  way); a session started before the AF_UNIX fix holds the abstract socket name (restart it); a process started from
  the fallback is not a source tree itself.
- **J6. Skills (M).** The model cannot load a skill itself (no tool): add a `load_skill` tool; list skills in the
  system prompt; plugin skills (`~/.claude/plugins`) and a skill's `allowed-tools` / `argument-hint` are ignored.
- **J7. Delegation hygiene (S).** Lesson: two agents edited `chat-bridge.js` at once and the weaker worker left a
  half-done edit. Give each delegated task its own file or a lock, review the diff before the next dispatch; add the
  rule to the delegation prompt. Also: a local-model brief for other projects should say a goal, milestones and an
  out-of-scope list instead of "find weaknesses" (`~/Sources/bass-doctor/TODO.md`, `lib/project-brief.js`).

## K. Bridge (chat-bridge) parity

Plan and rationale: `../chat-bridge/doc/HARNESS.md` and `../chat-bridge/TODO.md` ("Failover plan").

- **K1. Backend interface (L).** `--provider bridge` has none of the gateway functions (limits, `/route`, `/standby`,
  usage meters). Introduce `lib/gateway.js` with a freellmapi and a bridge backend, let chat-bridge serve the metadata
  the backends need; steps 5 and 6 of the bridge docs.
- **K2. Process handling (S).** The browser is not started for you (the bridge prints the command); a repl killed hard
  (not via `/exit` or Ctrl-C) can leave the bridge child running; no `--new-tabs` option.
- **K3. Bridge ratings (S).** Sites show strength "unknown" (no scores): give the bridge a strength table; the standby
  switch-over for a bridge is untested (C9).

## L. Coding quality of the models (assessments of 2026-08 to 2026-10, none verified live)

- **L1. `for_each` choice (M).** A model does not always pick it (one run did 25 edits itself and deleted three
  declarations). Option 1: a harness nudge, when the prompt matches `/every|each|all .* (function|file)/` and edits
  start without `for_each`, reject the first edit with "use for_each". Option 2: run the item extraction in the
  harness (`/each`-style) for prompts that name a header. Test on the slugify and `lib/path.h` tasks.
- **L2. Verify after edit (M).** A per-task check hook: for a comment-only task `git diff` must have no removed lines
  and no added non-comment lines, else auto-`/undo` that item and retry; a `max_lines` check on `insert_above`
  (items still sometimes paste the whole doc block); verify that the anchor line of a `for_each` insert contains the
  item name (an anchor on a neighbouring declaration is accepted today).
- **L3. Thinking and retries (S).** `think: true` for the planning round only and `think: false` for sub-items;
  Gemini `thinkingConfig.thinkingLevel` as a client option (`"low"` works on `gemini-3.8-flash`, `"minimal"` does
  not); a busy Gemini 503 outlasts all 5 retries (retry longer, or skip a busy item); pack several `for_each` items
  per request to save quota.
- **L4. Refactors (M).** A rename across files is untested: needs `grep` then `for_each(files)` and a build/test step
  via `run_command`.
- **L5. The target model (M, needs an Ollama server).** `qwen2.5-coder` via a local Ollama was never run here (the
  install was broken: snap leftovers, `/usr/local/bin/ollama` mode 700, AppArmor). Fix the install, `ollama pull
  qwen2.5-coder`, run the two PoC tasks (a `RingBuffer` class on `std.open()`; a small C routine against `quickjs.h`)
  through `--provider ollama --model qwen2.5-coder` and read the `<model>.log`. Known: it inserts comments above a
  neighbouring declaration and ends items with a text `run_command` call although that tool is withheld.
  Candidates not tried: `qwen3.5:9b`, `gemma4:e4b`, `gpt-oss:20b`, `qwen3-coder:30b`, `devstral-small:24b`
  (8 GB VRAM, 32 GB RAM; up to about 9B parameters fits in VRAM, larger models run partly offloaded; raising
  `--num-ctx` above the default 16384 costs VRAM).
- **L6. Piped input at a prompt (S).** `ask_user` and `[y/N]` at EOF of piped stdin end the session without an answer;
  a PoC run piped as `<prompt>\n/exit\n` hit a 90 s timeout after a `run_command` reached `confirm()`. Re-test piped
  input against `confirm()`/`ask()` before trusting non-interactive tests.
- **L7. Other providers on the task (S).** The comment task was not tried on the other providers; the free
  tiers of Groq, OpenRouter, Mistral, Cerebras and GitHub Models were known only from third-party pages (a
  20-50 requests/day tier cannot run the 25-item `for_each` benchmark) and must be checked at the provider.

## M. Documentation and demo

- **M1. Binding demo re-run (S, needs a model).** The curated context (`reference/quickjs-binding-api.md`,
  `fib.c`, `point.c`) was never tried live: run the zlib prompt against a reachable Ollama or Gemini, record the
  outcome in the README demo section (whether the old never-replies case is fixed; its BUGS entry is gone).
- **M3. Keep docs true (continuous).** `README.md` and `/help` must agree; every new slash command touches the six
  places in ARCHITECTURE section 16; update `TODO.md` in the same change; this file when a task closes.

## N. Open bugs (`BUGS`)

- **N1. `loadavailability-stalls-the-loop` (`lib/availability.js:availabilityFrom`, `lib/openai-client.js:fetchJSON`):**
  one load blocks the loop for 0.5 to 1.1 s against a fake gateway of the live size (compute 220 to 270 ms, JSON.parse
  of the penalty inspector 140 ms, the rest decoding of 7 responses). Another session works on it (`lib/lag.js` shows
  which section ran how long: restart a session, use `/model skip` and the `/gateway` views, read `/events lag` or
  `~/.cache/ollama-repl/lag.jsonl`). Done: concurrent loads share one load, a table that answers 429 keeps its
  previous answer and is reported (`av.missing`, `reportMissing`, `tests/test-availability-missing.js`). A load still
  costs 7 requests: a per-table TTL (the key table changes rarely) would cut it; blocks D3 until decided.

## Suggested order

The ordered list of every pending task, with the reasons for the order, is `TODO.md` (sections 1 to 15). In short:
decisions and housekeeping (A), bugs and enablers (N1, H3), small failover fixes (D), live verification
(C, terminal first), the measured failover work (B, after the restart A4 and a day of data), the gateway wishes (D4 to
D8, after A2), proxy (E, after C4), exploration and rating (F), events and persistence (G), UI (H), files and context (I),
agents and providers (J), bridge (K), coding quality (L, M1).
