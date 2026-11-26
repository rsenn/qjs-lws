# ollama-repl architecture

What an implementor must know to change ollama-repl without breaking it. Every
claim names the source file and the function or class it lives in. Line numbers
(`≈NNNN`) are hints that were true on 2026-11-25; the names are the reference,
use `grep -n` when a line has moved.

Companion documents: `README.md` (user manual, every command and option),
`TODO.md` (open work only), `doc/PLAN.md` (the same work split into coarse tasks with steps and order), `BUGS` (open defects), `doc/HEALTH-EXPERIMENTS.md` (model health data, the fixes made from it and
what is left), `doc/GATEWAY-PROPOSALS.md` (changes wanted in freellmapi),
`reference/`
(QuickJS binding reference given to models that write bindings).

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

- a local **Ollama** (`lib/clients/ollama-client.js`),
- **Gemini** (`lib/clients/gemini-client.js`),
- any **OpenAI-compatible** endpoint (`lib/clients/openai-client.js`), in practice a
  **freellmapi gateway** (an OpenAI-compatible router over dozens of free
  providers, `~/Sources/freellmapi`) or a **chat-bridge** (`examples/chat-bridge`,
  free chat web sites behind an OpenAI API, started by `lib/gateway/bridge-process.js`).

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
  `lib/gateway/exploration.js` header repeats the rule). "Background" work (the
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

- **Finding a stall (2026-11-25, `lib/lag.js`).** Two instruments, always on, no option.
  `startLagWatch()` is a 100 ms timer that measures how late it fires; a lag of 150 ms or
  more is one `lag` event (`/events lag`, verbose view) and one line of
  `~/.cache/ollama-repl/lag.jsonl` (`at`, `lagMs`, `phase`, the slow sections that ended
  inside the stall). `timed(name, fn)` wraps a synchronous section that may be heavy
  (`getFilteredModels`, `likelyModels`, `statusLines`, `paneLines`, the compute part of
  `loadAvailability`, `reportChanges`, `saveQuota`); a section of 100 ms or more is a `lag`
  event naming it and its duration. The watch says *that* and *when* the loop was
  blocked, the sections say *where*; a stall with no slow section was spent in code that is
  not wrapped yet (add a `timed`) or in a blocking syscall (strace). Cost: ten wake-ups a second.
- **Native modules used**: `lws.so` (via `lib/lws/*` wrappers `fetch`-like
  `httpClient` protocol adapter, `lib/lws/protocols.js`), `terminal` (qjs-modules
  `lib/terminal*`: the facade `terminal` and the parts `terminal/style`, `screen`, `widgets`,
  `scrollview`, `capabilities`, `keys`, `lineeditor`, `core`: `ScrollView`, `Region`,
  `truncate`, `wrap`, `stringWidth`, `ttyWrite`, `windowSize`, `panel`, `meter`, ...), `repl` (qjs-modules readline
  `REPL` base class), `sockets` (`TCPSocket`, `Socket`, `SockAddr`, used for the
  control socket, Tor control port, CDP), `textcode`, `os`, `std`, `fs`.
- **Module path.** `qjsm` finds native modules through `QUICKJS_MODULE_PATH`
  (separator `;` on this build). A path override must list every directory
  needed (`lws.so` lives in `build/<triplet>`), otherwise unrelated tests fail
  with "could not load module filename 'lws.so'".

## 3. Layers at a glance

```
 ctl.js ──────────────► lib/agent/control-socket.js            external controllers (Claude Code, scripts)
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

Dependency rule: `lib/**/*.js` never import `repl.js`. State that `lib` modules
need from `repl.js` is injected (`setRater`, `setNamer`, `setSink`, callbacks
passed to `Exploration.run`, the `*Hook` objects below). `repl.js` is the only
place that knows about all subsystems.

## 4. Source map (every file)

### Layout of `lib/` (decided 2026-11-26)

`lib/` has a flat base and seven directories. A file imported by files of several groups is base; a file that
belongs to one area goes into that area's directory (the import graph showed 42 of the 76 files used by `repl.js`
alone, and 12 shared by 5 to 9 files).

| Directory | Holds |
|---|---|
| `lib/` (base, flat) | what every area uses and that knows no area: `config`, `paths`, `match`, `look`, `ansi`, `palette`, `lag`, `events`, `run-command` |
| `lib/clients/` | the model clients and what sits directly on a wire: `ollama-client`, `openai-client`, `gemini-client`, `provider-fallback`, `text-tool-calls`, `trace-chat`, `pricing` |
| `lib/gateway/` | the gateway, availability, rating, exploration, key and probe handling, the proxy and address checks |
| `lib/failover/` | what happens when a request fails or a model is replaced: `failover`, `fallback-trail`, `hop-line`, `standby`, `takeover`, `handoff`, `turn-repair` |
| `lib/tui/` | everything drawn: `tui`, `chat-repl`, `pager`, `markdown`, `rawcolor`, panes, transcript text |
| `lib/project/` | the project's files: file blocks, exchange and references, sent files, the brief, imports, binding context, resources |
| `lib/session/` | what a session keeps and counts: the cache, log, name, store, `persist`, usage and its statistics and baseline |
| `lib/agent/` | the turn's tools and helpers: `tool-requests`, `modes`, `skills`, `delegates`, `harness-error`, `diagnose`, and the control socket with `peer` |

Rules: a new file starts in the directory of the one area that uses it; when a second area imports it, it moves
to the base. Imports between the directories are allowed; a cycle between two directories is a reason to move the
shared part to the base. Tests stay flat in `tests/`. Moves are done with
`move-modules -g -X -m MAP -r .` (tool-registry), never by hand; install rule, `smoke.sh` and `check-names.cjs` find
`lib/` files recursively.

### Entry points

| File | What |
|---|---|
| `repl.js` | The program. ~5500 lines: arg parsing, prompts, the turn engine, all slash commands, all background wiring. §5. |
| `ctl.js` | `ollama-repl-ctl`: `list`, `send`, `watch`, `monitor`, `steer`, `cancel`, `restart` against a session's control socket. |
| `usage-baseline.js` | `qjsm usage-baseline.js [--days N] [--origin URL] [--json]`: the health numbers of `usage.jsonl` (over `lib/session/usage-baseline.js`). |
| `check-names.cjs` | `node --expose-internals check-names.cjs repl.js $(find lib -name '*.js')`: names used but not declared, and doubly declared names (§22). |
| `smoke.sh` | Restart gate and quick check: imports every `lib/**/*.js`, runs a few tests, starts the REPL in a pty and sends 7 commands. §19–20. |

### Model clients (`lib/clients/*-client.js`)

| File | Class | Notes |
|---|---|---|
| `lib/clients/openai-client.js` | `OpenAIClient`, `OpenAIError`, `parseUsage` | The main client. `chat()`/`chatStream()`, per-request metadata `meta` (route, tokens, headers), `onPhase`/`onMeta` hooks, `listModels()`, `abort()`, `extraHeaders`. Reads freellmapi headers `X-Routed-Via`, `X-Fallback-Trail`, `X-Fallback-Detail`, `X-Fallback-Attempts`, `X-Freellm-*` in `#headerMeta`. |
| `lib/clients/ollama-client.js` | `OllamaClient` | `/api/chat` directly on lws; thinking modes (`--think`). |
| `lib/clients/gemini-client.js` | `GeminiClient` | `generateContent`/`streamGenerateContent`. |
| `lib/clients/trace-chat.js` | `traceChat` | Wraps a client's `chat` to watch a call it does not own (used by `NetActivity.wrap` for clients without `onPhase`). |
| `lib/clients/text-tool-calls.js` | `extractTextToolCalls`, `aliasToolCall` | Tool calls a model wrote as text (`qwen2.5-coder` style) turned into structured ones. |

### Turn engine

| File | Exports / role |
|---|---|
| `lib/agent/tool-requests.js` | `TOOLS` (schemas), `executeTool`, `writeCount`, `journalPaths`/`undoJournal`/`resetJournal` (`/undo`), `listFiles`. |
| `lib/agent/modes.js` | `MODES` (`plan auto manual edits`), `needsApproval`, `toolAllowed`, `nextMode`, `PLAN_NOTE`, `describeWrite`. |
| `lib/failover/turn-repair.js` | `repairTurn(messages, turnMsg, {sideEffects, reason})`: what to keep of a failed turn. |
| `lib/failover/handoff.js` | `buildHandoff`, `summarize`, `digest`, `splitTurns`, `clipToolResults`, `buildKnowledge`, `HANDOFF_MODEL`: compacted conversation for a model switch or `/compact`. |
| `lib/failover/failover.js` | `Failover`, `failoverNote`, `skipNote`: client-side failover for a **pinned chat-bridge site** only. |
| `lib/clients/provider-fallback.js` | `ProviderFallback`, `classify`, `isGone`, `shortReason`, `resetMs`: the cool-down of a limit follows Retry-After or "Soonest cooldown reset ~3m" (30 s to 60 min, 5 min without a time); when the *endpoint* refuses (401/403, outage), cool the route down and go to the next provider, finally local Ollama. |
| `lib/failover/fallback-trail.js` | `parseTrail`, `spentModels`, `trailText`, `TRAIL_SKIP_MS`: reads the gateway's `X-Fallback-Trail` (the hops that ran out before an answer). |
| `lib/gateway/skips.js` | `releaseRecovered`: a self-set skip ends early when a fresh availability says the model is usable again. |
| `lib/gateway/routing-health.js` | `routingHealth`: the one-line "gateway running dry" status. |
| `lib/gateway/latency.js` | `recordLatency`, `isDegraded`, `latencyReport`. |

### Model choice (gateway intelligence)

| File | Exports / role |
|---|---|
| `lib/gateway/availability.js` | `loadAvailability`, `reportChanges`, `noteIpChange`, `limitsText`, `limitedText`, `kindsText`, `backText`, `backShort`, `untilText`, `spanText`, `recordLocalFailure`, learned cooldowns (`saveCooldowns`/`loadCooldowns`), `groupId`. §12. |
| `lib/gateway/rating.js` | `Ratings` (state), `score`, `setRater`/`rateOf`, `setProviderRater`/`rateProvider`, `sortByRating`, `ratingCell`. §12. |
| `lib/gateway/exploration.js` | `Exploration` (cache + worker), `probeUsable` (tier 0/1), `isTransientProbe`, `probeCells`, `probeBrief`, `deepText`. §12. |
| `lib/gateway/probe-context.js` | `buildProbe`, `grade`, `deepBudget`, `plainQuestion`, `NEEDLES`: the synthetic compacted context of the deep probe. |
| `lib/agent/diagnose.js` | `diagnose`, `causeOfError`, `parseTrail`: why a probe failed. |
| `lib/failover/standby.js` | `pickNext`, `probeModel`, `isTransient`: the next model, one small pinned probe. |
| `lib/failover/takeover.js` | `betterReason`, `stepText`: when a probed model deserves to take over a running task. |
| `lib/gateway/model-status.js` | `modelStatusTable`: rows of `/model health`. |
| `lib/gateway/key-models.js` | `loadKeyData`, `parseKeyScope`, `modelsOfKeys`: `/model key:ID,...` restriction. |
| `lib/agent/delegates.js` | `Delegates`, `KINDS`, `discoverGateway`, `DELEGATE_NOTES`: which weaker sub-agent model did well for which job kind (`delegates.json`). |

### Gateway and network

| File | Exports / role |
|---|---|
| `lib/gateway/freellm.js` | `Gateway` (§11), `keyCells`, `FREELLM_URL`. |
| `lib/gateway/gateway-report.js` | `gatewayReport`, `reportText`: `/gateway status`. |
| `lib/gateway/proxy-probe.js` | `proxySettings`, `setProxyEnabled`, `proxied`, `measure`, `exitIp`, `newExit` (Tor `NEWNYM`), `PROBE_URL`, `EXIT_IP_URL`. |
| `lib/gateway/ip-check.js` | `externalIp`, `parseIp`, `isPublicIp`, `IP_HOSTS`. |
| `lib/gateway/ip-fix.js` | `ipCandidates`, `routedKeys`, `routedAll`, `setKeyProxy`, `clearCooldowns`, `ipProxyTargets`, `ipLimitedPlatforms`, `ANON_PROXY`. §14. |
| `lib/session/usage-baseline.js` | `baseline`, `baselineText`, `errorClass`: the numbers of usage.jsonl (turns, failure runs, per platform); run by `usage-baseline.js`. |
| `lib/agent/harness-error.js` | `isHarnessError`: an error of our own code, not rated against a model, classed apart by the baseline. |
| `lib/gateway/cdp-token.js` | `dashboardTokenFromBrowser`: reads the dashboard session token over Chrome DevTools Protocol. |
| `lib/gateway/bridge-process.js` | `startBridge`, `pickModel`: `--provider bridge`. |
| `lib/tui/net-activity.js` | `NetActivity`: in-flight HTTP requests with phases (feeds the net pane). |
| `lib/project/resources.js` | `ownSockets`, `processInfo`, `PORT_NAMES`: this process's sockets: lws connections from `LWSContext.sockets()` (local, peer, protocol, buffered bytes) joined by local+peer address with `ss` for the kernel counters, unix sockets and state; `joinLws`. |

### Terminal UI

| File | Exports / role |
|---|---|
| `lib/tui/tui.js` | `Tui`: layout, history with kinds, panels, split pane, status/input rows. §15. |
| `lib/tui/chat-repl.js` | `ChatREPL extends REPL`: line editor, queue, dialogs (`choose`, `confirm`, `ask`), pager host, shortcut keys. §15. |
| `lib/tui/pager.js` | `Pager`: full-screen scrolling view, optionally a selectable list with column filters. |
| `lib/palette.js` | Every colour of the TUI as a `#rrggbb` string (`STOPS`, `ACCENT`, `REPLY`, `TOOL_COLORS`, the raw-content colours, ...); `look.js` and `rawcolor.js` take their colours from here. |
| `lib/look.js` | `note`, `card`, `banner`, `quotaCell`, `pctCell`, `toolLine`, `toolResult`, `highlight`, ...; `panel`, `meter`, `gradientRule`, `sideBySide`, `shortPath` are thin wrappers over `terminal/widgets` that pass the palette. |
| `lib/tui/context-view.js` | `/context` and `/log` helpers: `messageText`, `messageSelection`, `summarizeMessages`, `parseContextArgs`. |
| `lib/gateway/key-events.js` | `reportKeys`: a key that went unhealthy or healthy again, from any look at the key list (availability load, `/gateway keys`), said once. |
| `lib/failover/hop-line.js` | `hopLine`: the one transcript line of an automatic model switch (§10). |
| `lib/tui/ip-pane.js` | `ipGroups`, `ipChangeParts`, `ipChangePanel`: the old/new exit address pane with the models that could work again (§14). |
| `lib/ansi.js` | `piped` (stdout is not a tty), `red`, `yellow`, ... |
| `lib/session/usage-stats.js` | `UsageStats` (session ledger), `fitTable`, `formatTable`, `fmtNum`, `fmtMs`, `routeLine`, `routeName`, `formatMeta`. |
| `lib/clients/pricing.js` | `PRICES`, `priceOf`, `estimateCost`, `fmtUsd` (cost estimate for endpoints that report none). |
| `lib/tui/net-pane.js` | `netPaneLines`, `hopsOf`, `kindOf`, `TYPES`, `annotateRates`: the `/split net` pane. |
| `lib/events.js` | `emit`, `setSink`, `setNamer`, `eventLine`, `eventsText`, `recent`: the background event channel. |
| `lib/tui/markdown.js` | `MarkdownStream`, `highlight`, `inline`: markdown for the terminal, one line at a time. |
| `lib/tui/rawcolor.js` | colouring of the raw content the verbose view shows. |
| `lib/tui/quips.js`, `lib/session/session-name.js` | spinner words, funny session names. |

### Files, sessions, config

| File | Role |
|---|---|
| `lib/session/session-cache.js` | `cacheDir`, `sessionKey`, `sessionDir`, `sessionFile`, `loadSessionState`/`saveSessionState`, `debugLogPath`. |
| `lib/session/session-store.js` | `SessionStore`: `session.json` (messages, baseline, queue). |
| `lib/session/session-log.js` | `SessionLog`: plain-text transcript. |
| `lib/config.js` | `SETTINGS`, `globalSettings`, `setSetting`, `loadEnvFile`, `userSystemPrompt`, `writeConfigFile` (atomic write). |
| `lib/session/persist.js` | `appendUsage`, `readUsage`, `saveQuota`, `loadQuota`, `flushPersist`, `trimLogs`. |
| `lib/project/file-refs.js`, `lib/project/file-blocks.js`, `lib/project/file-exchange.js`, `lib/project/sent-files.js` | File names/globs in a prompt are attached; `File: path` blocks in a reply are written; diffs of what was exchanged. |
| `lib/project/project-brief.js`, `lib/project/reference-files.js`, `lib/project/binding-context.js`, `lib/project/imports.js` | Project scan, reference docs for QuickJS projects. |
| `lib/agent/skills.js` | `/skill`: instruction files loaded into the conversation. |
| `lib/match.js`, `lib/paths.js` | Glob matching, `~` expansion. |
| `lib/run-command.js` | `runCommand`. |
| `lib/agent/control-socket.js`, `lib/agent/peer.js` | §17. |

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
3. A plain prompt: `attachFiles` (file names/globs → file blocks via `lib/project/file-refs.js`),
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

**The shared message format** (callers build it once; each client converts it natively to its wire shape):

```js
{ role: 'system' | 'user' | 'assistant', content: string }                       // plain turn
{ role: 'assistant', content?: string, toolCalls: [{ id, name, args }] }          // the model asks for calls
{ role: 'tool', name: string, content: string | object, toolCallId?: string }      // the app's result
```

`chat()`/`chatStream()` take `tools: [{ name, description, parameters }]` (`parameters` a JSON Schema object)
and `toolChoice: 'auto' | 'any' | 'none'` (Gemini and OpenAI honour it, Ollama ignores it), and return
`{ content, toolCalls?, reasoning?, meta? }`; `toolCalls` is present only when the model asked for a call.
`toolCalls[].id` is made up by the client (`name#index`) as a local handle: no provider has a call id on
the wire, so two parallel calls of the same tool name in one turn cannot be told apart by the provider.
Per wire: Gemini has roles `user`/`model` only (a result is a `user` turn with a `functionResponse` part whose
`response` must be an object, so a string becomes `{ result }`; Gemini 3 attaches an opaque `thoughtSignature`
to a `functionCall` part that must be echoed back or the API answers HTTP 400, so keep the `toolCalls` objects
as returned); Ollama has a real `tool` role (`tool_name`, string content, `arguments` not `args`); OpenAI uses
`tool_calls[].function.arguments` (a JSON string) and `tool_call_id`. Tool calls arrive whole, never token by
token, so `onToken` fires for text only. Not covered: multimodal parts (images, audio, PDFs).

**Cost estimate (`lib/clients/pricing.js`).** Endpoints that report no cost (Cerebras sends only
rate-limit headers) get an estimate: a static table `PRICES[provider][model] = [input, output]`
in USD per million tokens, applied to the reply's `usage.prompt`/`usage.completion`. Rules:
the key is `--provider`'s name (`opts.label`, e.g. `cerebras`), not the host; a cost the
endpoint reports itself (`usage.cost`) always wins; the estimate lives in `meta.costEst`
and is shown with a `~` (`/last`, `/usage`), never mixed silently with reported costs;
an unlisted model has no estimate (nothing is guessed); cached tokens are billed as normal
prompt tokens (the table has no cache rate). The Cerebras rows come from its public
`https://api.cerebras.ai/public/v1/models` (no key; `pricing.prompt`/`pricing.completion`
per token), read 2026-11-26; refresh the table from that URL when a price looks stale.

Clients for side work are separate instances pinned to one model:
`makeClient(model)` (standby probes), `makeExploreClient(id)` (exploration, headers
`<session>-explore`), both wrapped by `watchNet(c, label)` so the net pane
colours their connections.

## 9. Tools the model can call

`lib/agent/tool-requests.js` `TOOLS`: `list_directory`, `read_file`, `grep`,
`insert_above`, `edit_file`, `write_file`, `for_each`, `run_command`,
`ask_user`, `restart_harness`, `spawn_agent`. `executeTool(name, args, ctx)`
runs them; file writes go through the journal (`/undo`). Which tools exist in a
turn: `runToolLoop` filters by `forEach`/`opts.omitTools`/`toolAllowed(mode, name)`.
`lib/agent/modes.js`: `plan` read-only, `auto` free, `manual` asks for every write and
command, `edits` (default) free writes, asked commands. Changes to the
harness's own files always ask (`approveSelf`, `--self-edit` to waive). You
can now also choose "Yes, whole session" to remember your preference for the
duration of the session.

`spawn_agent` → `spawnAgent` (`repl.js`): isolated conversation, either another
ollama-repl instance found by `lib/agent/peer.js` (`findPeers`, `askPeer`) or the same
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

**The hop line (design 2026-11-25).** One automatic skip is one transcript line, not
three or four (the "no model could serve..." wave note, the skip note and the
"switching to" note used to follow each other per hop, and a run of nine hops
filled the screen). It is printed once the next model is known, in `/model skip`:

    ⇄ SPENT  REASON[: N models of P1, P2, P3 +K more][, back TIME]  →  NEXT  rating R

Rules: the spent model and the next one are named, coloured by strength tier
(`strengthColor`); providers teal, times amber, the reason red (amber for a plain
rate limit), the arrow lime; at most 4 providers are named, the rest is `+K more`;
without colour (piped) the same text. A skip typed by the user keeps its own notes
and the chooser. The `failover` event text is unchanged. A single-model hop names
the provider that served the spent model (`via`: the last request's platform, else
the only provider the gateway lists for it) as `provider/model`.

**The give-up panel (2026-11-25).** When every route failed and the round waits before
trying again (`chatRound`, backoff), the message is an amber panel in the TUI (a card
when piped or without TUI), not one long line: the
title `every route failed · waiting 30s · retry 1/3`, then one line per route
(`routeFailure`: provider dim, model by strength colour, the first sentence of the
error cut at 90 characters, the gateway's "Soonest cooldown reset" as an amber
`back in ~48s`). The full error stays in verbose mode.

Skipped models live in `skippedModels` (Map, 10 min, `skipModel`, `releaseRecovered`
ends self-set skips when availability shows recovery) and are saved over `/restart`.

## 11. The gateway subsystem

`lib/gateway/freellm.js` `Gateway` wraps an `OpenAIClient` pointed at a freellmapi.
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
logged-in dashboard tab over CDP (`lib/gateway/cdp-token.js`). `gateway.dashboard` is
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

### Availability (`lib/gateway/availability.js`, `loadAvailability(gateway)`)

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

**Load rules (2026-11-25, measured with a fake gateway of the live size: 699 models, 1500
rows, 83 keys, `/v1/models` 359 KB).** One `loadAvailability()` blocks the loop for 0.5-1 s
(compute 250 ms, the rest decoding and `JSON.parse` of 7 responses). Callers that finish
together run their continuations back to back in one pass of the loop, so a few
concurrent loads are one multi-second freeze (the 4.8 s and 9 s stalls in the strace logs).
Rules: (1) a load that is in flight is shared by every caller (`loadAvailability(gateway)`
returns the same promise); `{ fresh: true }` is for a caller that just changed gateway
state (proxy, cooldowns): it waits for the running load, then runs its own; (2) `groupId`
is memoised per display name; (3) the IP-error regex runs once per provider row, not per
cooldown of each key. `lib/lag.js` (section 2) shows what is left.

### Rating (`lib/gateway/rating.js`)

`score(rec, inputs)` → 0..100: intelligence (gateway score or name tier, up to
55), context window (+4..−4), learned adjustment (decays, half-life 7 days,
capped ±25) and request reliability (`reliability(ok, fail)`: −10..+10, steep near 100 %, weighted by the request count, 0 without data), latency, probe result (tier 0/1), state
now (limited −40, cooling −10, quota nearly used −8). Limit-type failures
(429, quota, cooldown) do not count against the model. `Ratings` persists to
`ratings.json`; `recordResult` (real requests, from `onMeta`), `recordProbe`
(exploration; transient failures are ignored). `repl.js` glue: `ratingInputs(id)`,
`ratingOf(id)` with a 5 s `rateCache` invalidated by `availability.at` and
`ratings.version`, `setRater(ratingOf)` so every list sorts "best first" via
`rateOf`. **Perf rule**: `modelInfo(id)` uses an indexed `WeakMap` (`infoIndex`);
never scan the budget rows per call (that cost 27 s once).

### Exploration (`lib/gateway/exploration.js`)

`Exploration.run(ids, makeClient, {concurrency=2, tools, deep, force, diagnose,
platformsOf, priority, onEvent, onResult, onDone})`: background worker lanes on the main loop.
The queue goes by `priority(id)` (`exploreOrder` in `repl.js`: served in the last 24 h,
then rating); a model whose platforms are all busy (a transient diagnosis with `retryAt`
in this run) is skipped, not cached (`skipped` event and count).

- **Tier 0** (`probeUsable`): one tiny request with a `ping` tool (does it answer,
  call tools, how fast). **Tier 1** (`probeDeep`, only for `deep(id) > 0`, i.e. the
  30 best rated, `deepFor` in `main`): a fixed synthetic compacted conversation
  (`lib/gateway/probe-context.js` `buildProbe`: system prompt, summary with filler, harness
  tool schemas, three "needles" at 10/50/90 % depth) sized to a quarter of the
  model's window (`deepBudget`, 1.5k–12k tokens); it must report the facts in
  one `report_findings` call (`grade`). Budget 1500 reply tokens, one retry with 3000 when
  the reply was cut off at the limit after all facts were recalled. Result in `entry.deep`.
- **Failures are diagnosed in the worker** (`opts.diagnose` = `diagnoseModel`,
  `lib/agent/diagnose.js`): error text + the gateway's state for the model, provider
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
`lib/gateway/key-models.js`) and `modelScope` (`/model a,b,c`) combine in
`inKeyScope(id)`; `pickNext(..., {allowed: inKeyScope})`, the likely-routes list,
standby and takeover honour it. `inKeysOnly` (key scope alone) is used by the
sweep so a sweep can find models outside the list.

## 13. Standby, takeover, handoff, compaction

- **Standby** (`--standby`, `lib/failover/standby.js`, `refreshStandby`/`standbyHook`): the
  model the gateway would pick next (by rating), pinned and probed so it is warm;
  `/standby`. Used by failover step 5 and as a sub-agent model.
- **Takeover** (`considerTakeover`, `lib/failover/takeover.js`): when `explored()` finds a
  tool-capable model that `betterReason` calls better (stronger tier, or
  ≥2× faster) *while a request runs*, the running model pauses at its next step
  (`takeoverHook.hold`), the candidate gets a compacted handoff, says what it
  would do (`stepText`), the user is asked (`repl.choose`), then the model is
  switched. `--no-takeover` disables; declined models are not proposed for 30 min.
- **Handoff / compaction** (`lib/failover/handoff.js` `buildHandoff`): base messages stay,
  last N turns (`--handoff-turns`) verbatim with big tool results clipped, older
  turns summarised by a *local* Ollama model (never the exhausted site; a plain
  `digest` if it is unreachable). `compactHook` runs it at `--compact-at` % of the
  window or on `/compact`; `handoffHook` is `/handoff-model`.

## 14. Proxy and IP handling

Why: keyless providers and some keyed ones limit per IP address.

- `lib/gateway/proxy-probe.js`: reads/sets the gateway's upstream proxy, measures its
  overhead (`measure`), asks the exit address (`exitIp`), and `newExit` opens the
  Tor control port itself (`AUTHENTICATE`, `SIGNAL NEWNYM`, `QUIT`; no script).
- `lib/gateway/ip-check.js` `externalIp`: direct or via SOCKS, several "what is my IP" hosts.
- `lib/gateway/ip-fix.js`: `ipCandidates` (keyless keys with limited models),
  `ipProxyTargets` (keyless keys, and the keys of a provider with several keys only while it is IP-limited), `ipProxyReleases` (those keys back to direct),
  `setKeyProxy`, `clearCooldowns`.
- `main()`: `/proxy [on|off|exit|keyless [apply|clear|fix]|auto]`; `fixKeyless`
  (route keys through the proxy, NEWNYM, probe the new address, clear cooldowns,
  test one request per provider, a second round if needed); **`autoProxy`** (default
  on; startup + when a platform turns IP-limited + every 5 min; targets: keyless keys, keys of an IP-limited multi-key provider, releases of the latter 30 min after the limit; only if the proxy
  answers; `--no-auto-proxy`); `watchPace` (every 10 s, "pace time ran out" events)
  and `recheckAfterIpChange`.
- **Automatic exit change**: `autoExit` (called by `watchPace`) asks Tor for a new exit when every
  keyless provider is exhausted (`keylessExhausted`), at most every 10 minutes (`AUTO_EXIT_GAP_MS`),
  prints the `ip-pane` panel and schedules `exploreKeylessAgain` (a background probe of the unverified
  keyless models); the Tor control host is `torHost(socksUrl)` (`TORHOST` wins). Off with
  `--no-auto-proxy` or `/proxy auto off`.
- The net pane marks each connection `SOCKS`, `DIRECT` or `SOCKS/DIRECT` (`netRoute`).
- Limits of the detection (see `TODO.md`): "per IP" is inferred (keyless flag,
  error text matching `IP_ERROR`); the gateway exposes no per-IP flag.

## 15. The terminal UI

### `lib/tui/tui.js` `Tui`

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
  `status` and `net` read the process's sockets (`ownSockets`): lws connections come from
  `LWSContext.sockets()` (rule of 2026-11-26: the harness has no reference to the contexts its
  clients create, so the static is the way in), and `ss` stays for what lws cannot know (bytes
  sent/received, rtt, kernel state, queues, unix sockets). `ss` entries are joined to lws
  sockets by the local+peer pair and gain an `lws` field `{ id, protocol, buffered }`; a
  connected lws socket `ss` did not list (timeout) is added as an `ESTAB` entry with zero
  counters; an `lws.so` without `LWSContext.sockets` leaves the plain `ss` result. `ss` is a shell pipeline
  per poll, 80 ms of kernel time on this host, much more on a host with thousands of
  sockets). Polling rule (`pollDelay`, `lib/project/resources.js`, 2026-11-25): 1 s while a request
  is in flight (the panes show live traffic), 3 s while idle, and never sooner than 5 times
  the duration of the last poll, so `ss` takes at most about a fifth of one core however
  slow it is. Rates are computed from the time between polls, so the interval does not
  change their meaning.
- Drawing: `drawRule`, `drawStatus`, `drawInput`/`drawEditor`, `ensureInputRows`,
  `suspend()`/`resume()` around the pager (alternate screen).

### `lib/tui/chat-repl.js` `ChatREPL extends REPL`

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
- `lib/session/usage-stats.js` **`fitTable(width, make, flex, drop)`**: `make(bar)` returns
  rows with meters of `bar` cells; meters shrink (6, 3, 0), flexible columns
  (indexes in `flex`) are cut with an ellipsis (ANSI-aware `cut`), columns in
  `drop` disappear in order. Rule: **one entry, one line, at any width**.
  Use it for every table; `formatTable` only for fixed-size output.
- `repl.js` helpers: `fgHex`, `strengthColor(tier)`/`tierOf(id)` (the rainbow of
  `/model list`: model names are coloured by strength everywhere),
  `leftCell(id)` (what is left of a model), `likelyModels` (picker candidates).

### Verbose and events

`ui.verbose` (Ctrl-O): full tool results, every request/response with headers,
reasoning, raw content (`lib/tui/rawcolor.js`). Background events
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

`lib/agent/control-socket.js` `ControlSocket`: a Unix socket `$XDG_RUNTIME_DIR/ollama-repl/o<pid>.s`
plus `<pid>.json` (name, model, root). Client → server: lines of input (Ctrl-X
Ctrl-S prefix steers). Server → client: JSON lines `hello accepted output
waiting ready info activity`. `activity` phases: `request reasoning answer
toolcall toolresult idle`. Started by `--listen` or `/remote-control`
(`startControl` in `main`). `control.event/update/activity` calls are scattered
through `chatRound*`, `runToolLoop`, failover (`providerHook.announce`).
`ctl.js` is the client; `lib/agent/peer.js` lets one session hand a task to another
(`findPeers` on the same root, `askPeer`), used by `spawnAgent` and `/delegate`.
`--worker` makes a session a delegate target.

## 18. Persistence: every file the program writes

| Path | Writer | Content |
|---|---|---|
| `~/.config/ollama-repl/settings.json` | `config.js` `setSetting` | defaults for options (`SETTINGS`) |
| `~/.config/ollama-repl/env` | user | `KEY=VALUE` environment (`FREELLMAPI_*`) |
| `~/.config/ollama-repl/system.md` | user | replaces the built-in system prompt |
| `~/.config/ollama-repl/delegates.json` | `delegates.js` | sub-agent model track record |
| `~/.cache/ollama-repl/sessions/<key>/session.json` | `SessionStore` | `version`, `updatedAt`, messages, baseline, queue; written via `.tmp` + rename, an unreadable one is kept as `session.json.corrupt` |
| `.../session.log`, `history`, `state.json`, `diffs/` | `SessionLog`, `ChatREPL`, `session-cache.js`, `FileExchange` | transcript, input history, name/model/project/title/message count, saved `settings` and `skippedModels`, the `/model` pattern, file diffs (see "Sessions" below) |
| `~/.cache/ollama-repl/exploration.json` | `Exploration` | per-model probe results (`ORIGIN\|MODEL`) |
| `~/.cache/ollama-repl/ratings.json` | `Ratings` | per-model rating state |
| `~/.cache/ollama-repl/usage.jsonl` | `appendUsage` | one line per request (trimmed to 90 days); the other clients (explore, standby, sub-agent) log theirs with `label`, the main client has none, and the baseline counts turns from the unlabelled rows only; `attempt` = n-th automatic skip retry of its round (0, the first try, is not written); `proxied` = upstream went through the gateway's socks proxy (true/false, absent if unknown), the baseline lists a proxied platform as its own row (`kilo +socks`) |
| `~/.cache/ollama-repl/events.jsonl` | `appendEvent` | the `quota`, `failover` and `proxy` events (30 days), read back with `readEvents` |
| `~/.cache/ollama-repl/quota.json`, `quota.jsonl` | `saveQuota` | last gateway snapshot; 15-minute history (180 days) |
| `~/.cache/ollama-repl/cooldowns.json` | `availability.js` | learned cooldowns, shadow blocks |
| `~/.cache/ollama-repl/logs/` | `session-cache.js` `debugLogPath` | `-x` debug logs |
| `$XDG_RUNTIME_DIR/ollama-repl/` | `ControlSocket` | sockets and info |
| `/tmp/ollama-repl-restart-<pid>.json`, `$TMPDIR/ollama-repl-resume-*.json(.bak)` | restart (§19) | restart request, resumed state |

### Sessions (decided 2026-11-26)

- **Key.** `--name NAME` is the key. Without it the key is `BASENAME-HASH`: the project directory's name and a
  hash of its real path (`lib/session/session-cache.js` `sessionKey`). The model is **not** part of the key any more, so
  switching model keeps the conversation. A directory of the old form `MODEL-HASH` for the same project is adopted
  (renamed, the newest one) the first time. Two live sessions on one key share and clobber one `session.json`:
  give each its own `--name`.
- **`session.json`** `{ version: 1, updatedAt, messages, baseMessageCount, queue }`, written to `session.json.tmp` and
  renamed, so a crash leaves the old file whole. A file that cannot be read is renamed to `session.json.corrupt` (never
  overwritten, a note says so) and the session starts cold; a file without `version` is version 0 (same fields).
- **`state.json`** is the session's metadata and settings, small, read without opening the conversation:
  `{ version, updatedAt, name, provider, model, modelPattern, root, startRoot, roots, title, messages, settings, skippedModels }`.
  `title` is the first prompt (60 characters), `messages` the count. `settings` holds `mode`, `stream`, `think`,
  `temperature`, `numCtx`, `maxRounds`, `scan`, `verbose`, `fallbackModel`, `root`; it is written whenever one of them
  changed (after every turn and every command). `allowPaid`, the `--no-*` switches and the cdp endpoint are **not**
  saved: a paid or reduced run is decided at every start. `skippedModels` keeps entries until they expire.
- **Working directory (decided 2026-11-26).** `state.json` also keeps `startRoot` (the real path of the directory the session
  was first started in, never changed afterwards), `root` (the directory it is in now, the last one) and `roots`, the
  chain of directories: `[{ at, root, how }]` with `how` = `start` (the first entry), `cd` (a `/cd`), `--root` (a later
  start with `--root` that named another directory than the last one) or `fallback` (the last directory was gone); a directory equal to the previous entry is not
  added, and the chain keeps the first entry and the last 99. `/cd` appends to it at once and writes a `CD: OLD -> NEW`
  line to `session.log`. A start without `--root` goes on in `root`; when that directory is gone it falls back to the
  newest earlier entry that exists, then `startRoot`, then the current directory, and says so. All paths are absolute and
  real (symlinks resolved). The browser shows `started in` and `moves` when the session has been elsewhere.
- **Precedence** at start: command line, then the session's saved `settings`, then `settings.json`, then the built-in
  default. `--resume FILE` (restart) still overrides all of them, as before. The saved `name` is reused unless
  `--name` is given or another live session has it.
- **Listing and cleanup.** `/sessions` (and `--sessions` on the command line) list the saved sessions, newest first:
  key, age, messages, model, project, title. `/sessions prune [DAYS]` / `--prune-sessions DAYS` delete the ones not
  touched for DAYS (default 30) except live ones. Nothing is deleted without being asked.

### Session browser (decided 2026-11-26)

`/sessions` in the TUI opens a full-screen browser (`lib/tui/session-browser.js`, hosted by `ChatREPL#openSessionBrowser`
like the pager: alternate screen, keys go to it first, the mouse wheel is up/down). Without a TUI (piped, `--sessions`)
and with `/sessions list` the same sessions are printed as the text table; `/sessions prune [DAYS]` is unchanged.

- **Layout.** A header line, the **list** on top (about 45% of the rows, at least 3), a rule, the **details** of the
  highlighted session below (the rest, at least 6), a key line. The list scrolls so the highlighted row is always
  visible; the highlighted row has a background colour over the full width. Columns: marker (`*` running here, `●`
  running elsewhere), key, age, messages, model, project, title; each is cut to its width, the title takes what is left.
- **Details** (for the highlighted row): key and name, state (this session, running in pid N, or saved), project,
  provider/model, message count and size of `session.json`, last update (absolute and age), the saved settings, the
  title, and the last prompt and the last reply (two lines each; read from `session.json` when the row is highlighted,
  cached per key, nothing is read for a file over 8 MB).
- **Keys.** Up/Down (j/k), PgUp/PgDn, Home/End move; **Enter or `l` loads**; **`i` inspects**; `q`, Esc Esc, Ctrl-C close.
  Inspect opens the pager with the whole conversation (a header per message, long messages cut at 2000 characters,
  tool calls as one line) and returns to the browser on `q`.
- **Load** switches this process to that session: it restarts like `/restart` but with `--name KEY` (the key is the
  session's directory name, so the saved conversation and settings come back), no `--resume`, no harness check (the code
  did not change). Its `--model` is dropped when the saved provider is the one running now (the session's own model comes
  back), else kept. The conversation of the session being left is already saved (after every turn). Refused with a
  message in the key line: the session that is open now, and one that another process is running (use
  `ollama-repl-ctl -s NAME`). The new process runs under the key as its name.
- Not in this version: filtering by typing, deleting from the list (use `/sessions prune`), renaming.

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
  from a source tree `sh smoke.sh repl.js` (≈13 s: imports of every `lib/**/*.js`,
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

- `tests/test-*.js`: plain scripts (they import `../lib/...`), run from this directory as `qjsm tests/test-x.js`; a test throws
  (or exits non-zero) on failure and prints `test-x: ok`. Run all:
  `for t in tests/test-*.js; do qjsm $t >/dev/null 2>&1 || echo FAIL $t; done`.
  They use mocks and fixtures only; **none runs against a live gateway** (see
  `TODO.md` for what was never seen in a real terminal).
- `tests/test-pager-select.js` needs a tty (`script -qec "qjsm tests/test-pager-select.js" /dev/null`);
  it skips itself otherwise.
- `smoke.sh [REPL.js]`: the restart gate (§19); `SMOKE_ARGS`, `SMOKE_WAIT`.
- Syntax and names: `node --check file.js` is a fast pre-check (the code is plain ES modules);
  `node --expose-internals check-names.cjs repl.js $(find lib -name '*.js')` finds undeclared and doubly declared names.
- Health numbers: `qjsm usage-baseline.js --days 1` (before/after a change to failover or exploration).
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
  every change of the harness is logged in `ChangeLog` in this directory (GNU
  style, format in the repo-root `CLAUDE.md`), not in the repo-root `ChangeLog`.
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
- **Exploration entries and needles.** A passed entry carries `v` 3 (tier 0 as it is now); an older pass is `verified` but not
  `current`, so the run asks it again from scratch (`Exploration#current`). The tier 1 probe takes `seed`
  (`needlesFor(seed)`, `lib/gateway/probe-context.js`): each run varies codename, port and owner, `grade` uses the probe's own needles;
  without a seed the fixed `NEEDLES` stay (tests).
- **Tor control.** `newExit` authenticates with `CTRLPASS`, else (a local Tor) with the control cookie (`torCookie`: `CTRLCOOKIE`,
  `/run/tor/control.authcookie`, `/var/lib/tor/control_auth_cookie`); `newnym` asks `GETINFO newnym-wait` and waits it out (at
  most 12 s) before `SIGNAL NEWNYM`, since Tor answers a throttled NEWNYM with 250 OK and builds no circuit; callers ask for the
  address again until it differs (`exitAfterNewnym`, `autoExit`, `/proxy exit`, the keyless fix). `/model health` and the sweep
  event show what the probes cost (`Exploration#cost`).
- **Proxy policy (decided 2026-11-26, A1).** A keyed provider goes direct, kilo included: the proxy adds latency to every
  request (about +0.5 s on kilo) and the usage data cannot show a gain. Only a keyless key (its quota counts per address) is
  sent through the proxy by itself. A keyed provider with several keys gets its keys on the proxy **only while one of its
  models is limited per IP address** (`ipLimitedPlatforms`, kind `ip`), and loses them again once no model of it has been
  IP-limited for 30 minutes (`ipProxyReleases`; hysteresis, so a limit that returns is not chased on and off); the release also
  runs at startup, which takes the keys the old policy put on the proxy (22 of kilo) off it. `autoProxy` does both.
- **Live refresh (2026-11-26).** Every 2 minutes while the session is idle and no exploration runs, `watchLive` refreshes the live state
  of the verified models (`refreshExplored(availability, { notify: false })`: the last availability and one TCP connect, no request to
  the gateway, no standby or takeover side effect); the status bar shows `⌕ usable/verified live` when nothing is being probed
  (`Exploration#liveSummary`). Open: the TCP check goes to the gateway, not to the model's upstream.
- **Sweep options (2026-11-26).** `/model explore [--tier0] [--workers N] PATTERN..`: `--tier0` skips the tier 1 context probe (a sweep
  that costs 2 requests per model and no 3 to 12k prompt tokens), `--workers N` sets how many models are asked at once (1 to 8,
  default 2: the `concurrency` of `Exploration#run`). The options are words starting with `--`; the rest are patterns as before.
- **Address change verdict.** After `noteIpChange` the models that were limited are counted again at the recheck 25 s or more later
  (`ipLiftTally`): one `proxy` event says how many limits the new address lifted, per kind (`req/min 8/10, req/day 0/20, ...`);
  the events are kept in `events.jsonl`, so the data to adjust `ipLimitedPlatforms`/`clearCooldowns` (which kinds really lift) builds up.
- **Proxy latency.** `/proxy` shows what the proxy adds per platform: the median time to the response headers of the proxied
  against the direct requests of the last 7 days (`proxyLatency`, `lib/session/usage-baseline.js`), for platforms with 3 rows of each.
- **Availability tables.** `/api/models` (the chain) and `/api/fallback/routing` change rarely and are asked once a minute
  (`SLOW_TABLES`, `lastTables`), the other five tables (usage, limits, penalties, keys with their cooldowns) every load;
  `{ fresh: true }` asks all of them. `av.keyCounts` (platform to enabled keys) lets `spentPlatforms` (`lib/failover/fallback-trail.js`)
  say that every key of a platform ran out in the trail of an answer: the models only that platform serves are skipped
  for `TRAIL_SKIP_MS` at once.
- **No per-item call that re-derives the whole catalog** (found 2026-11-25 in the real
  lag.jsonl: 31 `getFilteredModels` calls of 100-150 ms inside one 6.8 s stall, and the
  4.8 s stall of strace.log.txt, which sits between the end of a /v1/models download and the
  seven requests of the next load). `/model skip` of a spent provider called `skipModels(name)`
  once per model of that provider, and each call built `allModelNames()`, which filtered and
  sorted the whole catalog (699 names, rated) just to learn the names. Now `allModelNames`
  copies the names (O(n)), and the provider loop calls `skipModel` directly: the names come
  from the catalog already. `timed` rows in lag.jsonl carry `where`, the callers, so the next
  one is found without a perf recording.
- **No formatting or regex work inside a sort comparator** (found 2026-11-25 in a perf
  recording of a 6 s freeze: 61 % of the time inside `Array.prototype.sort`, 27 % in regex
  tests). `limitsText` formatted two table rows per comparison to read a flag that was
  known up front (570 ms for 1500 rows, 100 ms after), and `modelStatusTable` stripped
  colours with a regex per comparison. Work out the sort keys once per row (a `Map` or a
  field) and sort on those; `limitsText`, `limitedText` and `modelStatusTable` are `timed`.
- **Reasoning models** write their thinking into the content: the old
  system-prompt probe called them disobedient (16 of 276 models); tier 0/1 grade
  tool calls and recalled facts, not style.
- **Shadowed names**: QuickJS accepts a module-level function with the same name as an import, and
  the function silently wins (`exhaustedPlatforms` in `repl.js` once made the proxy trigger of
  `lib/gateway/ip-fix.js` inert). `check-names.cjs` parses with acorn, which rejects such a redeclaration, and
  also lists undeclared names (a missing import such as `fg` only throws when the path runs); run it
  before a commit.
- **`runCommand` must never read a pipe that a descendant may hold open** (found
  2026-11-25 in an strace of a 31 s freeze of the whole REPL: the `ss ... | grep`
  of `/split status` timed out after 3 s, the shell got SIGKILL, but `ss` kept the
  pipe's write end and the blocking `read()` on it hung the single thread until the
  user pressed Ctrl-C). Design: the command writes to an unlinked temporary file,
  not a pipe; after the shell exits (or is killed) the file is read, which never
  blocks, whatever a leftover background process does. Output is capped (4 MB: the
  command is killed beyond that). A pipe also deadlocked past its 64 KB buffer.
- **Restart safety**: anything the restart check imports must load without a
  network and without `~/.cache` state; keep `lib/**/*.js` import-clean.

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
- **rating**: 0..100 "how good a pick is this model now" (`lib/gateway/rating.js`).
- **tier 0 / tier 1 probe**: the cheap tool-call probe / the synthetic-context probe.
- **standby**: the warm second model.
- **takeover**: a better model picking up a running task.
- **handoff / compaction**: the summarised conversation given to a new model.
- **sweep**: `/model explore PATTERN`, re-probing matching models.
- **verbose-only line**: transcript line of kind 1, visible only with Ctrl-O.
