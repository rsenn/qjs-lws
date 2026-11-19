# chat-bridge: supporting the ollama-repl harness

Plan of 2026-11-19. Goal: `--provider bridge` gets the same model, quota and
routing awareness as `--provider freellm`, so the harness functions built for
the freellmapi gateway (limits and reset times, `/model list`, `/route`,
`/standby`, delegation, context window and status meters) work over the
bridge too. Today the harness treats the bridge as a bare OpenAI endpoint with
a failover list; everything gateway-specific is off.

Files this touches: `examples/chat-bridge/chat-bridge.js`,
`examples/ollama-repl/lib/{freellm,availability,standby,delegates}.js`,
`examples/ollama-repl/repl.js`. Open work lives in [../TODO.md](../TODO.md),
site facts in [PROVIDERS.md](PROVIDERS.md).

## 1. What the harness uses from freellmapi

Measured on the code (2026-11-19). `gateway.enabled` is decided by
`GET /v1/usage` answering `{object: 'usage'}` (`Gateway.detect()`); the
dashboard calls need a login (`gateway.dashboard`).

| harness function | reads from the gateway |
|---|---|
| gateway on/off, `/gateway usage` | `/v1/usage`: month, requests, tokens, byPlatform, byKey, resetsAt |
| `/gateway providers` | `/v1/providers`: per platform status, keys, `resume_at`, `requests_remaining_pct`, last error |
| `/gateway forecast` | `/v1/quota-forecast`: pools with limit, remaining, `reset_at`, low balance |
| `/model list`, context window, compaction | `/v1/models`: `name`, `context_window`, `execution_status` (ready, exhausted, needsKey), `unavailable_reason`, `supported_parameters` |
| per-request status line, `/last`, Ctrl-O | response headers `x-routed-via`, `x-request-id`, `x-fallback-attempts`, `x-fallback-trail`, `x-ratelimit-limit/remaining/reset`; body `usage` (prompt, completion, reasoning, cached), `provider` |
| `/route`, sticky routing | request `model` = `auto`, `auto:smart|fast|cheap|reliable|balanced`, `auto:PROFILE`, a pinned id; header `x-session-id` |
| limits with reset times, `/gateway limits|limited`, hidden/limited models | dashboard: `rate-limit-usage` (req/min, req/day, tok/min), `token-usage` (monthly budget), `keys` (cooldowns with expiry and source, caps, scope, status), `penalty-inspector` (error texts) |
| `/standby` (next model), delegation discovery | dashboard `routing` scores (reliability, speed, intelligence), `/api/models` rows, `supportsTools` |
| `/proxy on|off|probe` | dashboard proxy settings (not applicable to the bridge) |

## 2. What the bridge has and lacks

Today (`chat-bridge.js`): `GET /v1/models` with `id`, `owned_by: chat-bridge`,
`billing`, `max_prompt_chars`, `available`, `unavailable`, `resets_at`;
`POST /v1/chat/completions` (JSON and SSE, tool calls emulated in text,
`usage` always zero); refusals as 429/401/502 with `Retry-After`; an
in-memory cooldown per site; the model name picks the site (first site name
contained in it); tab continuity by history match.

| area | gap | consequence in the harness |
|---|---|---|
| models | no `name`, `context_window`, `execution_status`, capability flags (`tools`, `vision`, `reasoning`), ranks | no context meter, no compaction trigger from the real window, `/model list` shows bare ids, delegation cannot tell tool-capable sites from the three that ignore tools |
| usage | no `/v1/usage`, `/v1/providers`, `/v1/quota-forecast`; `usage` tokens zero | `gateway.enabled` false: `/gateway`, `/route`, status meters, limits all off |
| quota knowledge | messages per site are not counted; free limits are not known (backlog item 11); reset times only from a refusal notice; cooldowns are lost on restart | a limit is found by hitting it, the model list cannot warn before |
| per-request metadata | no `x-routed-via`, `x-request-id`, `x-ratelimit-*`, latency | `/last` and Ctrl-O show nothing about the request |
| routing | no `auto`, no `auto:*`; failover is client side (`lib/failover.js`, handoff), no scores | `/route` cannot work, `/standby` cannot pick "next" |
| tools | `tools: false` sites not flagged; request with tools never streams | harness tries tool work on chat-only sites, then fails over |
| model choice | one model per site (backlog item 1: `site/model`) | `/model list` is 9 sites, not models |
| health | no per-site status, latency, success rate, tab count | no reliability or speed score for ranking, no `/gateway providers` |
| robustness | model to site is a substring match (BUGS); selector rot found by hand (`check` command is backlog) | wrong site on a model name that contains two site names |

## 3. Design decisions

1. **Same shapes, an explicit marker.** The bridge answers `/v1/usage`,
   `/v1/providers`, `/v1/quota-forecast` and the extra `/v1/models` fields in
   the shapes the gateway uses, so the harness code keeps one path. Every such
   answer carries `source: "chat-bridge"` (usage) / `owned_by: "chat-bridge"`
   (models). The harness keeps a `gateway.kind` (`freellmapi` or
   `chat-bridge`) from that marker and shows honest labels (estimated tokens,
   "learned limit") instead of pretending to be a metered API.
2. **Honest numbers.** The sites publish no quotas. The bridge counts
   messages, characters and estimated tokens (`chars / 4`, flagged
   `estimated: true`) per site, learns a message budget from the first limit
   refusal (messages sent since the last reset), and keeps a configured table
   for the known free limits. Unknown stays `null`, never a guess.
3. **No dashboard clone.** The bridge is loopback-only without login, so the
   dashboard-only data (rate windows, keys, cooldowns, scores, error texts) is
   folded into the public endpoints above and one `GET /v1/health`. The
   harness gets one backend interface, not a second login flow.
4. **Harness behind an interface.** `availability.js`, `standby.js` and
   `delegates.js` call the dashboard URLs of the gateway directly. Move that
   behind `lib/gateway.js` with two backends (`FreellmBackend` as today,
   `BridgeBackend`), each returning the same plain structures: `models()`,
   `limits()`, `usage()`, `providers()`, `ranking()`, `probe(id)`.
5. **State in `~/.config/chat-bridge/`** (as ollama-repl's `~/.config/ollama-repl/`):
   `sites.json` (site table overrides, exists as `$CHAT_BRIDGE_SITES`),
   `state.json` (cooldowns, learned budgets, counters, latency, success
   counts), written atomically, read at start.

## 4. Plan

Order is by value per effort; each step is usable alone and ends with a
test and a TODO/ChangeLog update. Sizes: S under half a day, M a day or two,
L several days.

### Step 1: model metadata (S, chat-bridge)

- `/v1/models`: add `name`, `context_window` and `context_length` (per-site
  table in `SITES`, overridable in `sites.json`; `max_prompt_chars / 3.5` when
  only the prompt limit is known), `execution_status` (`ready`, `exhausted`
  while cooling down, `needsKey` when logged out or billing-guarded),
  `supported_parameters`, `capabilities: {tools, vision, reasoning, stream}`
  (`tools: false` for chatgpt, duck, deepai, from PROVIDERS.md).
- Responses: `usage` with estimated tokens (`estimated: true`),
  `x-routed-via: site/model`, `x-request-id`, `x-response-ms`.
- Tests: `test/run.sh` against the fake site; a shape test that compares the
  field names with a saved freellmapi `/v1/models` entry.
- Effect in the harness at once: context meter and compaction window, `/model
  list` names, delegation can skip chat-only sites. No harness change except
  reading `capabilities` in `delegates.js`/`standby.js`.

### Step 2: counters, budgets, health, usage endpoints (M, chat-bridge)

- Count per site and per day/month: requests, prompt and reply characters,
  estimated tokens, refusals by kind; latency (median of the last 20), success
  rate; persist in `state.json`.
- Learn the budget: on a `rate_limit` refusal record the messages sent since
  the previous reset as the site's budget and the parsed reset time as its
  window; configured defaults in `SITES` (backlog item 11).
- Endpoints: `/v1/usage` (`object: 'usage'`, `source`, month, requests,
  tokens, byPlatform), `/v1/providers` (status `healthy|rate_limited|logged_out|
  no_tab|billing_guard`, `keys: 1`, `resume_at`, `requests_remaining_pct`,
  `last_error`, tabs open/busy, median latency), `/v1/quota-forecast` (pool per
  site: limit, remaining, `reset_at`, `low_balance`), `GET /v1/health`.
- Persist cooldowns so a restart does not forget a limit; `x-ratelimit-*`
  headers from the learned budget.
- Effect: `Gateway.detect()` succeeds, `/gateway usage|providers|forecast`
  and the status meters work for the bridge.

### Step 3: backend interface in the harness (M, ollama-repl)

- `lib/gateway.js` with `Gateway` (what `freellm.js` has) and the two
  backends; `kind` from the marker. `availability.js` takes the backend:
  bridge limits come from `/v1/providers` and `/v1/quota-forecast`
  (cooldown end, learned budget, `resume_at`), freellmapi from the dashboard.
- `/gateway limits|limited`, `/model list` (providers column = site, limited
  table with return times), hidden unavailable models, `/standby` and
  delegation discovery use `backend.ranking()` (for the bridge: success rate
  and latency from `/v1/providers`, intelligence from a static order in
  `SITES`).
- `lib/failover.js` stays until step 4; both can coexist (failover only
  triggers on a refusal the bridge could not hide).
- Tests: a fake bridge server in `test/` answering the new endpoints; extend
  `test-availability.js` with the bridge shapes; `smoke.sh` runs it.

### Step 4: routing inside the bridge (L, chat-bridge)

- `model: auto` and `auto:fast|reliable|smart|cheap|balanced`: choose the
  best ready site by the scores of step 2 (reliability, speed, static
  intelligence), only tool-capable ones when the request has tools.
- Server-side retry across sites on a refusal before any reply text: the
  next site gets the transcript flattened (the existing "fresh context" path),
  capped by a per-site replay limit with a clear error instead of a truncated
  chat; report `x-fallback-attempts`, `x-fallback-trail`.
- Sticky routing: `x-session-id` (and `x-chat-bridge-conversation`, backlog
  item 4) pins the conversation to its site and tab, which also tolerates
  client-side compaction better than the exact history match.
- Harness: `/route` works unchanged through the shared shapes; decide then
  whether the client failover and handoff for the bridge are dropped (the
  handoff summary is still worth keeping for long contexts).

### Step 5: more capable bridge (L, chat-bridge)

In the order of the existing backlog, now with the harness as the consumer:
`site/model` selection and the real model list per site (item 1 and the
`/v1/models` listing), stream text for requests with tools until a tool call
appears, cancel generation on client disconnect, honour `max_tokens`/`stop`,
per-site latency and timeout override, `check` command (selector self-test,
result feeds `/v1/health` and the site status), a clean start state per tab,
the model-to-site matching fix (BUGS: substring).

### Step 6: cleanup

Remove the bridge special cases from `repl.js` that the shared path made
redundant (`failoverHook` for the bridge if step 4 lands), document the
contract in README, update PROVIDERS.md and the TODOs.

## 5. Open questions

1. **Identity.** Same endpoint shapes plus a marker (recommended, section 3)
   or a distinct `/v1/bridge/*` set that the harness learns separately?
   The first keeps one code path; the second keeps the bridge from looking
   like a metered API to other clients that probe `/v1/usage`.
2. **Where routing lives.** The bridge (step 4) or the harness (today's
   failover plus handoff)? In the bridge it serves every client; in the
   harness the handoff can summarize with a local model. The plan keeps both
   until step 4 shows which one is used.
3. **Learned budgets.** The first refusal teaches the limit, so a fresh
   install knows nothing. Ship a table of the known free limits (messages per
   day and per window) or leave unknown until learned?
4. **Estimated tokens.** `chars / 4` is crude for German text and code; is a
   tokenizer for a few families worth it, or is a labelled estimate enough?
5. **Scope of step 5.** `site/model` needs UI scraping per site and breaks
   with each redesign; do the three sites with URL-based model selection
   first (openrouter) and leave the rest?

## 6. Verification

- Shape parity: save a freellmapi `/v1/models`, `/v1/usage`, `/v1/providers`
  and `/v1/quota-forecast` answer as fixtures; a test checks the bridge's
  answers carry every field the harness reads (list in section 1).
- End to end: `test/run.sh` with the fake site, then the ollama-repl
  `smoke.sh` against a bridge on a free port: `/gateway usage`, `/model list`,
  `/gateway limits`, `/standby probe`, `/delegate`, a forced rate limit
  (fake site) showing up as a limited model with its return time.
- A live pass with two logged-in sites before step 4.
