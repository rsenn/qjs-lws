# ollama-repl architecture

What an implementor must know to change ollama-repl without breaking it. Every
claim names the source file and the function or class it lives in. Line numbers
(`≈NNNN`) are hints that were true on 2026-11-25; the names are the reference,
use `grep -n` when a line has moved.

Companion documents: `README.md` (user manual, every command and option),
`TODO.md` (open work, per-feature "Done / Open" notes), `doc/API.md` (the
control-socket and client API), `doc/MODELS.md` (what is known about models),
`doc/DEMO.md` (a walk through the features), `reference/` (QuickJS binding
reference given to models that write bindings).

Contents

1. What it is
2. Runtime and process model
3. Layers at a glance
4. Source map (every file)
5. `repl.js` anatomy
6. Startup sequence
7. The life of a prompt (turn lifecycle)
8. Model clients
9. Tools the model can call
10. Failover: what happens when a request fails
11. The gateway subsystem
12. Availability, rating, exploration (choosing models)
13. Standby, takeover, handoff, compaction
14. Proxy and IP handling
15. The terminal UI
16. Commands: how they are wired, how to add one
17. Control socket, peers, delegation
18. Persistence: every file the program writes
19. Self-edit and restart
20. Tests and verification
21. Conventions and invariants
22. Gotchas that have bitten before
23. Glossary

---

## 1. What it is

A Claude-Code-style coding agent in the terminal, written in JavaScript for
`qjsm` (the QuickJS runtime of `qjs-modules`), talking over HTTP/WebSocket
through this repository's own `lws.so` (libwebsockets bindings). One process,
one conversation, one event loop. It drives:

- a local **Ollama** (`lib/ollama-client.js`),
- **Gemini** (`lib/gemini-client.js`),
- any **OpenAI-compatible** endpoint (`lib/openai-client.js`), in practice a
  **freellmapi gateway** (an OpenAI-compatible router over dozens of free
  providers, `~/Sources/freellmapi`) or a **chat-bridge** (`examples/chat-bridge`,
  free chat web sites behind an OpenAI API, started by `lib/bridge-process.js`).

Most of the code is not the chat loop but the machinery around a *free-tier
gateway*: knowing which of ~600 models can answer now, how good they are,
what limits them, and switching between them without the user noticing.

Entry points: `repl.js` (`main()`), `ctl.js` (`ollama-repl-ctl`, a separate
program that talks to a running session over its control socket).

## 2. Runtime and process model

- **One QuickJS runtime, one thread.** Everything is `async`/`await` on the
  qjsm event loop (`os.setTimeout`, `os.setReadHandler`, lws service ticks).
  There are no workers: `lws.so` keeps class prototypes in statics, a second
  runtime loading it breaks the first (`BUGS` entry `lws-statics-not-multi-runtime`;
  `lib/exploration.js` header repeats the rule). "Background" work (the
  exploration, the standby probe, gateway refreshes) is just promises that
  interleave with the foreground on the same loop.
- **Event loop and lws.** `lws.so` is built with `USE_EPOLL`: one
  `epoll_readable` read handler per `LWSContext`, `lws_service_fd` called from
  the epoll drain, plus a 250 ms service tick (`lws-context.c`). An epoll
  stall was suspected once and measured not to be the cause of sluggishness
  (see §22); the real costs were JS-side (rating code, `terminal.js` width
  functions).
- **Never block the loop.** Anything that takes more than ~50 ms in a key
  handler or timer makes the TUI feel dead. Shell commands go through
  `lib/run-command.js` (`runCommand`, async, uses `shish -c` when available).
  Synchronous work is only for small files (`std.loadFile`, `writeConfigFile`).
- **Native modules used**: `lws.so` (via `lib/lws/*` wrappers `fetch`-like
  `httpClient` protocol adapter, `lib/lws/protocols.js`), `terminal` (qjs-modules
  `lib/terminal.js`: `ScrollView`, `Region`, `truncate`, `wrap`, `stringWidth`,
  `ttyWrite`, `windowSize`, `layoutInput`, ...), `repl` (qjs-modules readline
  `REPL` base class), `sockets` (`TCPSocket`, `Socket`, `SockAddr`, used for the
  control socket, Tor control port, CDP), `textcode`, `os`, `std`, `fs`.
- **Module path.** `qjsm` finds native modules through `QUICKJS_MODULE_PATH`
  (separator `;` on this build). A path override must list every directory
  needed (`lws.so` lives in `build/<triplet>`), otherwise unrelated tests fail
  with "could not load module filename 'lws.so'".

## 3. Layers at a glance

```
 ctl.js ──────────────► lib/control-socket.js            external controllers (Claude Code, scripts)
                                 │
 ┌───────────────────────────────▼──────────────────────────────────────────┐
 │ repl.js  main()  — wiring, commands, turn loop, hooks, background workers │
 └─┬───────────┬──────────────┬──────────────┬─────────────┬────────────────┘
   │           │              │              │             │
   ▼           ▼              ▼              ▼             ▼
 UI          Turn engine    Model choice   Gateway       Persistence
 tui.js      runToolLoop    availability   freellm.js    persist.js
 chat-repl   chatRound      rating         ip-fix        session-*.js
 look.js     tool-requests  exploration    proxy-probe   config.js
 pager.js    handoff        standby        net-activity  events.js
 net-pane    turn-repair    takeover
 usage-stats failover       diagnose
             provider-fallback
                  │
                  ▼
        clients: openai-client / ollama-client / gemini-client  ──►  lws.so (HTTP)
```

Dependency rule: `lib/*.js` never import `repl.js`. State that `lib` modules
need from `repl.js` is injected (`setRater`, `setNamer`, `setSink`, callbacks
passed to `Exploration.run`, the `*Hook` objects below). `repl.js` is the only
place that knows about all subsystems.

## 4. Source map (every file)

### Entry points

| File | What |
|---|---|
| `repl.js` | The program. ~5500 lines: arg parsing, prompts, the turn engine, all slash commands, all background wiring. §5. |
| `ctl.js` | `ollama-repl-ctl`: `list`, `send`, `watch`, `monitor`, `steer`, `cancel`, `restart` against a session's control socket. |
| `smoke.sh` | Restart gate and quick check: imports every `lib/*.js`, runs a few tests, starts the REPL in a pty and sends 7 commands. §19–20. |

### Model clients (`lib/*-client.js`)

| File | Class | Notes |
|---|---|---|
| `lib/openai-client.js` | `OpenAIClient`, `OpenAIError`, `parseUsage` | The main client. `chat()`/`chatStream()`, per-request metadata `meta` (route, tokens, headers), `onPhase`/`onMeta` hooks, `listModels()`, `abort()`, `extraHeaders`. Reads freellmapi headers `X-Routed-Via`, `X-Fallback-Trail`, `X-Fallback-Detail`, `X-Fallback-Attempts`, `X-Freellm-*` in `#headerMeta`. |
| `lib/ollama-client.js` | `OllamaClient` | `/api/chat` directly on lws; thinking modes (`--think`). |
| `lib/gemini-client.js` | `GeminiClient` | `generateContent`/`streamGenerateContent`. |
| `lib/trace-chat.js` | `traceChat` | Wraps a client's `chat` to watch a call it does not own (used by `NetActivity.wrap` for clients without `onPhase`). |
| `lib/text-tool-calls.js` | `extractTextToolCalls`, `aliasToolCall` | Tool calls a model wrote as text (`qwen2.5-coder` style) turned into structured ones. |

### Turn engine

| File | Exports / role |
|---|---|
| `lib/tool-requests.js` | `TOOLS` (schemas), `executeTool`, `writeCount`, `journalPaths`/`undoJournal`/`resetJournal` (`/undo`), `listFiles`. |
| `lib/modes.js` | `MODES` (`plan auto manual edits`), `needsApproval`, `toolAllowed`, `nextMode`, `PLAN_NOTE`, `describeWrite`. |
| `lib/turn-repair.js` | `repairTurn(messages, turnMsg, {sideEffects, reason})`: what to keep of a failed turn. |
| `lib/handoff.js` | `buildHandoff`, `summarize`, `digest`, `splitTurns`, `clipToolResults`, `buildKnowledge`, `HANDOFF_MODEL`: compacted conversation for a model switch or `/compact`. |
| `lib/failover.js` | `Failover`, `failoverNote`, `skipNote`: client-side failover for a **pinned chat-bridge site** only. |
| `lib/provider-fallback.js` | `ProviderFallback`, `classify`, `isGone`, `shortReason`: when the *endpoint* refuses (401/403, outage), cool the route down and go to the next provider, finally local Ollama. |
| `lib/fallback-trail.js` | `parseTrail`, `spentModels`, `trailText`, `TRAIL_SKIP_MS`: reads the gateway's `X-Fallback-Trail` (the hops that ran out before an answer). |
| `lib/skips.js` | `releaseRecovered`: a self-set skip ends early when a fresh availability says the model is usable again. |
| `lib/routing-health.js` | `routingHealth`: the one-line "gateway running dry" status. |
| `lib/latency.js` | `recordLatency`, `isDegraded`, `latencyReport`. |

### Model choice (gateway intelligence)

| File | Exports / role |
|---|---|
| `lib/availability.js` | `loadAvailability`, `reportChanges`, `noteIpChange`, `limitsText`, `limitedText`, `kindsText`, `backText`, `backShort`, `untilText`, `spanText`, `recordLocalFailure`, learned cooldowns (`saveCooldowns`/`loadCooldowns`), `groupId`. §12. |
| `lib/rating.js` | `Ratings` (state), `score`, `setRater`/`rateOf`, `setProviderRater`/`rateProvider`, `sortByRating`, `ratingCell`. §12. |
| `lib/exploration.js` | `Exploration` (cache + worker), `probeUsable` (tier 0/1), `isTransientProbe`, `probeCells`, `probeBrief`, `deepText`. §12. |
| `lib/probe-context.js` | `buildProbe`, `grade`, `deepBudget`, `plainQuestion`, `NEEDLES`: the synthetic compacted context of the deep probe. |
| `lib/diagnose.js` | `diagnose`, `causeOfError`, `parseTrail`: why a probe failed. |
| `lib/standby.js` | `pickNext`, `probeModel`, `isTransient`: the next model, one small pinned probe. |
| `lib/takeover.js` | `betterReason`, `stepText`: when a probed model deserves to take over a running task. |
| `lib/model-status.js` | `modelStatusTable`: rows of `/model health`. |
| `lib/key-models.js` | `loadKeyData`, `parseKeyScope`, `modelsOfKeys`: `/model key:ID,...` restriction. |
| `lib/delegates.js` | `Delegates`, `KINDS`, `discoverGateway`, `DELEGATE_NOTES`: which weaker sub-agent model did well for which job kind (`delegates.json`). |

### Gateway and network

| File | Exports / role |
|---|---|
| `lib/freellm.js` | `Gateway` (§11), `keyCells`, `FREELLM_URL`. |
| `lib/gateway-report.js` | `gatewayReport`, `reportText`: `/gateway status`. |
| `lib/proxy-probe.js` | `proxySettings`, `setProxyEnabled`, `proxied`, `measure`, `exitIp`, `newExit` (Tor `NEWNYM`), `PROBE_URL`, `EXIT_IP_URL`. |
| `lib/ip-check.js` | `externalIp`, `parseIp`, `isPublicIp`, `IP_HOSTS`. |
| `lib/ip-fix.js` | `ipCandidates`, `routedKeys`, `routedAll`, `setKeyProxy`, `clearCooldowns`, `ipProxyTargets`, `ipLimitedPlatforms`, `ANON_PROXY`. §14. |
| `lib/usage-baseline.js` | `baseline`, `baselineText`, `errorClass`: the numbers of usage.jsonl (turns, failure runs, per platform); run by `usage-baseline.js`. |
| `lib/harness-error.js` | `isHarnessError`: an error of our own code, not rated against a model, classed apart by the baseline. |
| `lib/cdp-token.js` | `dashboardTokenFromBrowser`: reads the dashboard session token over Chrome DevTools Protocol. |
| `lib/bridge-process.js` | `startBridge`, `pickModel`: `--provider bridge`. |
| `lib/net-activity.js` | `NetActivity`: in-flight HTTP requests with phases (feeds the net pane). |
| `lib/resources.js` | `ownSockets`, `processInfo`, `PORT_NAMES`: this process's sockets via `ss`/procfs. |

### Terminal UI

| File | Exports / role |
|---|---|
| `lib/tui.js` | `Tui`: layout, history with kinds, panels, split pane, status/input rows. §15. |
| `lib/chat-repl.js` | `ChatREPL extends REPL`: line editor, queue, dialogs (`choose`, `confirm`, `ask`), pager host, shortcut keys. §15. |
| `lib/pager.js` | `Pager`: full-screen scrolling view, optionally a selectable list with column filters. |
| `lib/look.js` | Colour palette, `note`, `card`, `panel`, `banner`, `meter`, `quotaCell`, `pctCell`, `toolLine`, `toolResult`, `highlight`, `gradientRule`, ... |
| `lib/ansi.js` | `piped` (stdout is not a tty), `red`, `yellow`, ... |
| `lib/usage-stats.js` | `UsageStats` (session ledger), `fitTable`, `formatTable`, `fmtNum`, `fmtMs`, `routeLine`, `routeName`, `formatMeta`. |
| `lib/net-pane.js` | `netPaneLines`, `hopsOf`, `kindOf`, `TYPES`, `annotateRates`: the `/split net` pane. |
| `lib/events.js` | `emit`, `setSink`, `setNamer`, `eventLine`, `eventsText`, `recent`: the background event channel. |
| `lib/markdown.js` | `MarkdownStream`, `highlight`, `inline`: markdown for the terminal, one line at a time. |
| `lib/rawcolor.js` | colouring of the raw content the verbose view shows. |
| `lib/quips.js`, `lib/session-name.js` | spinner words, funny session names. |

### Files, sessions, config

| File | Role |
|---|---|
| `lib/session-cache.js` | `cacheDir`, `sessionKey`, `sessionDir`, `sessionFile`, `loadSessionState`/`saveSessionState`, `debugLogPath`. |
| `lib/session-store.js` | `SessionStore`: `session.json` (messages, baseline, queue). |
| `lib/session-log.js` | `SessionLog`: plain-text transcript. |
| `lib/config.js` | `SETTINGS`, `globalSettings`, `setSetting`, `loadEnvFile`, `userSystemPrompt`, `writeConfigFile` (atomic write). |
| `lib/persist.js` | `appendUsage`, `readUsage`, `saveQuota`, `loadQuota`, `flushPersist`, `trimLogs`. |
| `lib/file-refs.js`, `lib/file-blocks.js`, `lib/file-exchange.js`, `lib/sent-files.js` | File names/globs in a prompt are attached; `File: path` blocks in a reply are written; diffs of what was exchanged. |
| `lib/project-brief.js`, `lib/reference-files.js`, `lib/binding-context.js`, `lib/imports.js` | Project scan, reference docs for QuickJS projects. |
| `lib/skills.js` | `/skill`: instruction files loaded into the conversation. |
| `lib/match.js`, `lib/paths.js` | Glob matching, `~` expansion. |
| `lib/run-command.js` | `runCommand`. |
| `lib/control-socket.js`, `lib/peer.js` | §17. |

## 5. `repl.js` anatomy

One file, in this order (use the names to navigate):

1. **Imports and constants** (≈1–200): `USAGE` (the `--help` text, every option
   documented here is the source of truth), `parseArgs(argv)` (≈208).
2. **System prompts** (≈300–440): `NOTOOLS_PROMPT`, `BRIDGE_PROMPT`,
   `BUILTIN_SYSTEM_PROMPT`, `SYSTEM_PROMPT` (replaced by `~/.config/ollama-repl/system.md`),
   `QJS_NOTES`, `NUDGE`, `asksForChange`, `omitToolsFor`.
3. **Prompt helpers**: `attachFiles`, `applyFileBlocks`, `resolveDir`.
4. **Spinner and phase** (≈500–650): `startSpinner`, `tuiSpinner`, `setPhase`,
   `phaseText`. `phase` feeds the status pane and the control socket.
5. **Module-level hooks and state** (≈650–700): `failoverHook`, `autoSkipHook`,
   `control`, `tui`, `ui.verbose`, `approveWrite`, `approveSelf`, `compactHook`,
   `handoffHook`, `ctxWindowNow`. They are assigned inside `main()` and read by
   `chatRound`/`runToolLoop` (which are module-level functions, not closures).
6. **Network and panels**: `watchNet`, `paneLines`, `statusPane` (the split
   pane), `showPanel`/`keepPanel`/`livePanel` (panels in the transcript,
   `livePanel` can be updated later), `setVerbose`, `inKind`.
7. **The turn engine** (≈980–1320): `providerFallback`, `waitUntil`,
   `backoff`, `chatRound`, `chatRoundOnce`, `elideOldToolResults`.
8. **Harness self-management** (≈1330–1590): `initHarness`, `snapshotHarness`,
   `purgeSnapshots`, `editsHarness`, `SELF_NOTES`, `prepareRestart`, `restartHook`.
9. **Delegation**: `spawnAgent` (≈1591), `delegateCandidates`, `delegateKey`.
10. **`runToolLoop`** (≈1719): the tool-calling loop. `gatherProjectContext`.
11. **Help and completion**: `HELP_TEXT`, `HELP_SECTIONS`, `REPORT_COMMANDS`,
    `TIPS`, `completeArgs` (Tab completion of slash-command arguments).
12. **Model-list state and helpers** (≈2090–2540): `modelStrength`, `tierOf`,
    `strengthColor`, `availability`, `gatewayRef`, `keyScope`, `modelScope`,
    `inKeyScope`, `exploration`, `ratings`, `modelInfo`, `ratingInputs`,
    `ratingOf` (+ `rateCache`), `getFilteredModels`, `resolveModel`,
    `skipModel`/`unskipModels`, `compactTable`, `showModelList`.
13. **`statusLines`** (≈2736): the three status rows of the TUI.
14. **`main()`** (≈2788–5530): everything stateful; §6. Inner functions (all
    closures over `opts`, `messages`, `client`, `gateway`, `stats`, `repl`, `tui`):

| Inner function | Role |
|---|---|
| `refreshStandby`, `standbyHook` | the warm standby model |
| `exploreEvent`, `explored`, `refreshExplored`, `diagnoseModel`, `deepFor`, `makeExploreClient` | exploration wiring |
| `showLikelyRoutes` | the startup panel of rated, probed routes |
| `autoProxy`, `recheckAfterIpChange`, `watchPace`, `fixKeyless`, `keylessProxy`, `loadProxy` | proxy and pace-time/IP events |
| `keyScopeCommand` | `/model key:...` |
| `considerTakeover`, `takeoverHook` | a better model takes the running task |
| `setMode`, `approve`, `confirmRun`, `askUser`, `forEach` | permissions and the `for_each` tool |
| `autoSkipHook` | automatic `/model skip` when the gateway is out of models |
| `gatewayView`, `backgroundReport`, `reportLine` | `/gateway ...` in the background |
| **`runLine`** (≈3943) | **the command and prompt dispatcher**: every slash command, `!cmd`, `/js`, and finally a plain prompt |
| `refreshGit` | the git split pane |
| `compactHook`, `handoffHook` | compaction and failover handoff |
| `restartHook` | `/restart` (§19) |
| `startControl` | the control socket (§17) |

## 6. Startup sequence

`main()` in order:

1. `parseArgs`, session name (`funnyName`), `initHarness(root)` + `snapshotHarness()` (§19).
2. `--provider bridge`: `startBridge` → looks like `openai` from here on.
3. Build `client` (`GeminiClient` / `OpenAIClient` / `OllamaClient`), `stats = new UsageStats()`,
   wire `client.onPhase` and `client.onMeta` (**every request's metadata lands
   in `onMeta`**: `stats.add`, `appendUsage`, `ratings.recordResult`, standby refresh,
   quota refresh, status redraw).
4. `ProviderFallback` hook (`providerHook`) with the local Ollama candidate.
5. If provider is `openai`: `gateway = new Gateway(client)`, `ratings`, `trimLogs()`,
   `loadCooldowns()`, `exploration` (cached results show at once), `gateway.detect()`;
   a bridge gets availability and optional standby; a real gateway gets
   `gateway.login(...)` (dashboard token, §11), `loadProxy(true)`, `gateway.refresh(true)`.
6. Session: `SessionStore.load()`, `--resume FILE` state, `messages` array.
7. TUI: `new Tui({status: statusLines...})`, `tui.start()`; banner.
8. Project scan (`gatherProjectContext`) as the first two messages unless resumed/failsafe/bridge.
9. "✔ ready"; `showLikelyRoutes()` (gateway) in the background; `setTimeout(autoProxy, 4000)`.
10. `repl = new ChatREPL(model, reportLine, root, abort, historyFile)`, hooks
    (`onImmediate`, `immediate`, `onToggleVerbose`, `onCycleMode`), `Failover`
    for a bridge, control socket if `--listen`.
11. `await repl.run()` — the readline loop; each submitted line reaches
    `runLine` through `ChatREPL#run`.

## 7. The life of a prompt

```
user line ─► ChatREPL.handleCmd ─► (busy? queue / immediate command / steer)
          ─► ChatREPL#run ─► onLine = reportLine ─► runLine(line)
```

`runLine` (inside `main()`):
1. Slash commands are matched by prefix in a long `if` chain (`/model`,
   `/gateway`, `/split`, ...). They print and `return`.
2. `!cmd` runs a shell command and feeds the output to the model as a tool result.
3. A plain prompt: `attachFiles` (file names/globs → file blocks via `lib/file-refs.js`),
   optional binding context, plan-mode and "for_each" hints, then
   `messages.push({role:'user', content, request})` and **`runToolLoop`**.
4. After the loop: `applyFileBlocks(reply)` (writes `File: path` blocks),
   `saveSession()`, git pane refresh.
5. On an exception: `repairTurn` (keep finished tool rounds if files changed or
   commands ran, else drop the whole turn), error line, `saveSession()`.

**`runToolLoop`** (`repl.js`): per round
1. `takeoverHook.hold(messages)` (a takeover candidate may pause this model),
   `compactHook(messages)` (compaction at `--compact-at` % of the window),
   `elideOldToolResults(messages, window)`.
2. **`chatRound`** → one model request (§10 for what wraps it).
3. Text-written tool calls are converted (`extractTextToolCalls`).
4. Assistant message pushed; if no tool calls: the **nudge** (the model was asked
   to change something, wrote prose instead — up to `MAX_NUDGES`=2 re-prompts) or return.
5. Each tool call: loop guard (`seenCalls`, `toolCache`, `MAX_REPEAT_ROUNDS`),
   approval by mode (`needsApproval`, `confirmRun`, `approveWrite`, `approveSelf`),
   `executeTool(...)`, result pushed as a `tool` message. Final round
   (`maxRounds` or repeats) is sent with `toolChoice: 'none'`.

**`chatRoundOnce`** is one request: spinner, verbose panels (`showPanel`),
`client.chat`/`chatStream`, streamed text through `MarkdownStream`, reasoning
as a live panel, first-token timeout (`--first-token-timeout`), `control.activity(...)`
events, the closing "cogitated" line with `routeLine(meta)`.

State shared across rounds: `messages` (the one conversation array; mutated in
place; callers snapshot `messages.length` to roll back), `writeCount`
(`tool-requests.js`, counts file writes), `shownMessages` (WeakMap: what the
verbose panel already printed).

## 8. Model clients

Common surface (all three clients): `chat(messages, {tools, toolChoice, ...})`
→ `{content, toolCalls?, reasoning?, meta}`; `chatStream`; `abort()`; `destroy()`;
`model` (mutable); `listModels()` (OpenAI only). `OpenAIClient` additionally:

- `extraHeaders` (`x-session-id` for sticky routing, `x-freellm-task-type: code`),
- `onPhase(name, meta)` (`waiting`, `streaming`, `idle`, ...), `onMeta(meta)`,
- `meta` fields: `requested`, `routedVia` (`platform/model`), `platform`,
  `status`, `ttfbMs`, `firstTokenMs`, `ms`, `usage` (prompt/completion/reasoning/cached),
  `trail`/`detail`/`fallbacks` (the gateway's failed hops), `rateLimit`,
  `headers` (all `x-*`), `error`, `proxied` (set by `main`),
- errors: `OpenAIError` with `status`, `detail`, `headers`, `body`, `code` (`'timeout'`).

Clients for side work are separate instances pinned to one model:
`makeClient(model)` (standby probes), `makeExploreClient(id)` (exploration, headers
`<session>-explore`), both wrapped by `watchNet(c, label)` so the net pane
colours their connections.

## 9. Tools the model can call

`lib/tool-requests.js` `TOOLS`: `list_directory`, `read_file`, `grep`,
`insert_above`, `edit_file`, `write_file`, `for_each`, `run_command`,
`ask_user`, `restart_harness`, `spawn_agent`. `executeTool(name, args, ctx)`
runs them; file writes go through the journal (`/undo`). Which tools exist in a
turn: `runToolLoop` filters by `forEach`/`opts.omitTools`/`toolAllowed(mode, name)`.
`lib/modes.js`: `plan` read-only, `auto` free, `manual` asks for every write and
command, `edits` (default) free writes, asked commands. Changes to the
harness's own files always ask (`approveSelf`, `--self-edit` to waive). You
can now also choose "Yes, whole session" to remember your preference for the
duration of the session.

`spawn_agent` → `spawnAgent` (`repl.js`): isolated conversation, either another
ollama-repl instance found by `lib/peer.js` (`findPeers`, `askPeer`) or the same
process with another model; chosen by `Delegates.rank` and recorded
(`/delegate good|bad`).

## 10. Failover: what happens when a request fails

All inside `chatRound` (`repl.js` ≈1028), in this order, each step either
`continue`s the loop with another model/route or falls through:

1. **Cooling route**: `providerHook.pf.cooling(...)` → skip to the next provider.
2. `chatRoundOnce`. On error: `classify(e)` (`provider-fallback.js`) and
   `recordLocalFailure` (`availability.js`, shadow block so the model is not
   picked again at once).
3. **Short rate limit**: the model's `availability` entry says it is back within
   120 s → wait on the same model (`waitUntil`), keeping the prefix cache.
4. **`autoSkipHook`** (`/model skip` automatically, ≤ `AUTO_SKIPS`=8 per round):
   the gateway ran out of models, an upstream failure, a gone model, or a timeout;
   picks the **next model by rating** (`pickNext` with `rate: rateOf`, standby first).
5. **Standby**: a warm standby model takes the turn if the error is transient
   (`isTransient`).
6. **`Failover`** (bridge, pinned site only): next site + `failoverHook.handoff`
   (compacted conversation, `buildHandoff`) + `onSwitch`.
7. **`providerFallback`**: endpoint refuses/out of quota/down → next provider,
   finally local Ollama.
8. **Backoff** (`BACKOFF_SECS` 30/45/60) with everything released, then surface the error.

Skipped models live in `skippedModels` (Map, 10 min, `skipModel`, `releaseRecovered`
ends self-set skips when availability shows recovery) and are saved over `/restart`.

## 11. The gateway subsystem

`lib/freellm.js` `Gateway` wraps an `OpenAIClient` pointed at a freellmapi.
Two APIs:

- **Public** (`/v1/...`, the client's key): `/v1/usage` (month ledger, `byPlatform`,
  `byKey`), `/v1/providers`, `/v1/quota-forecast`, `/v1/models` (catalog,
  `execution_status` ready/needsKey/exhausted, `context_window`).
- **Dashboard** (`/api/...`, needs a session): `/api/keys` (keys: cooldowns,
  caps, `maskedProxyUrl`, `keyless`, `modelScope`), `/api/keys/providers`,
  `/api/fallback` (+ `/routing`, `/rate-limit-usage`, `/token-usage`,
  `/penalty-inspector`), `/api/models`, `PATCH /api/keys/:id {proxyUrl}`,
  `DELETE /api/keys/:id/cooldowns`, proxy settings.

Session token: `Gateway.login()` tries `FREELLMAPI_DASHBOARD_TOKEN`, then
`FREELLMAPI_EMAIL`/`PASSWORD` (`POST /api/auth/login`), then the token of a
logged-in dashboard tab over CDP (`lib/cdp-token.js`). `gateway.dashboard` is
true afterwards; `hasLimits` says the limit APIs answer; `isBridge` marks a chat-bridge.

`Gateway.refresh(force)` (throttled by `REFRESH_MS`=3 s) fills `state`
(`usage`, `rate`, `budget`, `dashModels`), writes `saveQuota` (quota snapshot is
loaded first at startup, `snapshotAt` marks stale data), and runs the
**reports**: `#reportQuota` (80/95/100 % of the month budget → `emit('quota')`),
`#reportKeys`, reachability events.

Text views: `usageText`, `keysText`, `providersText`, `forecastText`,
`quotaText`, `modelsText`, plus `availability.js` `limitsText`/`limitedText`.
All tables use `fitTable` (§15) and one line per entry at any width.

`gatewayRef` (module level) is the same object as `gateway` for module-level
helpers (`modelInfo`, `ratingInputs`).

## 12. Availability, rating, exploration (choosing models)

Three data sources combine into "which model next":

### Availability (`lib/availability.js`, `loadAvailability(gateway)`)

Joins `/v1/models`, `/api/models`, the rate-limit and token-usage tables, the
penalty inspector and `/api/keys` into `av.byModel: Map<id, entry>` with
`{blocked, permanent, until, approx, kinds[], blocks[], platforms[], status,
intelligence}`. `kinds`: `rpm tpm rpd month cap cooldown ip credit tier scope key exhausted`.
The gateway reports exhausted-ness, not recovery times: `until` is computed
(minute window ≤ 60 s, key cooldown expiry, next UTC month, daily window ≤ 24 h
marked `approx`). `IP_ERROR` (regex over the last upstream errors) relabels a
cooldown as `ip`. Learned cooldowns and local shadow blocks are persisted
(`cooldowns.json`). `reportChanges(av)` diffs consecutive loads and emits
"limited / usable again (pace time over / accessible after IP change)"
events; `noteIpChange()` marks an exit-address change for 15 min.

### Rating (`lib/rating.js`)

`score(rec, inputs)` → 0..100: intelligence (gateway score or name tier, up to
55), context window (+4..−4), learned adjustment (decays, half-life 7 days,
capped ±25) and request success share, latency, probe result (tier 0/1), state
now (limited −40, cooling −10, quota nearly used −8). Limit-type failures
(429, quota, cooldown) do not count against the model. `Ratings` persists to
`ratings.json`; `recordResult` (real requests, from `onMeta`), `recordProbe`
(exploration; transient failures are ignored). `repl.js` glue: `ratingInputs(id)`,
`ratingOf(id)` with a 5 s `rateCache` invalidated by `availability.at` and
`ratings.version`, `setRater(ratingOf)` so every list sorts "best first" via
`rateOf`. **Perf rule**: `modelInfo(id)` uses an indexed `WeakMap` (`infoIndex`);
never scan the budget rows per call (that cost 27 s once).

### Exploration (`lib/exploration.js`)

`Exploration.run(ids, makeClient, {concurrency=2, tools, deep, force, diagnose,
onEvent, onResult, onDone})`: background worker lanes on the main loop.

- **Tier 0** (`probeUsable`): one tiny request with a `ping` tool (does it answer,
  call tools, how fast). **Tier 1** (`probeDeep`, only for `deep(id) > 0`, i.e. the
  30 best rated, `deepFor` in `main`): a fixed synthetic compacted conversation
  (`lib/probe-context.js` `buildProbe`: system prompt, summary with filler, harness
  tool schemas, three "needles" at 10/50/90 % depth) sized to a quarter of the
  model's window (`deepBudget`, 1.5k–12k tokens); it must report the facts in
  one `report_findings` call (`grade`). Result in `entry.deep`.
- **Failures are diagnosed in the worker** (`opts.diagnose` = `diagnoseModel`,
  `lib/diagnose.js`): error text + the gateway's state for the model, provider
  and keys; a "flaky" verdict (second try answers) re-runs the probe. Stored:
  `diagnosis {cause, detail, transient, retryInMs, steps}`, `retryAt`.
  `isTransientProbe(e)` (busy provider) → no rating penalty, retry in 10 min;
  a real failure retries after 1 h (`FAIL_TTL_MS`) and keeps the model out of the
  startup list; tier-1 failures retry after 6 h.
- `fresh(id)` / `needsDeep(id)` decide what is probed again; `force` (sweep) ignores the cache.
- Results cache: `exploration.json`, key `ORIGIN|MODEL`; `setLive` adds reachability/limit state.

Wiring in `main()`: `exploreEvent` (events + one live panel per worker lane,
verbose-only), `explored` (rating update, standby fill, `considerTakeover`),
`refreshExplored`, `showLikelyRoutes` (startup panel: 8 best rated, probe column
fills in), `/model health`, `/model explore PATTERN` (sweep), `/model sweep`.

### Scopes

`keyScope` (`/model key:ID,...`, restricts to models a key reaches,
`lib/key-models.js`) and `modelScope` (`/model a,b,c`) combine in
`inKeyScope(id)`; `pickNext(..., {allowed: inKeyScope})`, the likely-routes list,
standby and takeover honour it. `inKeysOnly` (key scope alone) is used by the
sweep so a sweep can find models outside the list.

## 13. Standby, takeover, handoff, compaction

- **Standby** (`--standby`, `lib/standby.js`, `refreshStandby`/`standbyHook`): the
  model the gateway would pick next (by rating), pinned and probed so it is warm;
  `/standby`. Used by failover step 5 and as a sub-agent model.
- **Takeover** (`considerTakeover`, `lib/takeover.js`): when `explored()` finds a
  tool-capable model that `betterReason` calls better (stronger tier, or
  ≥2× faster) *while a request runs*, the running model pauses at its next step
  (`takeoverHook.hold`), the candidate gets a compacted handoff, says what it
  would do (`stepText`), the user is asked (`repl.choose`), then the model is
  switched. `--no-takeover` disables; declined models are not proposed for 30 min.
- **Handoff / compaction** (`lib/handoff.js` `buildHandoff`): base messages stay,
  last N turns (`--handoff-turns`) verbatim with big tool results clipped, older
  turns summarised by a *local* Ollama model (never the exhausted site; a plain
  `digest` if it is unreachable). `compactHook` runs it at `--compact-at` % of the
  window or on `/compact`; `handoffHook` is `/handoff-model`.

## 14. Proxy and IP handling

Why: keyless providers and some keyed ones limit per IP address.

- `lib/proxy-probe.js`: reads/sets the gateway's upstream proxy, measures its
  overhead (`measure`), asks the exit address (`exitIp`), and `newExit` opens the
  Tor control port itself (`AUTHENTICATE`, `SIGNAL NEWNYM`, `QUIT`; no script).
- `lib/ip-check.js` `externalIp`: direct or via SOCKS, several "what is my IP" hosts.
- `lib/ip-fix.js`: `ipCandidates` (keyless keys with limited models),
  `ipProxyTargets` (keyless keys + the keys of providers with several keys that have no proxy; a provider's only key goes direct),
  `setKeyProxy`, `clearCooldowns`.
- `main()`: `/proxy [on|off|exit|keyless [apply|clear|fix]|auto]`; `fixKeyless`
  (route keys through the proxy, NEWNYM, probe the new address, clear cooldowns,
  test one request per provider, a second round if needed); **`autoProxy`** (default
  on; startup + when a platform turns IP-limited + every 5 min; targets: keyless keys and keys of providers with several keys; only if the proxy
  answers; `--no-auto-proxy`); `watchPace` (every 10 s, "pace time ran out" events)
  and `recheckAfterIpChange`.
- Limits of the detection (see `TODO.md`): "per IP" is inferred (keyless flag,
  error text matching `IP_ERROR`); the gateway exposes no per-IP flag.

## 15. The terminal UI

### `lib/tui.js` `Tui`

Rows: transcript scroll region on top; a rule with the activity (spinner);
input rows (grow with text); status rows (3). Everything printed with
`console.log` while the TUI is active goes through `Tui` into a flat history:

- `#hist` lines with parallel `#kinds` (0 always, 1 verbose-only, 2 compact-only)
  and `#owner` (panel id). `setVerbose(on)` switches views, past lines included;
  `write(text, kind)` appends.
- **Panels**: `openPanel(text, kind)` returns an id, `updatePanel(id, text)`
  splices the lines and repaints at most every `REPAINT_MS`=120 ms.
  `repl.js` wraps them: `showPanel`, `keepPanel` (full text for `/view N`),
  `livePanel` (returns `{n, update}`), `backgroundReport` (live "loading …"
  panel, then the result).
- **Split pane** (`setPane(fn)`, `drawPane`): right-hand column (≥80 cols);
  content from `paneLines` (`repl.js`): `diff`, `git`, `status`, `net`.
  `/split [diff|git|status|net|off|next|prev]`; keys in `ChatREPL`:
  F2/Shift-F2, Alt-1..4, Alt-0, Alt-\\, Ctrl-X d/g/s/n/o/Tab (`SPLIT_CHORD`).
  `tui.width` excludes the pane; use `panelInner()` for table widths.
- Drawing: `drawRule`, `drawStatus`, `drawInput`/`drawEditor`, `ensureInputRows`,
  `suspend()`/`resume()` around the pager (alternate screen).

### `lib/chat-repl.js` `ChatREPL extends REPL`

- `handleCmd(expr, from)` (submitted line): queueing while busy (`#queue`,
  `restoreQueue`, `dropQueued`), steering (`Ctrl-X Ctrl-S` → `sendNow`, stop words
  cancel the request), `onImmediate`/`immediate` (instant commands run beside a
  running request), `/model NAME` while busy switches and re-sends.
- `runNow(line)`: run a command from a shortcut key at once.
- **Dialogs**: `choose(question, options, {view, drop})` — options are strings or
  arrays of cells (aligned columns, `drop` = column indexes dropped first when
  narrow, selected row highlighted, long lists scroll with PgUp/PgDn/Home/End),
  `confirm`, `ask`. A control-socket line answers a dialog too.
- `openPager(title, text, {select})` → `Pager`. Select mode: cursor, marks
  (space, shift+↑↓ range, `a`, `c`), actions (`Enter`, `e`), column filters
  (←/→ focus a header, type to filter, Backspace, Ctrl-U, Esc Esc) with the
  table rebuilt by `select.build({rows, focus, filters})`; only visible rows are
  decorated (the cut is the slow part).
- Keys registered in the constructor: Shift-Tab/Alt-Tab (mode), Ctrl-O (verbose),
  Ctrl-X chords, PgUp/PgDn, split keys. **`ChatREPL` has exactly one
  `handleKey`** (§22); chord and dialog logic live in it.

### Rendering helpers

- `lib/look.js`: palette (`STOPS`, `ACCENT`, `WARN`), `note(text, kind)`,
  `card(emoji, title, items, colour)` (title + indented bullets),
  `panel(title, text, cols, {max, more, border})`, `meter`, `quotaCell`, `pctCell`.
- `lib/usage-stats.js` **`fitTable(width, make, flex, drop)`**: `make(bar)` returns
  rows with meters of `bar` cells; meters shrink (6, 3, 0), flexible columns
  (indexes in `flex`) are cut with an ellipsis (ANSI-aware `cut`), columns in
  `drop` disappear in order. Rule: **one entry, one line, at any width**.
  Use it for every table; `formatTable` only for fixed-size output.
- `repl.js` helpers: `fgHex`, `strengthColor(tier)`/`tierOf(id)` (the rainbow of
  `/model list`: model names are coloured by strength everywhere),
  `leftCell(id)` (what is left of a model), `likelyModels` (picker candidates).

### Verbose and events

`ui.verbose` (Ctrl-O): full tool results, every request/response with headers,
reasoning, raw content (`lib/rawcolor.js`). Background events
(`lib/events.js`: `emit(kind, text, level)`, kinds `explore gateway quota key
failover standby takeover rating proxy`; levels good/info/warn/bad) go to a ring
buffer (1000), `/events`, and — through `setSink` — to the transcript tagged
**verbose-only**. `decorateExplore` gives explore lines emoji/colour; `setNamer`
colours model ids by strength.

### Status bar (`statusLines`)

Left: mode, project path; centre: effective model (`routeName`), routed-via,
provider; right: context meter. Second row: last usage, last error (shown 90 s,
then a failure count), session totals, quota meters, key/model scope marks,
routing health. Third: hints.

## 16. Commands: how they are wired, how to add one

A slash command touches up to six places:

1. **`runLine`** (`repl.js`): `if(prompt === '/x' || prompt.startsWith('/x ')) { ... return; }`.
   Keep handlers short; put logic in a `lib/` module and test it.
2. **`HELP_TEXT`** (one line per command, argument syntax first) — `/help` and
   the README must agree.
3. **`HELP_SECTIONS`** (the `/help` grouping) and **`REPORT_COMMANDS`** (commands
   whose output is shown as a report panel).
4. **`INSTANT`** regex list in the `!piped` block (≈5155): commands that may run
   while a request is running (read-only views, flags). `GATEWAY_VIEW` routes
   `/gateway ...` to `reportLine` → `gatewayView` → `backgroundReport` (non-blocking).
5. **`completeArgs(cmd, args, word)`** (Tab completion), plus the `case '/x':` list.
6. **`README.md` and `TODO.md`** (project rule: update the subproject `TODO.md`
   whenever work changes the state of what it describes).

Slow commands must not block: use `backgroundReport(prompt, async () => text)`
(live panel) or a worker + `emit`. Output while a request streams goes straight to
the transcript; do not open a panel that captures stdout in an instant command.

## 17. Control socket, peers, delegation

`lib/control-socket.js` `ControlSocket`: a Unix socket `$XDG_RUNTIME_DIR/ollama-repl/o<pid>.s`
plus `<pid>.json` (name, model, root). Client → server: lines of input (Ctrl-X
Ctrl-S prefix steers). Server → client: JSON lines `hello accepted output
waiting ready info activity`. `activity` phases: `request reasoning answer
toolcall toolresult idle`. Started by `--listen` or `/remote-control`
(`startControl` in `main`). `control.event/update/activity` calls are scattered
through `chatRound*`, `runToolLoop`, failover (`providerHook.announce`).
`ctl.js` is the client; `lib/peer.js` lets one session hand a task to another
(`findPeers` on the same root, `askPeer`), used by `spawnAgent` and `/delegate`.
`--worker` makes a session a delegate target.

## 18. Persistence: every file the program writes

| Path | Writer | Content |
|---|---|---|
| `~/.config/ollama-repl/settings.json` | `config.js` `setSetting` | defaults for options (`SETTINGS`) |
| `~/.config/ollama-repl/env` | user | `KEY=VALUE` environment (`FREELLMAPI_*`) |
| `~/.config/ollama-repl/system.md` | user | replaces the built-in system prompt |
| `~/.config/ollama-repl/delegates.json` | `delegates.js` | sub-agent model track record |
| `~/.cache/ollama-repl/sessions/<key>/session.json` | `SessionStore` | messages, baseline, queue |
| `.../session.log`, `history`, `state.json`, `diffs/` | `SessionLog`, `ChatREPL`, `session-cache.js`, `FileExchange` | transcript, input history, `/model` pattern and picked model, file diffs |
| `~/.cache/ollama-repl/exploration.json` | `Exploration` | per-model probe results (`ORIGIN\|MODEL`) |
| `~/.cache/ollama-repl/ratings.json` | `Ratings` | per-model rating state |
| `~/.cache/ollama-repl/usage.jsonl` | `appendUsage` | one line per request (trimmed to 90 days) |
| `~/.cache/ollama-repl/quota.json`, `quota.jsonl` | `saveQuota` | last gateway snapshot; 15-minute history (180 days) |
| `~/.cache/ollama-repl/cooldowns.json` | `availability.js` | learned cooldowns, shadow blocks |
| `~/.cache/ollama-repl/logs/` | `session-cache.js` `debugLogPath` | `-x` debug logs |
| `$XDG_RUNTIME_DIR/ollama-repl/` | `ControlSocket` | sockets and info |
| `/tmp/ollama-repl-restart-<pid>.json`, `$TMPDIR/ollama-repl-resume-*.json(.bak)` | restart (§19) | restart request, resumed state |

`XDG_CACHE_HOME`/`XDG_CONFIG_HOME` override the bases (tests set them to a temp dir).
All JSON writes use `writeConfigFile` (write + rename). Persisted data survives
a restart and is the source for startup lists (likely routes need no network).

## 19. Self-edit and restart

The harness can edit and restart itself (`/restart`, the `restart_harness` tool).

- `initHarness(root)` finds the source tree (`isSourceTree`: has `smoke.sh` and
  `repl.js`) — the running script, or one next to the project — and
  `snapshotHarness()` copies the running version aside (`harness.snap`).
- Edits to the harness's own files ask the user every time (`touchesHarness`,
  `approveSelf`, `--self-edit`); `SELF_NOTES` tells the model.
- `prepareRestart(opts, messages, base, overrides)`: runs the **check** first —
  from a source tree `sh smoke.sh repl.js` (≈13 s: imports of every `lib/*.js`,
  a few tests, a pty start with 7 commands; timeout 180 s), else `qjsm repl.js --help`.
  A failing check aborts and leaves the session unchanged. Then it writes the
  state (messages, model, mode, skips, queue, session id) to a temp file and
  returns the new argv (`--resume FILE`) and a fallback (the snapshot).
- `restartHook`: runs cleanup handlers, then either hands the request to the
  parent process that started it (`OLLAMA_REPL_RESTART_FILE`, exit code 75) or
  becomes a supervisor that `exec`s the new process, falls back to the snapshot if
  it dies within 15 s, and loops while children ask for another restart.
- The conversation, session id (sticky routing, handoff) and queue survive.

## 20. Tests and verification

- `test-*.js` in this directory: plain scripts, `qjsm test-x.js`; a test throws
  (or exits non-zero) on failure and prints `test-x: ok`. Run all:
  `for t in test-*.js; do qjsm $t >/dev/null 2>&1 || echo FAIL $t; done`.
  They use mocks and fixtures only; **none runs against a live gateway** (see
  `TODO.md` for what was never seen in a real terminal).
- `test-pager-select.js` needs a tty (`script -qec "qjsm test-pager-select.js" /dev/null`);
  it skips itself otherwise.
- `smoke.sh [REPL.js]`: the restart gate (§19); `SMOKE_ARGS`, `SMOKE_WAIT`.
- Syntax: `node --check file.js` is a fast pre-check (the code is plain ES modules).
- Add a test per new `lib/` module, named after it; keep tests independent of the
  network and of `~/.cache` (set `XDG_CACHE_HOME` to a temp dir *before* importing
  modules that read it, as `test-exploration.js` does).
- When a test needs the `terminal` module's speed or a real terminal, say so in its header.

## 21. Conventions and invariants

- **Language**: code, comments, docs, commit messages in English.
- **Comments**: block comments above functions explain *why* and the data shape;
  lower-case style, no ceremony. Public functions of a `lib/` module have a short
  usage example in the file header.
- **Surgical changes**; match the surrounding style (2-space indent, single
  quotes, `if(` without a space).
- **Commits**: stage files by name; no `Co-Authored-By` trailers in this project;
  changes under `examples/` are not logged in the repo-root `ChangeLog` (they
  keep `TODO.md`).
- **`TODO.md`** is the project's task list: every feature gets a "Done / Open"
  section; update it in the same change.
- **One entry per line in every table** (`fitTable`), colours via the shared
  palette (`look.js`), model names coloured by strength, times and percentages
  amber, good green, bad red/orange.
- **Never block the loop** (§2); **never scan big tables per call** (cache with a
  `WeakMap`/TTL); **never call `terminal.js` `truncate`/`wrap` on hundreds of lines
  per key press** (§22).
- **Background work reports through `emit`** (verbose-only) and only the result
  the user asked for goes to the normal view.
- **Hooks are module-level** (`let xHook = null`) and assigned in `main()`;
  `lib/` code never reaches back into `repl.js`.
- **Privacy**: the exploration and probes send only synthetic text
  (`probe-context.js`), never the user's conversation, to the many free providers.

## 22. Gotchas that have bitten before

- **Duplicate class methods**: in JavaScript the later `handleKey` silently
  replaces the earlier one. `ChatREPL` once had two; the Ctrl-X chord lived in
  the shadowed one and never ran. Grep `^  name(` before adding a method.
- **`terminal.js` width functions are slow** (`charWidth` scanned range tables
  per character; ~1.2 ms per line in `truncate`, ~2 ms in `wrap`). A 613-row
  list took ~0.8 s per key. Mitigations: decorate/cut only visible rows
  (`Pager#decorate`); a faster `terminal.js` is in the qjs-modules repo (install
  pending). Do not "fix" it in this tree.
- **Rating cost**: `modelInfo` must stay O(1) per call (`infoIndex`).
- **Epoll was not the culprit** for a blocked TUI: measure with `setTimeout` lag
  before blaming the event loop.
- **Panels capture stdout**: do not open a panel in a command that runs while a
  reply streams.
- **Lone Esc vs. Esc sequences**: the editor delivers Alt-keys as `ESC`+key and
  `Esc Esc` as one key string; chat-repl treats a lone Esc specially (≈line 255).
  Alt shortcuts may be eaten by the terminal; every shortcut has a Ctrl-X chord.
- **`QUICKJS_MODULE_PATH`** uses `;` and replaces defaults (§2).
- **`lws.so` single runtime** (§2); `cmake --install .` in the source root can
  delete the installed `lws.so` (see `examples/ollama-repl` README / registry notes).
- **freellmapi quirks**: the key in `X-Fallback-Trail` is an *ordinal* (`key2`),
  never an id; a successful request shows no key. Dashboard calls need a session;
  without one `availability`, ratings by quota, exploration diagnosis and key
  tables degrade (`gateway.dashboard`, `hasLimits` checks everywhere).
- **Transient vs real probe failures**: a busy provider must not lower a rating;
  `isTransientProbe` and `diagnose` decide; never treat a 429 as "model bad".
- **Reasoning models** write their thinking into the content: the old
  system-prompt probe called them disobedient (16 of 276 models); tier 0/1 grade
  tool calls and recalled facts, not style.
- **Restart safety**: anything the restart check imports must load without a
  network and without `~/.cache` state; keep `lib/*.js` import-clean.

## 23. Glossary

- **gateway / freellmapi**: the local OpenAI-compatible router over free providers.
- **bridge / chat-bridge**: free chat web sites behind an OpenAI API.
- **route**: `platform/model` a request is served by (`X-Routed-Via`).
- **row**: one provider's entry for a model in the gateway tables (`platform/modelId`).
- **model id**: the gateway's unified id (`groupId` merges provider variants).
- **READY / limited / cooling**: availability states; `kinds` say which limit.
- **pace time**: how long a window/cooldown still has to run before a limited
  model is usable again.
- **tier**: model strength 0 (strongest, violet) … 9 (unknown, green), from the
  gateway's `intelligence` or the name (`modelStrength`).
- **rating**: 0..100 "how good a pick is this model now" (`lib/rating.js`).
- **tier 0 / tier 1 probe**: the cheap tool-call probe / the synthetic-context probe.
- **standby**: the warm second model.
- **takeover**: a better model picking up a running task.
- **handoff / compaction**: the summarised conversation given to a new model.
- **sweep**: `/model explore PATTERN`, re-probing matching models.
- **verbose-only line**: transcript line of kind 1, visible only with Ctrl-O.
