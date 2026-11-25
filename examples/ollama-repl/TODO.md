## Health, exploration, switchover: fixes and improvements (2026-11-25), plan done, nothing implemented

Background, numbers and the full plan (file:function, change, test, success metric, owner H = harness / G = gateway):
doc/HEALTH-EXPERIMENTS.md, section Plan. The defects with their evidence are the 7 entries of BUGS. Order is by dependency.
Test with ~/Sources/quickjs/qjs-modules/build/x86_64-linux-gnu/qjsm (the installed qjsm has no terminal/* yet).

Waiting for the user (decisions):
- how to run live probes: a gateway key from the user, or driving the live session's /model explore (script rule: FREELLMAPI_URL
  and FREELLMAPI_KEY, never OPENAI_API_URL, which points to another service here; an attempt with it was rejected, nothing served)
- whether kilo (77 % of the tokens) stays behind Tor (22 keys were routed through socks5://192.168.178.52:9050 by the new policy)
- who takes the gateway proposals 3.6 to 3.9
- commit and push: fb9b8df is committed locally, not pushed

Phase 1, instrumentation (everything else depends on it):
- 1.1 label usage records (main, explore, standby, sub, handoff) in lib/persist.js appendUsage and repl.js onMeta; /usage filters by it
- 1.2 keep the baseline script in the repo (qjsm), print the table of the doc; recompute the baseline without probes

Phase 2, correctness (each with a test, each closes its BUGS entry):
- 2.1 exit-change-uses-wrong-tor-host: autoExit and /proxy exit take the host from the socks URL (helper in lib/proxy-probe.js)
- 2.2 deep-probe-max-tokens-too-small: lib/exploration.js probeDeep max_tokens 1500, one retry with 3000 on finish length
- 2.3 deep-probe-transient-error-shown-as-context-lost: repl.js explored, probeBrief, deepText: a transient deep error is busy;
  also seen in the /gateway quota table (12k with a cross on a rate-limited model)
- 2.4 failed-request-rated-against-requested-name: repl.js onMeta, no rating without routedVia, none for harness exceptions
- 2.5 rawcolor-test-expects-old-colors: test-rawcolor.js imports the colors from lib/palette.js
- 2.6 find what throws in the request path (is not defined, not a function, unknown color) so no exception is logged as a request error

Phase 3, policy (measure against the baseline), harness:
- 3.1 do not probe a limited provider; re-probe at the known reset time (Exploration.fresh retryAt)
- 3.2 explore what traffic will need next (rating and recent use), not the ready list
- 3.3 rating without the +25 cap (lib/rating.js ADJ_CAP): lower confidence bound plus latency
- 3.4 failover prefers a provider with headroom over the biggest one (/gateway quota)
- 3.5 switch at once on All models exhausted for a pinned model (runs of up to 9 cheap failures today)
- 3.10 the quota panel's month bar counts budgeted tokens only (584M of 2.3G) while /gateway usage says 876M for the month;
  check which platforms have no budget (kilo?) and say so in the bar, or count all (lib/freellm.js, /gateway quota)
- 3.11 /gateway quota: the req/day meter (openrouter nemotron-3.5-lightning:free 34/50) could feed the failover and the auto
  exit decision before the model runs out

Phase 3, gateway (proposals for freellmapi, not harness code):
- 3.6 spread the load over kilo's keys (87/12/1 %)
- 3.7 blocked false negatives: a model listed usable while its provider is rate_limited
- 3.8 daily resets reported as cooldown: expose the reset kind and the exact end
- 3.9 filter routes without tool support before counting routes

Kilo findings (2026-11-25), to remember when touching the key spread:
- Kilo reports no usage per API key: its docs and OpenAPI spec (app.kilo.ai/api/openapi.json, five usageAnalytics tRPC
  endpoints) break usage down by user, organization, model, provider, project, feature, mode; its tokens are JWTs that carry only a
  kiloUserId, two of the three in ~/Documents/accounts.txt belong to the same user; per-key numbers can only come from freellmapi
- the three Kilo tokens in that file are rejected (INVALID_TOKEN), so the fields of a response usage object and the analytics
  endpoints are not tried; with a valid token: usageAnalytics.getBreakdown/getSummary (dimension user) would cross-check the gateway's
  588M and 81M, and show whether the keys of one user share one limit (then spreading over them gains nothing)

Phase 4, verification:
- 4.1 rerun the tier 1 probe of nemotron-3.5-lightning (-30b, -30b-a3b) at max_tokens 400 and 1500, 3 runs each (needs the key above)
- 4.2 a day after 2.x and 3.x: rerun the baseline and fill a before/after table in the doc
- 4.3 move the done items to Done, remove the closed BUGS entries, update README and ARCHITECTURE (label, exploration order)

## Exit address change pane, automatic exit change (2026-11-25)

Done: lib/ip-pane.js (the pane: old/new address, models that could work again), keylessExhausted() in lib/ip-fix.js,
/proxy exit and /proxy keyless fix print the pane, recheckAfterIpChange() also explores the unverified keyless models
in the background, watchPace() calls autoExit() (every keyless provider exhausted: new Tor exit, at most every 10 min,
off with --no-auto-proxy / /proxy auto off). test-ip-pane.js covers the pane and keylessExhausted().

Open:
- autoExit(), exploreKeylessAgain() and the live pane are not tested against a real Tor and a freellmapi gateway (none here), only syntax-checked and run through the unit test
- the pane's "could work again" list is what was limited before the change; whether a model really answers again shows after the 6 s / 30 s recheck and the exploration (/model list, events)
- the 10 minute gap between automatic exit changes and "all keyless exhausted" are guesses: tune after a real run

## Move generic widgets to qjs-modules terminal (2026-11-25), done except the candidates below

Done: ollama-repl imports the split 'terminal', 'terminal/style', 'terminal/screen', 'terminal/widgets',
'terminal/scrollview', 'terminal/capabilities' modules; look.js takes panel, sideBySide, meter, gradientRule and shortPath
from 'terminal/widgets' (thin wrappers pass our colors; card and paintShell stay in look.js); the net pane cards are
panel({ kind: 'plain', background }). Everything needs a qjsm built from qjs-modules 59882b5e or later: the installed
/usr/local/bin/qjsm does not have the terminal/* modules (use ~/Sources/quickjs/qjs-modules/build/x86_64-linux-gnu/qjsm
until the user installs one).

Open, not asked of the qjs-modules session yet (probably as sibling modules, not in terminal.js): piped, termWidth,
wrapHanging (ansi.js), Pager, colorJson, MarkdownStream; the rest of look.js (highlight, helpPanel, note, pctCell) needs
a theme design first.

## Tool call panels (2026-11-25)

- Not checked in a real terminal; the live "⚙ NAME · running" panel and the result panel are unchanged.

## Strict file attachment (2026-11-25)

- Open: the limits are constants in lib/file-refs.js, no option or command to change them yet; a file the user
  names explicitly could be allowed up to 100 KB (decide).

## /context subcommands (2026-11-25)

- Open: /log has no such subcommands; the same selection could apply to the conversation part. No unit test (the
  helpers live in repl.js, which runs main() on import).

## /brief save [FILE] (2026-11-25)

- Not run in a session (it needs a brief built by the local model first).

## Split pane scrolls (2026-11-25)

- Not checked in a real terminal; a terminal that sends another sequence for Alt-PgUp/PgDn needs its own entry in
  chat-repl.js.

## Net pane: what a request sends (2026-11-25)

- Open: handoff and /compact prompts have their own wording, so they show the first line of the user message; give
  them a short subject if that reads badly.

## Model chooser filter (2026-11-25)

- Not checked in a real terminal; no unit test (the dialog state is private to `ChatREPL`).

## Terminal capabilities from qjs-modules terminal.js (2026-11-25)

- Open: kitty keyboard and focus events stay off. ChatREPL (and the base REPL under it) match legacy byte strings,
  so turning kitty on needs a layer in ChatREPL#termReadHandler that runs decodeKeys() and hands handleKey() the
  legacy string of each key (press events only); nothing uses focusin/focusout yet. Needs a kitty terminal to check.
- Open: the line editor is the base REPL of qjs-modules (lib/repl.js), not a private one, so terminal.LineEditor
  would replace ChatREPL's whole base class (history, ^R, completion, queue, dialogs); not done. The base REPL
  already steps by grapheme cluster and has the history suggestion, but ChatREPL has showColors off, so the grey
  suggestion and preview do not show in chat.
- Not checked in a real terminal: sync frames, the undo at exit.

## Verbose panels leaked into the compact view (2026-11-25)

- Open: `repl.js` cannot be imported by a test (it runs `main()`), so
  `inKind` itself is only mirrored in `test-verbose.js`; check by eye in a
  real terminal that the panels are gone with Ctrl-O off.

## Gateway failover follow-ups (2026-11-24, commit 8c815e1)

Open:
- nothing of the gateway failover work (Retry-After skips, task-type header, X-Fallback-Trail soft-skip, /last trail,
  turn repair, routing-health segment, early skip release) ran against a live gateway; smoke.sh only starts the REPL, so the status segment and the
  /model list skip table are untested outside the unit tests (lib/*.js each has a test-*.js)
- the provider-fallback 5 min cool-down (lib/provider-fallback.js) still ignores Retry-After; a plain
  "Soonest cooldown reset ~3m" text without the header is not read
- the trail soft-skip is per model; a platform-wide skip needs the key outcome per platform, which the header lacks
- availability is not refreshed on a timer: skips are released, and the routing-health numbers move, only when
  /model list, /model skip or one of the existing refreshes runs
- a throw inside tool execution itself (not a chatRound failure) is untested against lib/turn-repair.js
- repl.js: the doc comment "the providers named in a gateway's ..." sits above isExhaustedError, it belongs to
  exhaustedPlatforms below it
- local-model brief for other projects (see ~/Sources/bass-doctor/TODO.md, "UX-first direction"): a goal,
  milestones and out-of-scope list instead of "find weaknesses"; lib/project-brief.js (untracked, not mine) may be
  the place

## Provider failover follow-ups (2026-11-21)

Open:
- the monthly-quota vs daily-limit split is taken from the dashboard availability (loadAvailability); without a
  dashboard session the old per-provider skip of the attempt trail applies
- after a switch to the local model the next round still starts on the failed client and is routed by the cool-down;
  the status line keeps the old route (the local client has no onMeta)
- glob attach ("attached: sw.js") also fires on a `*.js` inside quoted prose: attach only a standalone path-like token, or a line prefix (/noattach, leading !) that disables it
- read_file resolves relative to the harness root: allow an absolute path under an extra root or make /cd follow the job
- single long turn: the auto compaction (`--compact-at`) keeps no older turn to summarize and cuts the tool rounds of
  the running turn (see BUGS compact-single-turn in this directory)

## Next tasks (recorded 2026-11-19)

- `ollama-repl --provider bridge` live check: names and the context meter in `/model list` (only the data was
  tested, not the screen).
- strength column: the gateway's intelligence scores are coarse (many models sit at the 74% or 50% default,
  auto/kilo-auto/free-router at 50%); find a better source (benchmarks table by model family, or the gateway's own
  measured results) and use it as a tie-break inside a score group.
- verbose view: panels are kept for the whole session (HISTORY_MAX lines); a very long session drops the oldest
  verbose panels first. Ctrl-O in the non-TUI (plain) mode still shows only new traffic.
- untested live (from earlier work): a real model delegating with `spawn_agent` `kind`; the peer read-only mode
  switch; a worker waiting for approval; the standby automatic switch-over on a real 429/5xx; ghost completion exists
  only in the TUI; a compaction may summarize a loaded skill away; the primary is not told which delegate candidates
  exist; N restarts leave N waiting qjsm processes.
- housekeeping: restart the running sessions (`auto`, `worker-freellm` in tmux `worker1`) to pick up Esc, argument
  completion, retroactive verbose and the strength column;
  `~/Sources/rsenn/skills/quickjs-scripting` has uncommitted edits for the user to commit.
- delegation lesson: two agents edited chat-bridge.js at once and the weaker worker left a half-done edit; give each
  delegated task its own file or a lock, and review the diff before the next dispatch.
- bridge: bridge sites show strength "unknown" (no scores), the standby switch-over for a bridge is untested,
  `x-ratelimit-*` of a bridge still says "/min" in the status line (`gw N/M/min`); next: chat-bridge steps 5 and 6
  (docs).

After every change under lib/ run `cmake .` before `cmake --install`.

## Open from the advisor review (2026-11-19)

- compaction: the trigger is an estimate (chars / 3.5), not the provider's token count; the summarizer is the local
  ollama model also when the main provider is a gateway.
- self-edit: the approval dialog for edits to the harness's own files was not exercised live; a model's real use of
  SELF_NOTES is untested; N restarts = N waiting qjsm processes (no execve in QuickJS); a process started from the
  fallback is not a source tree itself, it finds the target from the root like an installed one; a session started
  before the AF_UNIX fix holds the abstract socket name: restart it.
- /gateway limits, /model list: the day window's exact reset is unknown (shown <= 24 h), IP limits are only a text
  heuristic (the gateway has no such state), the model list has no /model list FILTER yet, auto routing itself is the
  gateway's business.
- /standby: untested live: the automatic switch-over on a real 429/5xx and spawn_agent with model "standby"; the
  standby is not kept across /restart, no per-turn cost accounting for the probes, "next" follows the gateway's
  scores, not its real chain walk (the gateway exposes no next-hop).
- /delegate: untested live: a real model using spawn_agent with kind and the harness-chosen model; "ok" means the
  sub-agent finished and said something, quality comes only from the user's votes; the primary is not told which
  models are candidates; Gemini provider has no delegation.
- --worker and peers (lib/peer.js): untested: a primary model delegating by itself, the read-only mode switch, a
  worker waiting for approval; a worker's mode is taken from its info (not updated on /mode), no way to cancel a
  running peer task, the ghost completion exists only in the TUI.
- /skill: the model cannot load a skill itself (no tool), skills are not listed in the system prompt, plugin skills
  (~/.claude/plugins) and a skill's `allowed-tools` / `argument-hint` are ignored, a compaction may summarize a
  loaded skill away.
- bridge parity (plan: ../chat-bridge/doc/HARNESS.md): --provider bridge has none of the gateway functions (limits,
  /route, /standby, usage meters); needs chat-bridge to serve the metadata and a backend interface here
  (lib/gateway.js with freellmapi and bridge backends).
- freellmapi routing: fusion (a `fusion` config object in the body) is only selectable, not configurable;
  x-freellm-cache and x-freellm-compress are read by the gateway, not sent by us; profile management (dashboard
  API) is not exposed.
- verbose colouring: no per-language highlighting (markdown.js highlight() is one generic tokenizer); the /last panel
  and the plain --verbose lines of a request are not coloured; the unified diff of an edit tool call is not
  rendered as a diff in the call panel.

## Overnight agent session 2026-11-19, open

- restart_harness as a model tool call is not run yet (the slash commands share its path).
- spawn_agent: untested; check that read_only really withholds every write tool and that the sub-client is
  destroyed on failure.
- The skip list and the model strength tiers (MODEL_STRENGTH_PATTERNS) are hard-coded name patterns; unknown
  models get tier 9.
- Unclear what REPORT_COMMANDS and /remote-control changed; not read in detail.
- Commit 2fcdcc1 is on origin/main with its "..." message, not rewritten.

## /cd fixes, modes, verbose, full gateway status (2026-11-19), open

- The dashboard success path is untested here (no credentials). Only the refused token and the wrong password were
  tried.
- Without a dashboard session the context window of the model that answered is mostly unknown: /v1/models ids are
  catalog ids (gemini-3.1-pro), the route names provider ids (nvidia/nemotron-3.5-lightning:free). The status line
  then says "window unknown".
- Install to /usr/local/bin again and tell the js-engines session (ask the user first).

## TUI widgets and own style, open (2026-11-19)

- a live in-transcript scroll of the latest panel was not done, the pager covers it.
- lws connections of the control socket clients and CDP are listed in /split status only while connected, an idle
  lws context holds just a netlink socket.

## Multi-conversation sessions and Claude Code sessions (asked 2026-11-19, approved, after A-D)

   2026-11-19 clarification: Claude Code's own background tasks (shell
   commands and sub-agents picked with up/down in its task list) live
   inside one session and have no external API; they are a UI model, not
   something to connect to. The ollama-repl counterpart: make spawn_agent
   non-blocking (returns an id at once, runs in the background, the result
   comes back to the parent as a notification message) and show the
   running/finished agents in a list (up/down + Enter opens one). Today
   spawn_agent blocks the parent turn until the sub-agent is done.
8. Several conversations ("agents") in one ollama-repl, picked with
   up/down + Enter. Cost: moderate, mostly a refactor:
   - main() keeps everything in one closure: messages, client, opts,
     stats, log, store, sentFiles, fileExchange, baseMessageCount,
     abortRef, the busy queue. That becomes an Agent class.
   - Module-global state has to become per agent: tool-requests.js
     (undo journal, writeCount), repl.js (failoverHook, approveWrite,
     ui).
   - The event loop already runs several httpClient requests at once.
   - TUI: an agent list (Down on an empty input, or a key), output per
     agent buffered and replayed on switch, background approvals queued
     and shown in the status line.
9. ollama-repl-ctl: address an agent (-a NAME, or "@name line" over the
   socket), events tagged with agent and session, and a "ctl multi" mode
   holding several sessions open and printing one NDJSON event stream
   (ready, waiting, output, per agent) for a controller such as Claude
   Code.
10. Claude Code sessions, findings:
   - Discovery is easy and stable enough. ~/.claude/sessions/<pid>.json
     holds name, cwd, status (idle/busy), version, peerProtocol 1,
     peerFeatures, tmux pane, and messagingSocketPath
     (/run/user/1000/cc-socks/<pid>.sock).
   - The socket protocol is internal and undocumented, with a per-session
     key file (<pid>.<hash>.key, mode 600). Not worth targeting: it is
     not a public interface and changes with Claude Code versions.
   - Headless route, checked against `claude 2.1.318` and the docs
     (code.claude.com/docs/en/headless): `claude -p --input-format
     stream-json --output-format stream-json --verbose` reads JSON user
     messages on stdin and emits NDJSON events; --resume <id> or
     --session-id <uuid> picks the conversation, --include-partial-messages
     streams chunks. Best fit: spawn it as a child process and treat it as
     one more provider/conversation. Unverified: --resume together with
     --input-format stream-json, and whether the Agent SDK can attach to a
     session still running in another process. Remote Control
     (--remote-control, /remote-control) connects a running session to
     claude.ai/code or the phone app: for people, one remote session per
     instance, not a programmatic API.
   - Workable routes instead:
     - tmux send-keys and capture-pane into the session's pane (the json
       names it);
     - claude -p --resume <sessionId> for a headless turn in that
       conversation (a separate process, not the live TUI);
     - the other direction, already working: a Claude session drives
       ollama-repl through ollama-repl-ctl.

## freellmapi gateway + TUI, open (2026-11-19)

- Ollama and Gemini clients now call onMeta with token counts (test-client-usage.js); not run against a live Ollama
  or Gemini server, and a failed request emits no record for them yet.
- Ctrl-C while a stream is already flowing does not cancel it: abort() only knows requests still waiting for headers
  (#settled).
- The dashboard's per-request detail (/api/analytics/requests/:id: attempt ladder, ttfb, served-model drift) needs a
  dashboard session token and the request row id, which the response does not carry (only execution_id).
- TUI: /js output and Tab-completion lists come from the base REPL with ttyWrite. /js output lands in the input
  area, completions are copied into the transcript. The status line is clipped, not wrapped.
- TUI start pushes the screen into the scrollback (output starts at row 1) instead of continuing below the cursor,
  which would need a cursor position query before the REPL owns stdin.
- Could send X-FreeLLM-Task-Type: code. The gateway already treats requests with tools as code, so only --failsafe
  would gain.

## Coding-work assessment with qwen3.5:4b (2026-10-20), open ideas, roughly by value

- **The model does not always pick `for_each`.** One of two runs of the plain prompt did all 25 edits itself with
  `edit_file` and deleted three declarations (the new WARNING in the edit_file result is untested against it).
  Options: a harness-side nudge - if the prompt matches /every|each|all .* (function|file)/ and the model starts
  editing without `for_each`, reject the first edit with "use for_each"; or run the item extraction in the harness
  (`/each`-style) for prompts that name a header.
- **Verify after edit.** Nothing checks that the file still compiles or that only comment lines were added. A
  per-task check hook (e.g. for a comment-only task: `git diff` has no removed lines and no added non-comment lines
  -> else auto-`/undo` that item and retry) would turn the remaining ~1-in-5 sloppy items into retries.
- **Comment length.** Items still sometimes paste the whole multi-line doc block of the .c file although "1-2 lines"
  was asked. A `max_lines` check on `insert_above` could reject with a message.
- **Misplaced inserts.** `insert_above` anchors on a substring; an anchor that is a prefix of two lines is rejected,
  but a model that anchors on the wrong (neighbouring) declaration is accepted. Could verify that the anchor line
  contains the item name in `for_each` runs.
- `think: true` for the planning round only (read the header, choose the items) and `think: false` for sub-items -
  not tried.
- `ask_user`/`[y/N]` at EOF of piped stdin ends the session without an answer (see piped mode below).
- Larger refactors (rename across files) are untested: needs `grep` -> `for_each(files)` and a build/test step via
  `run_command`.
- Not tried: the other two providers on this task; qwen2.5-coder as the originally targeted model.

## Second round: qwen2.5-coder and Gemini (2026-10-20), open

- qwen2.5-coder still: comments inserted above a neighbouring declaration (31 comments added for 25 declarations in
  one run), and items that end with a text `run_command` call although that tool is withheld for comment-only tasks.
- Gemini: a 503 "high demand" on the first tool round outlasted all 5 retries (~85 s) and aborted the turn (0 of 25,
  nothing damaged). Retrying longer, or skipping a busy item and carrying on, would help.
- Not done: `thinkingConfig.thinkingLevel` ("low" is accepted by gemini-3.8-flash, "minimal" is not) as a client
  option; for_each could pack several items per request to save quota; pick the model from `--model list` plus a
  quota probe.

## Assessment (2026-08-04, updated 2026-08-30), open

- **Not verified against the actual target model (`qwen2.5-coder` via a local Ollama server)** - this
  environment's Ollama install fought system-level problems (a failed `snap install ollama`, then the native install
  left `/usr/local/bin/ollama` at mode `700 root:root`, the `ollama.service` unit restart-looping on `Permission
  denied`/`status=203/EXEC`, and `sudo` runs segfaulting, which smells like leftover AppArmor confinement from the
  snap install). Retry `ollama list`/`ollama pull qwen2.5-coder` once that is sorted, then run the two PoC coding
  tasks below through `--provider ollama --model qwen2.5-coder` and read the resulting `qwen2.5-coder.log`
  transcript to see how the real target model behaves.
- **Two PoC coding tasks, the harness's actual bar to clear**: (1) write a small JS class using only QuickJS's own
  `std`/`os` modules (a `RingBuffer` class writing to a file via `std.open()`); (2) write a small C library routine
  against `quickjs.h` - e.g. a class with a couple of "exotic" methods (closer to the fib.c/point.c reference
  shape). Both through the *real* interactive `repl.js` harness, then read the `<model>.log` back to find what the
  model got wrong or guessed at instead of checking.
- **Unconfirmed oddity, not root-caused**: a PoC run piped as `<prompt>\n/exit\n` into `qjsm repl.js` hit a 90s
  timeout after one `run_command` call that reached `ChatREPL#confirm()`'s y/n gate. Plausibly the piped `/exit`
  does not match `confirm()`'s `/^y(es)?$/i`, so the command is declined and the loop goes on to a second live
  round that outlasts the wrapper timeout - but not confirmed; re-test piped, non-interactive input against a
  `confirm()`/`ask()` prompt before trusting non-interactive testing of this harness.

## ask_user (2026-08-30), open

- `ask_user` has not been exercised by an actual live model turning ambiguous scope into a real call; prompt for it
  during the next live session (see the PoC coding tasks above).

## Rework the system prompt and context mechanism, open

- Consider re-injecting a short reminder of the tool-use rule periodically (e.g. appended to each `tool`-role result
  message in `runToolLoop`) rather than relying on it surviving from the system prompt alone across a long
  conversation.
- `gatherProjectContext()`'s scan is deliberately shallow and fixed at startup - good for payload size, but work
  centered on a particular subtree (e.g. `lib/lws/`, a single `qjs-*` binding) gets no automatic help beyond the top
  level, and the scan never updates as a session goes on. If it costs too many extra `LIST:`/`READ:` rounds, let the
  model broaden its own view more cheaply instead of widening the automatic scan back out.
- No memory of what's already been read: nothing stops the model from re-`READ:`ing the same file every round. A
  per-session "already shown" set (like `SentFiles`/`FileExchange`) would let the system prompt say "don't
  re-request a file you've already been shown" truthfully and shrink context growth over a long session.
- Unverified: whether the shorter system prompt changes qwen2.5-coder's behavior in practice.

## Push the model harder toward using the harness - needs live pressure-testing

The mechanism changed (native `tools`/`toolCalls` instead of a text
protocol - see the top of this file and `API.md`), but the underlying goal
- get the model to actually *prefer* checking over guessing - still needs
real qwen2.5-coder sessions to confirm it worked, not just that the wiring
is correct. Specific gaps to watch for once live:

- C/QuickJS work: read the actual binding file and `quickjs.h` (via the
  `lib/reference-files.js` name-drop mechanism, or the `read_file` tool)
  before describing or editing JS<->C glue, rather than recalling the API
  from the primer in the system prompt alone.
- Native-module work specifically: now that `nativeModules()` can guess
  which sibling project a compiled `.so` came from, that guess isn't
  surfaced to the model anywhere yet (it's dead code from the model's
  point of view) - either inject it into the system prompt or expose it as
  another tool argument (e.g. resolving a bare `.so` name to its guessed
  project) so the model actually uses it instead of guessing which qjs-*
  project a given native module lives in.
- Anything it's about to write a `File:` block for: `read_file` the target
  file first if it already exists, so the rewrite is grounded in the
  current contents rather than the model's assumption of what's there -
  the system prompt says this now, but it's unverified whether the model
  actually follows it.

## Follow-ups from the message-format/tool-use rewrite, open (2026-08-06)

- `OllamaClient`'s own wire format with `tools` (and its streaming `tool_calls`-mid-chunk path specifically) is
  still unverified: the round trip was verified only against `GeminiClient` and `OpenAIClient`.
- No multimodal message parts (images/audio/PDFs via `inlineData`/`fileData`) - not needed for this project's
  text-only workflow yet; `API.md` sketches how it would extend the format.

## Smaller gaps noticed while assessing, open

- Not covered by `/context` and `/log`: a *filtered* view of just the tool-call history (request + result pairs,
  without the surrounding chat turns) - still only in `<model>.log`.
- `qjsProjectDirs()`/`referenceFiles()`/`nativeModules()` all re-`readdir()` their directories on every call (once
  per chat prompt, at minimum) - fine at current scale, but worth caching per-session if it is ever noticeably
  slow.

## Binding-writing context, open (see DEMO.md)

- The live re-run the redesign was meant to unblock (`BUGS: ollama-native-binding-demo-never-replies` - does the
  smaller, curated context fix the never-replies case?) needs a reachable Ollama server or `GEMINI_API_KEY`.

## Open notes from the old Done list

- ollama-repl-ctl monitor: tool results of the cached/declined paths emit no event; not verified: the `waiting` event
  (needs a model that calls run_command), two clients at once, a client that stops reading (the server's `send()`
  blocks).
- Repeated-call guard: the repeat limit (`MAX_REPEAT_ROUNDS`) is untested against a real model.

## Automatic model failover over a chat-bridge, open

Plan and rationale: `examples/chat-bridge/TODO.md` ("Failover plan").

- failover only covers `chatRound()`; a limit hit in the middle of a streamed reply (after text was printed) is not
  handled
- when every model is unavailable the original error is shown; a hint with the earliest `resets_at` would help
- after a handoff `/reset` keeps the base messages but the compacted turns are gone from the local history (the
  session file is saved compacted too)
- the summary comes from a 4B model: it can still drop or garble details, the strict headings in `lib/handoff.js`
  only reduce that
- `--provider bridge`: the browser is not started for you (the bridge prints the command), a repl that is killed
  hard (not via /exit or Ctrl-C) can leave the bridge child running, no option for `--new-tabs` yet
- a report that the prompt stops accepting input after "error: OpenAI connection failed: dropped" could not be
  reproduced; if it happens again, check `ls -l /proc/<pid>/fd/0` of the chat-bridge child and whether Enter echoes
- not done: `tools: false` in `/v1/models` so the repl switches to `--no-tools` by itself and a failover skips
  chatgpt, duck and deepai (they ignore the emulated tools; chat-bridge/TODO.md idea 5), a handoff-aware prompt
  budget for duck's 16000 characters

## TUI scrollback and flicker, open (2026-11-19)

- the real wheel inside tmux with mouse off is untested here (tested with SGR reports sent through send-keys).
- the quips have no switch to turn them off, the "thinking:" label of reasoning output is unchanged.

## Config env, system.md and per-session cache (2026-11-25)

Open:
- briefs still live in ~/.config/ollama-repl/brief-*.json, not in ~/.cache (lib/project-brief.js cachePath)
- the restored /model pattern is only announced at start, it does not restore the cycle position
- /rename after start does not move the session files (the key is fixed at startup)
- old <model>.json/.log/-diffs in a project directory are not migrated, a first run starts a fresh session
- the provider debug logs (<provider>-repl-debug.log, lib/logger.js) still go to the cwd
- no unit test for lib/session-cache.js and the env parser (checked by hand with XDG_* pointed at a temp dir)

## Async exploration (2026-11-25)

Open:
- not run against a live gateway; each model costs 3 requests of free quota (identity, system prompt, tool call), 2 models at a time
- /model health prints the results only on its next run; no live refresh of the pager, no status-bar segment
- the explored identity is not used for routing yet (e.g. skip models that ignore a system prompt in auto routing, show it in /model list)
- only OpenAI-compatible gateways (freellm) are explored
- a worker thread is possible again once lws.so keeps its prototypes per context (BUGS lws-statics-not-multi-runtime)

## Network pane, /split net (2026-11-25)

Open:
- not seen in a live TUI session yet, only rendered from sample data
- the exploration's requests show in the boxes with the label explore
- the elapsed bar counts against a fixed 90s, not the client's real first-token/stall timeouts
- non-streamed OpenAI replies show no reply tail, and a wrapped Ollama chat() shows it only when the call ends
- requests are paired to sockets by the peer port only: two parallel requests to one host share the first matching socket
- no scrolling in the pane: a long list is clipped at the bottom

## Local-model traffic in verbose panels (2026-11-25)

Open:
- /handoff, /compact, /handoff-model summaries and /each use other local-model calls (lib/handoff.js) without the same panels
- the /brief panels show whole documents (up to the 8k-token window) per request: long, behind /view N

## Async exploration follow-ups, takeover (2026-11-25), open

- takeover (considerTakeover in repl.js, lib/takeover.js): untested end to end against a live gateway, only the
  decision and step helpers are unit tested.
- takeover: the in-flight request of the running model finishes before the pause takes effect (no abort); a handoff
  when the conversation is short is the plain messages; only the main conversation is held (sub-agents run on).

## Exploration without prompts (2026-11-25)

Open:
- the live refresh runs only with /model health (and its table), not on a timer or after each turn
- the TCP check is one connect to the gateway, not to the model's upstream provider
- an entry written by the older three-prompt code counts as verified as it is

## Keyless providers through the anonymizing proxy (2026-11-25)

Open:
- not run against a live gateway: the PATCH and DELETE calls follow the freellmapi source (server/src/routes/keys.ts), the dialog and listing only the mock data
- nothing changes the exit address by itself: /proxy exit does it on request; an automatic new exit when a keyless provider runs dry again is not done
- a keyless platform the gateway lists only as a provider (no key row yet) cannot be given a proxy: the dashboard keeps the sentinel row
- which limits an address change lifts is a guess (windows, cooldown, exhaustion, IP errors); credit, tier and key state are left alone

## /proxy exit without the script (2026-11-25)

Open:
- cookie authentication (CookieAuthentication 1 in torrc) is not supported, only the password (empty by default); a remote Tor needs the ssh tunnel the script made by hand
- Tor rate-limits NEWNYM to once per 10 s and still answers 250 OK: /proxy exit right after another one may keep the circuit

## Key restriction, /model key:ID,... (2026-11-25)

Open:
- not run against a live gateway; only the key -> models mapping is unit tested
- no per-request key choice exists in the gateway: with other enabled keys on a platform the restriction is of models, not of keys (only a warning); real enforcement would need the keys' model scope or enabled flag changed, as /proxy keyless does with the proxy
- the restriction is not kept over /restart or a new session

## /proxy keyless fix (2026-11-25)

Open:
- the whole round has only run against pieces (the fake control port, the direct probe, the candidate logic), not against a live gateway and Tor
- no automatic trigger: when a keyless provider runs dry nothing starts the round, it is a command (a log hint would be the next step)
- the request per provider tests the strongest limited model only; a provider whose other models stay limited is reported as working
- Tor keeps one circuit per 10 s at least: a round that sees the same address twice waits 10 s and tries once more

## /split net as coloured rectangles (2026-11-25)

Open:
- the compaction type needs the /brief, /handoff and /compact traffic to be watched with a label (they go through localTrace, not watchNet): until then only a request labelled brief/compact/handoff gets it
- colours checked only as escape sequences, not looked at in a terminal

## /model health columns (2026-11-25)

Open:
- the token budget rows are matched to a model by model id or the group id of the row's display name; a model without a budget row (the gateway budgets only some platforms) shows -
- not run against the live gateway

## Model rating (2026-11-25)

Open:
- the weights (55 for the intelligence score, +-25 learned, latency, probe, state) are a first guess, to tune on real use
- /gateway limits, quota and keys keep their own orders (limited-then-soonest, heaviest used, heaviest used); keys could sort by their provider's rating
- the rating of a route that was not a catalog id (a provider row the catalog does not know) goes to a record of its own name
- not run against the live gateway

## Persisted statistics (2026-11-25)

Open:
- quota.jsonl is written but nothing reads it back yet (a trend: /gateway forecast could use it)
- usage.jsonl rows of one request can repeat when the gateway retries inside a chain: they are the harness's view, one per answered request
- the status bar shows the preloaded quota as if fresh until the first refresh answers (a second or so)
- a killed process loses at most 20 s of quota snapshot and 5 s of cooldowns; usage rows are appended at once

## Live panels, failover choice, exploration panes (2026-11-25)

Open:
- live panels were checked by unit test and the smoke run, not looked at in a terminal; a repaint every 120 ms redraws the whole window (changed rows only would be cheaper)
- the exploration panels scroll away as the chat goes on; they are updated in place above, visible when scrolled back or with /verbose toggled
- a tool that throws leaves its panel on the failure line only when the exception is caught in runToolLoop
- the provider fallback (providerFallback) and /handoff-model are not part of the one next-model order yet

## /gateway views in the background (2026-11-25)

Open:
- /gateway status and login still run in the foreground; the other report commands (/proxy probe, /model health) still capture stdout while they wait
- not looked at in a terminal

## /model health fits the terminal (2026-11-25)

Open:
- the other tables built with compactTable (/model list, limits) still have one flexible column

## Background events (2026-11-25)

Open:
- candidates not reported yet: learned cooldown changes (recordCooldownEvent), a model whose rating moved by 10 or more, exploration cache hits skipped, key quota (monthly request cap) of a single key, the persisted-quota stand-in being replaced, the keyless IP fix steps, /gateway providers status changes (a provider turning down), the standby being used as a sub-agent
- the key status is compared only when /gateway keys is looked at (no extra requests per refresh)
- events are not persisted (the ring buffer is per process); usage.jsonl and quota.jsonl keep the numbers

## Startup list of likely routes (2026-11-25)

Open:
- not run against the live gateway; the probes cost a few small requests per unprobed model, once (a verified model is never probed again, a failed one after an hour)
- a --quiet / piped start prints the list once without the background update

## Automatic proxy, pace/IP events, probe classes (2026-11-25)

Open:
- the automatic routing is not run against the live gateway; a keyed provider limited per IP gets a proxy for its key too, which adds the proxy's latency to every request of that key
- it never rotates the exit address by itself when a keyless provider runs dry again
- the transient/real split is a regex over the error text

## Probe diagnosis, coloured model choice (2026-11-25)

Open:
- the diagnosis is not run against the live gateway; its retry costs one small request per failed model, only when the failure looks transient
- the retry cannot pin a provider route (the gateway picks it), so a model that fails through one provider and works through another reads as flaky

## Probe false negatives for reasoning models (2026-11-25)

Open:
- the gateway's own usage is evidence the harness does not use: kilo served 76M tokens of nemotron-3.5-lightning:free this month; a rating term for models that the gateway has served a lot without errors would have caught this
- a reasoning model that never gets to its answer within 700 tokens still fails the test

## Two-tier exploration, coloured explore events (2026-11-25)

Open:
- not run against the live gateway; tier 1 costs about 3-12k tokens per top-30 model once
- no time-to-first-token (the probe is not streamed); tps comes from the usage block when the gateway sends one
- the needles are fixed, so a provider that caches prompts may answer from cache; vary them if that shows up

## Net pane hops, /gateway limits layout (2026-11-25)

Open:
- the gateway sends the key only as an ordinal (key1 = the platform's first key), never its id or label, so the pane cannot name the key; a header with the key label would need a gateway change
- a successful request shows no key at all (X-Routed-Via has platform/model only)
- lib/diagnose.js parseTrail reads "key1: reason" (error text), not the header form "key1=reason"

## /model explore (2026-11-25)

Open:
- limited models are skipped rather than queued until they are back; a sweep of a provider that is rate limited reports them as failed-busy
- no argument to limit the tier (tier 0 only) or the concurrency

## Cards for takeover and sweep messages, status bar error (2026-11-25)

Open:
- the colour path of card() is not covered by a test (tests run piped); the other note() messages of the exploration are still one-liners

## /model a,b,c, sweep suggestion (2026-11-25)

Open:
- the list is not saved with the session, and not shown in /status; the gateway's own routing (auto) still picks any model, the list only limits what the harness picks and fails over to

## /model next picker: what is left, scrolling (2026-11-25)

Open:
- no test for the scrolling dialog (it needs a terminal); the request-rate window left (req/min used/limit) is not in the line, only limits that are on and the token budget

## /model sweep (2026-11-25)

Open:
- lastSweep is not saved with the session; /model a,b,c does not accept the names split over several pasted lines

## Picker columns (2026-11-25)

Open:
- no test for the dialog drawing (needs a terminal); string options are unchanged

## /gateway usage: keys and spread (2026-11-25)

Open:
- the ledger lists only keys with usage this month, so without a dashboard session the key count is the used keys; shares are of tokens (requests for keys that logged none); not run against the live gateway

## /gateway limited layout (2026-11-25)

Open:
- a narrow terminal loses the detail and the providers, so the reason is only the "limited by" word

## Selection in /model health (2026-11-25)

Open:
- only /model health is selectable; /gateway limited, /gateway models and the other pagers could take the same select option
- the terminal must send shift+arrows as ESC [ 1;2 A/B (J and K work everywhere); no mouse selection
- smoke.sh does not run test-pager-select.js under a pty

## Column filters in the selectable list (2026-11-25)

Open:
- filters are plain substring matches (no regex, no numeric comparison such as rate>50); a column hidden by a narrow terminal can still be filtered, but its header is not visible

## Providers in the picker (2026-11-25)

Open:
- no test for the dialog layout (needs a terminal)

## Split pane keys (2026-11-25)

Open:
- not tested with a real keyboard: F2 may be taken by the terminal or the tmux/window manager, Alt may be sent as Meta by some terminals; no unit test (needs a tty)
- the full-screen list's terminal.js speed-up lives in the qjs-modules repo, not installed yet (see tool-registry PROPOSALS.md)
