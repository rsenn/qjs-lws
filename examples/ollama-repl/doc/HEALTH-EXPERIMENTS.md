# Model health, exploration and switchover: what the data says (2026-11-25)

Data: the live session `qjs-modules` read through `ollama-repl-ctl` (`/gateway
status|usage|limited|keys|quota|providers|models`, `/events`, `/proxy`,
`/standby`), and the files under `~/.cache/ollama-repl/` of that day:
`usage.jsonl` (4206 requests, 07:22 to 21:42), `exploration.json` (276 models),
`ratings.json` (69), `cooldowns.json`, `quota.jsonl`. Numbers below are from
that one day and one gateway (freellmapi at localhost:3001, 699 models, 83 keys).

## What happened to the requests

- 4206 requests, 3983 answered (200), 236 with an error. 122 of the errors are
  `interrupted` (the user), 104 are real, 1 is the gateway's own 120/min cap.
- 2878 requests pinned `nemotron-3.5-lightning`, 762 asked `auto`. kilo served
  77 % of the month's tokens (key 7 87 %, key 68 12 %, third key 1 %), nvidia 14 %.
- Median 1.9 s per request, p90 6.5 s. A request the gateway had to retry
  (`fallbacks` 1) takes 3.2 s median instead of 1.9 s; 3 % of the requests had one.
- Failures come in runs: 45 runs, 25 of a single request, the longest 9
  requests over 35 minutes. Median time from the first failure to the next
  success 13 s, p90 148 s.
- Of the 104 real failures, 73 are `All models exhausted/rate-limited` and 21
  `upstream provider errors`. Many of the 73 look like exploration probes of
  models the gateway already had on cooldown (one burst at 07:56 asks 6
  different unpinned models within 5 s); this is inferred from the requested
  names and the timing, usage.jsonl cannot tell probes from user requests.

## Exploration

- 276 models explored: 98 usable, 178 failed. 160 of the 178 are transient
  (144 diagnosed `rate-limited`, 13 `upstream`). The probe mostly measures
  whether the provider happens to be limited at that moment.
- Tier 1 (12k context) ran for 38 models, 29 passed. Of the 9 failures, 5 are
  rate limits (shown to the user as `12k context lost`) and 3 are the
  nemotron-3.5-lightning family: recall 3/3 but `finish: length` with
  `max_tokens` 400, so the tool call never came. The same model served 2314
  real requests with 53 failures (2.3 %). Two defects, see BUGS.
- 74 of the 98 usable models were never used in the 14 hours: traffic is
  concentrated on 3 models, the exploration verifies the other 95.
- Verdicts of passed models are never asked again (by design); their median
  age is 15 h and 7 of 98 are blocked by now (`live` tracks that).
- Some failures say "1 model lacks tool-calling" in the gateway's route check:
  a route without tool support is among the candidates of a request that
  carries tools. Not analysed further (which requests, probe or user).
- A passed `claude-sonnet-4-5` is served by `nvidia/poolside/laguna-xs-2.1`:
  the model name says nothing about the model; `servedBy` is the truth.

## Health detection and ratings

- `blocked` from the gateway's availability misses limits: the diagnosis of
  144 probes says "the gateway lists it as usable" while the provider was
  `rate_limited`.
- Cooldown ends cluster at fixed clock times (01:00 xkiro, bazaarlink,
  openrouter; 06:55 to 07:04 ovh, router9, llmtr; 13:35 electronhub), that is
  daily or monthly resets labelled `cooldown`. electronhub: 106 models all
  `no credits` for 15 h, yet 14 explored `usable`.
- A failed request is rated against the requested name (`auto` has 30
  failures, 0 successes); harness exceptions count as model failures;
  `adj` saturates at +25 (laguna 428/0, nemotron-3.5-lightning 2314/53 and
  nemotron-3-ultra 150/1 all at the cap). See BUGS.

## Switchover

- After a failure the next success came from kilo 17, google 11, nvidia 5,
  electronhub 3 times: the failover mostly lands on the biggest provider
  anyway, and kilo is the one that is already 77 % of the load.
- The gateway reports 195 of 699 models ready; the pace-time "back" column
  is exact for daily resets and `?` for `exhausted` (gemini-3.5-flash).

## Plan

Order is by dependency. Every item: where, the change, the test, how success
shows in `usage.jsonl` / `exploration.json`, and who owns it (H = this harness,
G = the freellmapi gateway). A fix removes its entry from BUGS in the same commit;
tests run with `~/Sources/quickjs/qjs-modules/build/x86_64-linux-gnu/qjsm` (the
installed qjsm has no `terminal/*` yet); examples/ needs no ChangeLog entry.

### Phase 0: before any fix

- **0.1 Commit what is pending** (proxy policy, exhausted-provider trigger, net-pane
  chips, BUGS, this doc), so every item below is one commit. Needs the user's OK. H
- **0.2 Experiment safety rule.** A script that talks to the gateway uses
  `FREELLMAPI_URL` (default `http://localhost:3001/v1`) and `FREELLMAPI_KEY`,
  never `OPENAI_API_URL` (it points to another service here). The key comes from
  the user; it is not read from the live session's environment. Alternative with no
  key: drive the live session's own `/model explore PATTERN` (a forced sweep under
  its key), only with the user's OK. H
- **0.3 The proxy policy is live and persistent.** The session put 22 keys behind
  the LAN Tor (`192.168.178.52:9050`), `kilo` (77 % of the tokens) among them; this
  is gateway key state and outlives the harness. Measure before/after per platform
  (latency, ttfb, errors; split usage.jsonl at about 21:58 on 2026-11-25) and let the
  user decide whether the main provider should stay on Tor. H + user

### Phase 1: instrumentation (everything below depends on it)

- **1.1 Label usage records.** `lib/persist.js: appendUsage`, `repl.js: onMeta`
  (about line 2936): add `label` (main, explore, standby, sub, handoff) from the
  client's net label; `readUsage` and `/usage` take it as a filter. Test: extend
  the persist test, a record keeps its label through a round trip. Success: the
  failure rate of label main is computable; the baseline (104 real failures, 73
  exhausted/rate-limited) is recomputed without probes and written into this file. H
- **1.2 Baseline script.** `tools/` or the scratchpad script that produced the
  numbers above, kept in the repo (qjsm, no python), so every later phase can rerun
  it. Success: one command prints the table of this document. H

### Phase 2: correctness (each with a test, each closes a BUGS entry)

- **2.1 exit-change-uses-wrong-tor-host.** `repl.js: autoExit` and `/proxy exit`:
  take the host from the socks URL (as `fixKeyless` and `keylessProxy` do), one helper
  `torHost(socksUrl)` in `lib/proxy-probe.js`. Test: the helper on
  `socks5://192.168.178.52:9050`, `socks5h://[::1]:9050`, no URL. Success: NEWNYM
  reaches the control port of the proxy's host; exit address changes in the pane. H
- **2.2 deep-probe-max-tokens-too-small.** `lib/exploration.js: probeDeep`: raise
  `max_tokens` (1500), and on `finish: length` with recall 3 and no tool call retry
  once with 3000 before failing. Test: fake client answering length then a tool
  call. Success: the three nemotron-3.5-lightning variants pass tier 1 in
  exploration.json; run the rerun at 400/1500 (item 4.1) to confirm. H
- **2.3 deep-probe-transient-error-shown-as-context-lost.** `repl.js: explored`
  (about line 3075) and `lib/exploration.js: probeBrief/deepText`: a deep result
  with `transient` is "busy", never "context failed/lost"; `needsDeep` already
  retries it. Test: test-events.js and a probeBrief case. Success: no `context
  lost` event for a rate-limited deep probe. H
- **2.4 failed-request-rated-against-requested-name.** `repl.js: onMeta` (about
  line 2938): no `routedVia` means a gateway-wide failure, rated against nobody;
  a harness-side exception (not an HTTP/provider error) is not rated and not
  written as a usage error. Test: onMeta with and without routedVia, with a
  TypeError. Success: `auto` has no failures in ratings.json after a day; 12 of 236
  logged errors (harness exceptions) disappear. H
- **2.5 rawcolor-test-expects-old-colors.** `test-rawcolor.js`: import the colors
  from `lib/palette.js` instead of hard-coding the values. Success: the 4 failures go
  away and a palette change cannot break the test again. H
- **2.6 Harness exceptions in the request path** (`is not defined`, `not a
  function`, `unknown color`): find what throws where a request is made, fix it;
  2.4 only stops them from being rated. Success: none in the next day's usage.jsonl. H

### Phase 3: policy, each measured against the Phase 1 baseline

Harness (H):
- **3.1 Do not probe a limited provider.** `repl.js: exploreKeylessAgain`,
  startup exploration, `/model health`: skip ids whose provider the availability
  or `cooldowns.json` marks limited; re-probe at the known reset (exact clock
  times, e.g. 01:00 and 13:35) instead of after a fixed hour (`Exploration.fresh`
  uses `retryAt`). Test: availability fixture. Success: share of transient
  `rate-limited` verdicts in exploration.json falls from 160 of 178 (90 %). H
- **3.2 Explore what traffic will need.** Order the probe queue by rating and
  recent use (usage.jsonl, ratings.json), not by the ready list. Success: of the
  verified models, the share used within the day rises from 24 of 98. H
- **3.3 Rating without a cap.** `lib/rating.js: ADJ_CAP`: lower confidence bound
  of the success rate (Wilson) plus a latency term. Test: 428/0, 2314/53 and 150/1
  rank in that order of bound, not tied. Success: ratings.json has no three-way tie
  at the cap. H
- **3.4 Failover headroom.** `repl.js: /model next`, `skip`, takeover and the
  standby choice: prefer a provider with quota left (`/gateway quota`) over the
  biggest one. Success: the share of kilo after failures (17 of 38) falls, no new
  failure runs. H
- **3.5 Gateway-wide failure pacing.** On `All models exhausted` for a pinned
  model, switch at once (the cheap 0.3 s failures repeat up to 9 times in a run);
  longest run 9 requests, median 13 s to recovery today. Success: run length and
  time to next success in usage.jsonl. H

Gateway (G, proposals for freellmapi, not harness code):
- **3.6 Key spread.** kilo's three keys carry 87/12/1 %; a balanced pick per
  request. Success: spread over the keys in `/gateway usage`.
- **3.7 `blocked` false negatives.** The gateway lists a model usable while its
  provider is `rate_limited` (the diagnosis of 144 probes says so); the
  availability should reflect the provider status. Success: probes failing with
  rate-limited on a model the gateway listed usable drop.
- **3.8 Daily resets are not cooldowns.** Fixed clock times (01:00, 06:55..07:04,
  13:35) labelled `cooldown`; expose the reset kind and the exact end. Success:
  the "back" column has no `?` for exhausted models.
- **3.9 Route check for tool support.** "1 model lacks tool-calling" among the
  candidates of a request with tools: filter before counting routes. Success: fewer
  `All models exhausted` with a tool-less route in the count.

### Phase 4: verification

- **4.1 max_tokens rerun.** Tier 1 probe of nemotron-3.5-lightning (and -30b,
  -30b-a3b) at 400 and 1500, 3 runs each, through the gateway's own URL and an
  approved key (see 0.2). Success: pass at 1500, finish length at 400.
- **4.2 A day later.** Rerun the baseline script (1.2) on the day after 2.x and 3.x
  are in and fill a before/after table here: real failure rate (label main), median
  time to recovery, transient verdict share, used share of verified models, kilo
  share, rating ties.
- **4.3 Doc and TODO.** Move done items to Done in `TODO.md`, remove closed BUGS
  entries, update README and ARCHITECTURE for the label and the exploration order.

### Decisions needed from the user

1. Commit the pending work now (0.1)?
2. Live probes: a key from you, or may I drive the live session's `/model explore` (0.2)?
3. Should kilo (the main provider) stay behind Tor (0.3)?
4. Who takes the gateway proposals 3.6 to 3.9?

Not done: no live experiment against the gateway (see the note in the session
report: an attempt with the wrong endpoint was rejected, nothing was served);
the max_tokens hypothesis rests on the cached results, not on a rerun.
