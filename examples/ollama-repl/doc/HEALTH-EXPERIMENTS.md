# Model health, exploration and switchover: what the data says and what was done (2026-11-25)

Status: the fixes below are built and tested (Phases 1 to 3, 4.1, 4.3); the numbers are the
state before them. What is left is in the last section. Data: the live session `qjs-modules` read through `ollama-repl-ctl` (`/gateway
status|usage|limited|keys|quota|providers|models`, `/events`, `/proxy`,
`/standby`), and the files under `~/.cache/ollama-repl/` of that day:
`usage.jsonl` (4206 requests, 07:22 to 21:42), `exploration.json` (276 models),
`ratings.json` (69), `cooldowns.json`, `quota.jsonl`. Numbers below are from
that one day and one gateway (freellmapi at localhost:3001, 699 models, 83 keys).
The safe way to run experiments: a script that talks to the gateway uses `FREELLMAPI_URL`
(default `http://localhost:3001/v1`) and `FREELLMAPI_KEY`, never `OPENAI_API_URL`.

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
  `upstream provider errors`. CORRECTED 2026-11-25: they are not exploration
  probes. Only the main client has an `onMeta` (repl.js, `client.onMeta`), the
  explore, standby and sub-agent clients do not, so usage.jsonl holds the main
  client's requests only. The bursts of different models within seconds are the
  harness's own retry chain: `chatRound` skips the spent model and asks again, up to
  `AUTO_SKIPS` (8) times per round, so a run is at most 9 requests (the longest run
  seen has 9). Each skip is a real request that fails in about 0.3 s, so the
  failure count mixes "the turn failed" with "one hop of the chain failed".

## Exploration

- 276 models explored: 98 usable, 178 failed. 160 of the 178 are transient
  (144 diagnosed `rate-limited`, 13 `upstream`). The probe mostly measures
  whether the provider happens to be limited at that moment.
- Tier 1 (12k context) ran for 38 models, 29 passed. Of the 9 failures, 5 are
  rate limits (shown to the user as `12k context lost`) and 3 are the
  nemotron-3.5-lightning family: recall 3/3 but `finish: length` with
  `max_tokens` 400, so the tool call never came. The same model served 2314
  real requests with 53 failures (2.3 %). Two defects, fixed (2.2, 2.3).
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
  nemotron-3-ultra 150/1 all at the cap). Fixed (2.4, 3.3).

## Switchover

- After a failure the next success came from kilo 17, google 11, nvidia 5,
  electronhub 3 times: the failover mostly lands on the biggest provider
  anyway, and kilo is the one that is already 77 % of the load.
- The gateway reports 195 of 699 models ready; the pace-time "back" column
  is exact for daily resets and `?` for `exhausted` (gemini-3.5-flash).

## What was done

Every item had a test and closed its `BUGS` entry; tests are in `tests/`.

| Item | What | Where |
|---|---|---|
| 1.1 | `attempt` on usage rows: 0 is the first try, n the n-th automatic `/model skip` retry of the round (only the main client logs usage; the rows cannot otherwise tell a failed turn from a failed hop of the retry chain) | `repl.js` `chatRound`/`onMeta`, `lib/persist.js` `usageRow` |
| 1.2 | `qjsm usage-baseline.js [--days N] [--origin URL] [--json]` prints the numbers of this document (turns, error classes, fallbacks vs latency, per platform, failure runs, time to next success) | `lib/usage-baseline.js` |
| 2.1 | Tor control host from the socks URL (`torHost`; `TORHOST` still wins) for `autoExit`, `/proxy exit` and `fixKeyless` | `lib/proxy-probe.js` |
| 2.2 | tier 1 probe budget 400 to 1500 reply tokens, one retry with 3000 when cut off at the limit after all facts were recalled | `lib/exploration.js` `probeDeep` |
| 2.3 | a rate-limited tier 1 probe is "not tested (provider busy)" (`12k?`), never "context lost" | `repl.js`, `lib/events.js`, `lib/exploration.js` |
| 2.4 | a failed request with no `routedVia`, or an error of our own code, is not rated; the row stays in usage.jsonl and the baseline classes it `harness exception` | `lib/harness-error.js`, `repl.js` `onMeta` |
| 2.5 | `test-rawcolor.js` takes its colours from `lib/palette.js` | tests |
| 2.6 | `fg` was used and not imported in `repl.js` (the long live reasoning panel threw); `check-names.cjs` finds undeclared and doubly declared names | `repl.js`, `check-names.cjs` |
| 3.1 | a provider that just rate-limited (transient diagnosis with `retryAt`) is not probed again in the same run: its other models are skipped, not cached (evidence: 106 electronhub models probed one by one after "resumes in 16 h") | `lib/exploration.js` `run`, option `platformsOf` |
| 3.2 | the probe queue goes best first: served in the last 24 h (+100), then rating | `lib/exploration.js` option `priority`, `repl.js` `exploreOrder` |
| 3.3 | rating: `reliability(ok, fail) = n/(n+10) * clamp(10 - 150 * failRate, -10, 10)` replaces the flat `((ok+1)/(n+2)-0.5)*20` (428/0 gives 9.8, 150/1 8.4, 2314/53 6.6, 7 % failures 0, 20 % -10; no data 0); the `adj` cap stays; used instead of the Wilson bound of the first plan: simpler, same order for the three cases | `lib/rating.js` |
| 4.1 | tier 1 rerun (12k tokens, with tools, 3 runs each, local gateway): at 400 tokens 1 run in 3 of `-30b` and of `-30b-a3b` was cut off without a tool call, at 1500 all 6 passed; the base `nemotron-3.5-lightning` was not testable (5 routes: 3 rate-limited, 2 without tool calling; one provider key rejected as invalid) | rerun |

## Before snapshot (4.2)

`qjsm usage-baseline.js --days 1` on 2026-11-25, 4264 requests, all with the old code:

| measure | before | after (fill in after a day on the new code) |
|---|---|---|
| failed turns | 131 of 4255 = 3.2 % | |
| failed hops | 140 (94 all exhausted, 25 upstream, 12 harness exceptions) | |
| time to next success | median 17 s, p90 396 s, longest run 9 turns | |
| kilo share of requests | 2865 of 4264 = 67 % | |
| gateway retries 1+ | 61 requests | |

## Not built, with the reason

- **3.4 failover headroom** (prefer a provider with quota left over the biggest one; target: the kilo
  share after failures, 17 of 38, falls), **3.5 faster switch** (on "All models exhausted" for a pinned
  model switch at once; cheap 0.3 s failures repeat up to 9 times, median 13 s to recovery; part of it
  exists: `/model skip` drops every model of a provider the error names) and **3.11 the req/day meter**
  feeding failover and the automatic exit decision. They change the retry chain of `chatRound`
  and need a live gateway to measure; next step: the 4.2 baseline with `attempt` rows.
- **3.10 quota bar:** "584M/2.3G budgeted tokens" vs 876M this month: which tokens `budget.totalUsed`
  counts is not known; the text is not reworded on a guess (question in `GATEWAY-PROPOSALS.md`).
- **3.6 to 3.9** are gateway changes, written up with their evidence in `GATEWAY-PROPOSALS.md`.

## Decisions still needed from the user

1. Should kilo (the main provider, 22 keys behind the LAN Tor since the proxy policy went live,
   about 21:58 on 2026-11-25; split usage.jsonl there to compare latency, ttfb and errors per platform)
   stay on Tor?
2. Who takes the gateway proposals 3.6 to 3.9?
