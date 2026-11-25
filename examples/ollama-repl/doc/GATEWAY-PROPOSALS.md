# Gateway proposals (freellmapi)

Changes the harness cannot make itself, found while measuring model health on
2026-11-25 (see HEALTH-EXPERIMENTS.md). Each has its evidence and a
success check. Nobody has taken them yet; the harness works around each one.

## 3.6 Key spread

kilo's three keys carry 87 / 12 / 1 % of the requests. A balanced pick per request
(least recently used, or weighted by quota left) would spread the rate limits.
Success: the spread over the keys in `/gateway usage` is near even. Caveat: two of the three Kilo
tokens belong to one user (the tokens are JWTs with a `kiloUserId`) and Kilo reports no usage per key,
so the keys may share one limit; then spreading over them gains nothing. Check with the analytics
endpoints (`usageAnalytics.getBreakdown`, dimension user) and a valid token first.

## 3.7 `blocked` false negatives

The gateway lists a model as usable while its provider is `rate_limited`: the
diagnosis of 144 probes says so. The availability should reflect the provider
status. Success: probes failing with rate-limited on a model the gateway listed
usable drop.

## 3.8 Daily resets are not cooldowns

Fixed clock times (01:00, 06:55 to 07:04, 13:35) are labelled `cooldown`. Expose the
reset kind and the exact end. Success: the "back" column has no `?` for exhausted
models.

## 3.9 Route check for tool support

"1 model lacks tool-calling" appears among the candidates of a request with tools:
filter before counting routes. Success: fewer `All models exhausted` with a tool-less
route in the count.

## 3.10 What `budget.totalUsed` counts (question)

`/gateway quota` shows "584M/2.3G budgeted tokens used" while the per-model month
column adds up to about 876M. Which tokens does `totalUsed` count (only budgeted
models? only free ones?). The harness does not reword its text until this is known.

## 4.1 Invalid upstream key (found by the rerun)

A request for `nemotron-3.5-lightning` failed with "All 3 attempted provider key(s) failed
authentication. The configured upstream API key(s) look invalid", while its other routes were
rate-limited or lack tool calling. One provider key of the gateway needs replacing or disabling;
`/gateway keys` shows the status. The gateway could also disable a key that fails authentication
so it stops being counted as an attempted route.
