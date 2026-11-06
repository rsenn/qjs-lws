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

All four steps are done (see Done).

## Backlog

**Wanted, not started** (decided 2026-11-04, one at a time; numbers are the
ideas in [PROVIDERS.md](PROVIDERS.md)): 2 model selection `site/model`; 3 tool
call tolerance (done, see Done); 5 capabilities in `/v1/models`; 6 replay framing; 8 `check`
command; 9 per-site latency and timeout override; 10 more refusal detection;
11 per-site message budgets; 12 housekeeping (leftover tabs, bridge-made
chats); 13 estimated `usage`.

From the provider sweep (details in PROVIDERS.md):

- **Capabilities in `/v1/models`:** `tools: false` for sites that ignore the
  tool preamble (chatgpt, duck, deepai), so ollama-repl does not try tool
  work on them and failover skips them for tool tasks.
- **Replay framing:** gemini read a replayed transcript (with tool results) as
  instructions; wrap the flattened transcript in a clear "continue, answer the
  last message only" frame.
- **Known start state per tab:** deepai can sit in an image-edit mode; model
  pickers and modes should be reset by `newChat()`.
- **Per-site timeouts:** openrouter streams about one chunk per second (112 s
  for 120 words); give sites an expected latency and let clients override.
- **`check` command** printing the PROVIDERS.md table for the open sites.

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
- Externalise the site table further: `$CHAT_BRIDGE_SITES` (a JSON file merged
  over the built-in table) exists, but there is no default location such as
  `~/.config/chat-bridge/sites.json`, and no way to override one field of a
  built-in site.
- Windows: the user sees extra browser windows appearing with their normal
  Chrome (not Firefox or Brave). `Target.createTarget` with `newWindow:false`
  kept all tabs in one window in an isolated Chrome 156 on Xvfb, so the cause
  is in the user's setup and is not found yet. Suspects: the profile's
  last-active window is minimised, a popup/app/incognito window, or the CDP
  browser shares a profile with the normal one. Needed: which window appears
  and when (every request, or the first of a site). serve now navigates
  already open blank tabs first (see Done); `--new-tabs` always creates.
- Site names: the bridge serves a model name with the first site whose name
  is a substring of it (see BUGS, chat-bridge-model-substring-match).

### 6. Tests

- `test/run.sh` (fake site, throwaway headless Chrome) exists but is not in
  ctest yet; it needs google-chrome and `QUICKJS_MODULE_PATH`. Still missing
  in it: context matching across requests (history continues vs a fresh
  chat), pooling with several parallel requests, the no-blank-tab case, a
  login redirect, and selector rot detected by the bridge instead of a plain
  error.
- Unit tests for `planPrompt()` (`extractCalls()` has `test-tool-calls.js`).
- The experiment this is meant to serve: a web chat, driven through the
  bridge and ollama-repl, regenerates `chat-bridge.js` and must pass the
  same `test/run.sh` probe (rungs: one pure function, a module from the
  README spec, the whole file, then self-healing selectors).

### 7. Verification gaps

- Mistral concurrency (`--max` parallel tabs) and a long streamed reply.
- ChatGPT with a logged-in layout.
- Gemini, Qwen, Duck, DeepAI, OpenRouter: streaming and tool calls (only
  DeepSeek and Mistral were run through all of them).
- `/clear` in ollama-repl against a live site, end to end.

## Done

- chat creation measures: tool results ignored when matching a tab's history,
  `maxPrompt` per site (duck 16000), chats recorded and listed (`chats`);
  open: deleting chats on the sites, a `--max-chats` budget, CDP file
  attachment (`DOM.setFileInputFiles`) for files too big to paste
- chatgpt (logged in) reply selector `[data-markdown-text-style="assistant-message"]`;
  replies get their code fences back from the `<pre>` elements
- coding task without tools (`ollama-repl --no-tools`, files attached as text,
  reply `File:` blocks): deepai, duck and chatgpt all pass the slugify task

- tool use for chatgpt, duck and deepai tried harder (2026-11-04): worked
  example call in `toolPreamble()` plus an end-of-prompt reminder; duck
  sometimes obeys, deepai and chatgpt still do not (open, see PROVIDERS.md)
- the library and tests no longer rely on the qjs-modules compat-layer
  globals (`setTimeout` etc. imported from `os`); ctest runs them with bare
  `qjs`
- failover step 4: `ollama-repl/lib/handoff.js`. A failover keeps the base
  messages, the last 3 user turns (big tool results clipped to 600 chars) and
  replaces older turns by a summary from `qwen3:4b-instruct` (headings FACTS,
  GOAL, DONE, READ ONLY, NOT DONE YET; a plain digest if ollama is
  unreachable). Options `--handoff-turns`, `--handoff-model`, `--no-handoff`.
  Verified live: 5 turns on deepseek, `/model mistral` (limited), 14 -> 8
  messages, the next model still knew the code word and the language. A first
  prompt without FACTS lost them, and one without DONE/NOT DONE claimed
  unfinished work was finished: the summarizer needs the strict headings
- billing guard (idea 1): `billing` class per site, metered sites refused
  unless `--allow-paid`, Enter only with focus in the prompt box, payment page
  detection; `ollama-repl --allow-paid` passes it on
- tabs the bridge opened are closed only when of no use any more: a site that hit
  its message limit has its tabs retired (an in-flight one on release); used chats
  that can still take a prompt are never closed
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
- Tool call tolerance: `tool-calls.js` (`extractCalls(text, tools)`, tests in
  `test-tool-calls.js`) accepts flat arguments (the keys the schema lists),
  `parameters`/`args`/`input`, string arguments, the OpenAI `function` shape
  and a `tool` name key, and drops a call missing a required argument (the
  `read_file {}` case). Not done: telling the model once that a call had no
  usable arguments.
- Fake-site test: `test/run.sh` (headless Chrome, `test/fake-site.html`, `test/probe.js`) covers models, plain/streamed replies, tool calls, 502/429 refusals and a changed layout; sites can be added with `CHAT_BRIDGE_SITES`.
- serve navigates already open blank tabs first and creates a background tab only when none is left (`--new-tabs`: always create); `dispose()` sends a borrowed tab back to about:blank. Not verified: that created tabs stay in the same window in the user's browser (checked only in an isolated Chrome, see PROVIDERS or the commit).
- Session 2026-11-05 summary: `tool-calls.js` (tolerant tool-call parsing)
  with `test-tool-calls.js`; `$CHAT_BRIDGE_SITES`; `test/` (fake site, probe,
  runner); blank tabs first. ollama-repl was re-checked and is not affected:
  it has its own `lib/text-tool-calls.js` and takes the bridge's structured
  `tool_calls`. Not done from this session: telling the model once when a
  call had no usable arguments (needs a retry path in the request handler).
