## Open from the hiccup investigation of the REPL (2026-11-25, stdin unresponsive)

The two causes found are fixed (the blocking pipe read in `lib/run-command.js`; the slow `Array.sort` comparators in
`limitsText` and `modelStatusTable`) and the loop-lag instrumentation `lib/lag.js` exists. What is left:
- `/split status|net` still spawns `ss` every 0.5 to 1 s (a slow `ss` on a host with many sockets is what timed out): poll slower, or
  only while the pane is visible.
- After the restart (A4): confirm that `/events lag` no longer names `limitsText` or `modelStatusTable`; check the other comparators
  that call heavy functions (`lib/freellm.js` `keysText` orders, `lib/availability.js` `limitedText`, where `rateOf` is called per comparison).
- Waiting for the next hiccup: read `/events lag` or `~/.cache/ollama-repl/lag.jsonl` first (the perf data of 23:09:38 shows no long CPU
  burst: that stall was waiting, not running).
- The 4.8 s stall is explained and fixed (2026-11-26): it is `/model skip` of a spent provider (listModels download, then the loop, then
  the load's 7 requests, as in the strace). The loop called `skipModels(name)` per model and each call filtered and sorted the whole
  catalog (`getFilteredModels` 100-150 ms; 31 calls in one 6.8 s stall of the real lag.jsonl). Confirm after a restart that no
  `getFilteredModels` rows come in bursts. Still unexplained: stalls of about 2.27 s every 6.5 s in phase `waiting` with no timed section
  (real lag.jsonl 00:37:59 to 00:38:12), and `writeQuota` rows of 300 to 980 ms (25 ms of work measured on the real files). `timed` rows
  now carry `where` (the callers); for the untimed ones record perf (`perf record -g -p PID`) while it happens.

# ollama-repl TODO (status 2026-11-26)

Every pending task of `doc/PLAN.md`, in the order to do them. The IDs are the plan's: the plan has the steps, files,
checks and details of each, this list has the order and the reasons for it. Size: S under an hour, M a session, L several
sessions. Owner: U the user, H this harness, G the freellmapi gateway, Q the qjs-modules session. Done tasks are
removed from here and from the plan (git history and `README.md` / `doc/ARCHITECTURE.md` have them). Defects are in
`BUGS`; the facts behind the health work are in `doc/HEALTH-EXPERIMENTS.md`, the gateway wishes in
`doc/GATEWAY-PROPOSALS.md`.

Checks before a commit: `for t in tests/test-*.js; do qjsm $t >/dev/null 2>&1 || echo FAIL $t; done` and
`node --expose-internals check-names.cjs repl.js lib/*.js` (undeclared and doubly declared names). Tests are in
`tests/` (`qjsm tests/test-x.js`, run from this directory); bare test names in the docs mean those files. After a
change under `lib/` run `cmake .` before `cmake --install`. Experiment rule: scripts that talk to the gateway use
`FREELLMAPI_URL` and `FREELLMAPI_KEY`, never `OPENAI_API_URL` (another service here).

## Uncommitted and open right now

- The untracked `strace.log*` files (110 MB) are not to be committed (see A3).

## The order

### 1. Decisions and housekeeping (minutes each, mostly the user)

1. **A3** (U, S) delete `strace.log`, `strace.log.txt`, `strace.log.txt2` and `perf.data` (about 100 MB; `perf.data` is git-ignored, the strace files are untracked); keep or move `harness.mp4` (14 MB) and decide on `qwen2.5-coder.json`.
2. **A5** (U, S) look at a real automatic skip once (the hop line, colours, a piped run) and say whether the wording is right.
3. **A2** (U, S) who takes the gateway proposals D4 to D8: the user changes freellmapi, a patch is prepared against
   `~/Sources/freellmapi`, or the harness keeps working around them. Needed before D4 to D8.
4. **A4** (U/H, S) restart the running session so it uses the code of Phases 1 to 3 and the 2026-11-26 changes. Blocked: it is
   under `sudo ptrace.sh -f ollama-repl` (the stall investigation of the other session) and a restart ends that trace;
   do it when that is finished (`ollama-repl-ctl` does not see it, its socket is under `/run/user/1000/ollama-repl/snap-*`).
   It starts the clock for B1.
### 2. Bugs and enablers (small, they unblock later work)

6. **N1 rest** (H, S) the availability load is cheaper (shared loads, the chain and routing tables once a minute) but still blocks the loop
   0.3 to 1 s; confirm after a restart with `/events lag` that no section is left (`loadAvailability compute`, `JSON.parse`).
7. **H3 rest** (H, S) the dialog state of `ChatREPL` and the remaining wiring of
   `repl.js` are only testable inside `main()`: move the pure parts into `lib/` as they are touched; prerequisite for H1, H2, J1.
### 3. Small failover and display fixes (each with a test)

12. **D11 rest** (H, S) the local client now reports to the status line (`onMeta`); what is left: the next round still starts on the
    failed client until its cool-down routes it away (decide whether the switch should stick).
17. **D9** (H, M) a limit in the middle of a streamed reply: keep what was printed, drop the spent model, continue; design first.
18. **D14** (H, M) fold the provider fallback and `/handoff-model` into the one next-model order, or document why they stay apart.
19. **D3** (H, S) a low-rate availability refresh while a request runs or the session is idle; not before N1 rest says what a load costs (a load every
    minute is a 0.3 to 1 s freeze every minute).

### 4. Live verification (one real session each, before building more on top)

Do the terminal pass first, then the gateway passes. Every failure becomes a `BUGS` entry; every pass removes its bullet.

20. **C6** (U/H, M) one sitting in a real terminal and tmux: net pane, `SOCKS`/`DIRECT` chips, split-pane keys, live panels, tool call
    panels, pickers and the chooser filter, `/brief save`, sync frames, the reply colour, the hop line (also settles A5), the long
    reasoning panel, Ctrl-O.
21. **C1** (H, M) provoke a 429 on a pinned model: Retry-After skips, task-type header, trail soft-skip, `/last` trail, turn repair,
    routing-health segment, early skip release, hop line, give-up panel after 3 backoffs.
22. **C2** (H, M) startup likely-routes list, `/model health` columns, `/gateway usage` key spread, persisted quota stand-in,
    dashboard success path.
23. **C3** (H, S) key restriction `/model key:ID,ID`: status mark, `/route` refusal, warning for shared platforms.
24. **C5** (H, M) a tier 0/1 sweep, the diagnosis steps, the `12k?` busy display, takeover end to end, the prompt-cache question for the fixed needles.
25. **C4** (H, M) Tor: `autoExit`, `/proxy keyless fix`, the proxy policy, the PATCH/DELETE key calls, the chips against real sockets;
    tune the 10 minute gap and the "all exhausted" rule. Feeds E4.
26. **C7** (H, M) Ollama and Gemini `onMeta` token counts and failed-request records, `OllamaClient` with `tools` and streaming
    `tool_calls`, `/brief` built by the local model.
27. **C8** (H, L) agents: `spawn_agent` with `kind`, read-only switch, a worker waiting for approval, `restart_harness`, self-edit dialog,
    `ask_user`, repeat guard, standby switch-over on a real 429/5xx, `ollama-repl-ctl monitor`.
28. **C9** (H, M) `--provider bridge`: names and context meter, standby switch-over, strength, the "/min" label, the dropped-input report.

### 5. Measured failover work (against the health baseline)

29. **B1** (H, S, needs A4 and a day of traffic) fill the "after" column of the 4.2 table: failed turns, failed hops (harness exceptions
    should be 0), time to next success, kilo share, retries, rating ties, transient verdict share, used share of verified models.

30. **B2** (H, M) 3.5 faster switch on "All models exhausted" for a pinned model: first list the runs with `attempt` >= 2 from the new
    rows, write the rule into `ARCHITECTURE.md` section 10, change `chatRound`, put the choice in a testable `lib/` function.
31. **B3** (H, M) 3.4 failover headroom: prefer a provider with quota left over the biggest one (a headroom term in `score()` or `pickNext`).
32. **B4** (H, S to M) 3.11 the req/day meter feeds the rating and the automatic exit decision; shares the headroom definition with B3.
33. **B5** (H/G, S) 3.10 which tokens `budget.totalUsed` counts (584M of 2.3G vs 876M); then fix the quota bar text.
34. **B6** (H, S) 4.1 leftover: repeat the 400/1500 tier 1 rerun for the base `nemotron-3.5-lightning` when it is usable.

### 6. Gateway changes (after A2; each has its evidence in `doc/GATEWAY-PROPOSALS.md`)

35. **D4** (G) kilo key spread; first check whether the three keys share one limit (two tokens belong to one user; Kilo reports no usage
    per key; needs a valid token for `usageAnalytics.getBreakdown`).
36. **D5** (G) `blocked` false negatives: a model listed usable while its provider is `rate_limited`.
37. **D6** (G) daily resets exposed as resets with the exact end, not `cooldown`.
38. **D7** (G) route check for tool support before counting routes.
39. **D8** (G) the invalid upstream key found by the 4.1 rerun: replace or disable it.

### 7. Proxy and exit address (after C4)

40. **E4** (H, S) which limits an address change really lifts: count the cooldowns that came back, adjust `ipLimitedPlatforms`/`clearCooldowns`.
43. **E6** (H, S) show the latency a proxy adds per platform (the take-off when the limit is gone is done: `ipProxyReleases`).
44. **E5** (H, M) `/proxy keyless fix` tests a second model of a provider and turns its steps into `proxy` events.
45. **E7** (H, M) classify transient vs real failures by the gateway's error code and status, not by a regex over the text.
46. **E3** (H/G, M) a keyless platform without a key row cannot get a proxy: needs the gateway to create the row; until then the pane says so.

### 8. Exploration and rating

47. **F2 rest** (H, S) the probe cost is shown (`/model health`, the sweep event); what is left: an option for tier 0 only and one for the
   concurrency of `/model explore`.
50. **F3** (H, M) queue limited models until their `until` instead of skipping them, report them as "waiting".
51. **F6** (H, S) a live refresh timer and a status segment for the exploration; check the model's upstream, not only the gateway.
52. **F4** (H, M) decide on the explored identity: tier 0/1 no longer collect it; either re-add a cheap identity field and use it for routing, or drop the idea and the stale wording.
53. **F10** (H, M) save `/model a,b,c` and the last sweep with the session, show them in `/status`, accept a sweep list split over lines, show the request-rate window in `/model next`.
54. **F11** (H, M) one flexible column in `compactTable` tables, more selectable pagers, numeric and regex filters, mouse selection, `test-pager-select.js` under a pty in `smoke.sh`.
55. **F12** (H, M) `/gateway` details: exact day reset (needs D6), IP limits, `/model list FILTER`, narrow-terminal layout of `/gateway limited`, gateway features not exposed (fusion, cache/compress headers, profiles).
56. **F9** (H, M) a benchmark table by model family as a tie-break for strength; replace the hard-coded `MODEL_STRENGTH_PATTERNS`.
57. **F8** (H, M, after a week of data) fit the rating weights to `usage.jsonl`; add the gateway-usage evidence term; map provider rows to catalog ids.
58. **F1** (H, M, after C7) probe Ollama and Gemini with tier 0 when selected.

### 9. Events, statistics, persistence

59. **G1 rest** (H, S each) more events: learned cooldowns, rating moves of 10 or more, key quota, quota stand-in replaced, keyless fix steps, provider status changes, standby as sub-agent. (Done: key status on every availability load, `quota`/`failover`/`proxy` events kept in `events.jsonl`.)
60. **G2** (H, M) read `quota.jsonl` back (a trend for `/gateway forecast` and B4); mark the preloaded quota as stale in the status bar.
61. **G4** (H, M) config cleanup: briefs to the cache, restore the `/model` cycle position, `/rename` moves the session files, migrate old `<model>.json/.log`, debug logs out of the cwd, tests for `lib/session-cache.js` and the env parser.
62. **G6** (H, M) verbose panels and net-pane labels for the local-model calls (`/handoff`, `/compact`, `/handoff-model`, `/each`); cap the `/brief` panel.

### 10. Terminal UI

63. **H7** (H, S each) `/context` subcommands for `/log`, a quips switch, the "thinking:" label, in-transcript panel scroll, other Alt-PgUp/PgDn sequences, the scrollback push at start, wrapped status line, Ctrl-C while a stream flows, lws connections in `/split status`.
64. **H2** (H, M) repaint changed rows only, pin the exploration panels, close every tool panel on a throw (after H3 rest).
65. **H1** (H, M) net pane: scrolling, a fixed 90 s bar replaced by the client's timeouts, reply tails, a better request-to-socket pairing, an `explore` filter, naming the key, short subjects for handoff prompts.
66. **H6** (H, M) verbose colouring: per-language highlighting, `/last` and plain `--verbose` lines, diff view of edit calls, panel history limit, Ctrl-O in plain mode.
67. **H8** (Q, M) move `piped`, `termWidth`, `wrapHanging`, `Pager`, `colorJson`, `MarkdownStream` to qjs-modules `terminal`; check the installed qjsm has the faster width functions.
68. **H4, H5** (H, L each) kitty keyboard and focus events; the line editor (`terminal.LineEditor` vs turning `showColors` on). Decide on the editor first; both need a kitty terminal to check.

### 11. Files, context, compaction

69. **I1** (H, S each) attachment limits as an option and command, a 100 KB allowance for named files, no glob attach inside quoted prose, absolute paths under an extra root.
70. **I2** (H, S) a filtered view of only the tool-call history in `/log` and `/context`.
71. **I3** (H, M) compaction accuracy: real token counts as the trigger, a gateway model as summarizer, pinned skills, gentler cuts of a single long turn.
72. **I4** (H, M) takeover: abort an expensive in-flight request, hold sub-agents too.
73. **I5** (H, M) a handoff-aware prompt budget for duck (16000 characters); `tools: false` in `/v1/models` so the repl switches to `--no-tools` by itself.
74. **I6** (H, M, needs live runs) a periodic tool-use reminder, an "already shown" set, cached directory reads, show the `.so` project guess to the model, verify the shorter system prompt on `qwen2.5-coder`.

### 12. Agents, peers, providers

75. **J7** (H, S) delegation hygiene: one file or a lock per delegated task, review the diff before the next dispatch, the brief wording for other projects.
76. **J3** (H, M) non-blocking `spawn_agent` with a notification and a list of running agents; the first step toward J1.
77. **J5** (H, M) peers: update a worker's mode on `/mode`, cancel a peer task, tell the primary the candidate models, an automatic check of delegate output, N waiting `qjsm` processes after N restarts.
78. **J6** (H, M) a `load_skill` tool, skills in the system prompt, plugin skills and `allowed-tools`.
79. **J1** (H, L, after H3 and J3) several conversations in one process (an `Agent` class, per-agent state, an agent list in the TUI).
80. **J2** (H, M, after J1) `ollama-repl-ctl -a NAME` and a `multi` NDJSON mode.
81. **J4** (H, L, research first) Claude Code as a provider through headless `claude -p` stream-json; verify `--resume` with stream-json and Agent SDK attach first.

### 13. Bridge (when chat-bridge work resumes)

82. **K2** (H, S) start the browser or print it clearly, no stray bridge child after a hard kill, a `--new-tabs` option.
83. **K3** (H, S) a strength table for the bridge sites; the standby switch-over for a bridge (after C9).
84. **K1** (H, L) the backend interface: `lib/gateway.js` with freellmapi and bridge backends, and chat-bridge serving the metadata.

### 14. Coding quality of the models (need a model to test against)

85. **L5** (H, M, needs a working Ollama) fix the Ollama install, pull `qwen2.5-coder`, run the two PoC tasks and read the log; try the other candidate models.
86. **L6** (H, S) re-test piped input at `ask_user` and `[y/N]` (the 90 s timeout at EOF).
87. **L1** (H, M) the `for_each` nudge or harness-side item extraction.
88. **L2** (H, M) verify after edit: a comment-only check with auto-undo, a `max_lines` check, the anchor check.
89. **L3** (H, S) `think` per round, Gemini `thinkingLevel`, longer retries on a busy 503, several `for_each` items per request.
90. **L4** (H, M) a rename across files (grep, `for_each(files)`, build step).
91. **L7** (H, S) the comment task on other providers; check the free tiers at the provider.
92. **M1** (H, S, needs a model) re-run the binding demo and record the result in the README demo section.

### 15. Continuous

- **M3** keep the docs true: `README.md` and `/help` agree; a new slash command touches the six places of `ARCHITECTURE.md` section 16; update this file and the plan when a task closes.
