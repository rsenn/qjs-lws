# chat-bridge TODO

## Failover plan (ollama-repl over chat-bridge)

Goal: when a site behind the bridge hits its quota or refuses to work,
ollama-repl switches to another available model by itself, without
replaying the whole conversation to it.

1. **Bridge reports refusals** (chat-bridge.js)
   - detect, while waiting for a reply: a rate-limit/quota notice (new page
     text matching limit phrases in de/en, ignoring text that was on the
     page before the send or that is part of the prompt), a login redirect,
     a prompt the page never took (input never emptied)
   - answer in OpenAI's shape: 429 `rate_limit_exceeded` (+ `Retry-After`
     from a parsed reset time, default 15 min), 401 `login_required`, 502
     `prompt_not_accepted`; for streaming return the same status before any
     chunk is sent
   - clear the unsent prompt from the input box (fixes
     `chat-bridge-failed-send-leaves-text-in-input`)
   - remember a rate-limited/logged-out site as cooling down: later
     requests fail instantly without touching the browser
   - `/v1/models` entries carry `available` and `resets_at`
2. **ollama-repl learns the endpoint** (examples/ollama-repl)
   - openai-client.js: typed errors (`status`, `code`, `retryAfter`) instead
     of a plain Error with the body pasted in
   - openai-client.js: `listModels()` over `/v1/models`, so `--model list`
     and `/model list` work for `--provider openai`; `/model NAME` is
     checked against that list
3. **Automatic fallback list** (no `--fallback` option)
   - when the OpenAI endpoint is a chat-bridge (its `/v1/models` entries are
     `owned_by: "chat-bridge"`), the repl builds the fallback order itself
     from that list: the current model first, then the other available ones
   - on a rate_limit error: switch to the next available model, say so in
     one line, retry the same turn; login/consent errors skip the model
     without a cooldown wait
   - plain OpenAI-compatible servers (not a bridge) get no automatic
     failover
4. **Handoff instead of replay**
   - the new site has no chat state, so a failover sends system prompt,
     a one-line note that the previous model hit its limit, the last K
     turns (default 6) with bulky tool results cut to N chars, and a summary
     of everything older
   - the summary is written by a small local ollama model, never by the
     exhausted site; K, N and the summary model are settings
   - the bridge needs no change: it already turns a request that does not
     continue a tab's history into one flattened prompt in a fresh chat
   - summary model to pull: `ollama pull qwen3:4b-instruct` (about 2.5 GB,
     fits the 8 GB GPU next to nothing else loaded, no thinking mode to
     strip); alternatives `llama3.2:3b` or `gemma3:4b`. Verify the tag
     with `ollama show` after pulling.

Steps 1, 2 and 3 are done (see Done); 4 is open and tracked in
`ollama-repl/TODO.md` too, since the code for it lives there.

## Backlog

Open items, roughly by value. Bugs are tracked in `BUGS`. Design and spec: [README.md](README.md). Move finished items into the Done section.

### 1. Model selection per site (duck.ai, openrouter, deepai)

Several sites host many models. Proposal: put the model in the request's
`model` field as `site/model` (`duck/gpt-5-mini`,
`openrouter/anthropic/claude-sonnet-4`; only the first `/` splits). A bare
`site` keeps the site default.

- A per-site optional `pick` step runs in `newChat()` after the home
  navigation and before typing. Two forms: **URL-based** when the site takes
  the model as a URL parameter (believed true for openrouter, unchecked),
  most robust; **UI-based** otherwise: open the model dropdown, click the
  entry whose text matches (case-insensitive substring), wait for it to close.
- A tab is bound to its model: the pool key becomes `site/model`, and
  `continues()` must also compare the model. Switching models is always a new
  context.
- `/v1/models` could list the real choices by scraping each picker, cached a
  few minutes; fallback is a static list in `SITES`.
- Start with openrouter (largest list, probably URL-based), then duck, deepai.

### 2. Robustness against the sites

- Refusal detection still misses: consent/terms dialogs that do not stop the
  input from emptying, captchas, and sites whose limit notice is not text
  matching `LIMIT_RE` (add per-site patterns when one turns up).
- A `check` command: for each open site, verify the input selector, send a
  fixed prompt, verify the reply selector, print pass/fail. Catches selector
  rot without a manual hunt.
- Use the site's "stop generating" button/state as the finished signal where
  one exists, instead of only the idle timer (faster, and no cut-off on a
  model that pauses mid-answer).

### 3. API completeness

- Stream text for a request with tools until a tool call appears, instead of
  answering whole.
- Estimated `usage` counts; honour `max_tokens` and `stop` by truncating.
- Cancel generation (click stop) when the client disconnects.
- `response_format: json_object` via an added instruction, `/v1/completions`.
- Attachments: image/file parts through `DOM.setFileInputFiles`.

### 4. Context matching

- Tolerate client-side compaction: fuzzy prefix match, or an explicit
  conversation id header (`x-chat-bridge-conversation`) honoured when sent.
- Per-site cap on transcript replay size, with a clear error rather than a
  silently truncated chat.

### 5. Operations

- Start the browser if no CDP endpoint answers (profile dir from an option).
- Close leftover bridge tabs after a crash (tag them, e.g. by title or URL
  fragment, and sweep on start).
- Optional bearer token for `serve`, and an explicit `--bind` for non-loopback
  use (off by default).
- Externalise the site table (`sites.json` next to the script or in
  `~/.config`) so users can add or override sites without editing the script.

### 6. Tests

- A local mock chat page (textarea, button, a reply element that grows) so
  the context logic, streaming, tool extraction and pooling can run in ctest
  without a browser account.
- Unit tests for `extractCalls()` and `planPrompt()` (pure functions).

### 7. Verification gaps

- Mistral concurrency (`--max` parallel tabs) and a long streamed reply.
- ChatGPT with a logged-in layout.
- Gemini, Qwen, Duck, DeepAI, OpenRouter: streaming and tool calls (only
  DeepSeek and Mistral were run through all of them).
- `/clear` in ollama-repl against a live site, end to end.

## Done

- failover step 1: refusal detection in the bridge (rate limit, login redirect,
  prompt not accepted) answered as OpenAI errors 429/401/502 with Retry-After
  (also for streaming, before any chunk), cooldown per site, `available` and
  `resets_at` in `/v1/models`, unsent prompt cleared from the input box.
  Verified live against mistral's real message limit
- `ollama-repl --provider bridge` starts the bridge itself (free port via
  `--listen 0`, address read from its startup line), picks the model by
  rotating through the available ones, stops the bridge on exit; `serve`
  now checks the CDP port up front
- failover step 3: `ollama-repl/lib/failover.js`. Over an endpoint whose models
  are all `owned_by: "chat-bridge"` a rate-limit or login error switches the
  turn to the next model `/models` lists as available and retries it; no
  option. Verified live: started on rate-limited mistral, moved to deepseek
  with a one-line note, the next prompt stayed on deepseek. Until step 4 the
  retry still sends the whole history
- failover step 2: `OpenAIError` (status, code, type, retryAfter, isRateLimit)
  and `OpenAIClient#listModels()` in ollama-repl; `--model list`, `/model list`
  and a `/model NAME` check work for `--provider openai`
- site table: deepseek, qwen, gemini, kimi (www.kimi.ai), chatgpt, duck, deepai, openrouter, mistral verified; venice, aistudio, groq recorded as skipped
- installed to bin/ as chat-bridge by CMakeLists.txt
