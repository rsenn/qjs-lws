# chat-bridge: provider findings and quirks

What each site behind the bridge actually does when driven through
`chat-bridge.js`, measured on 2026-11-04 with the browser logged in as the
author (all on free plans, EU, German UI). Design and spec: [README.md](README.md).
Open work: [TODO.md](TODO.md).

## How it was tested

Two tests per provider, on the same bridge build.

1. **API probe** (direct requests to `/v1/chat/completions`): a plain prompt
   (`pong`), a streamed 120 word text (counts chunks and their spread), a
   request with two tools (`get_weather`, `add`) asking for one call, then
   for both calls at once, then a tool-result round trip (does the model use
   the result?).
2. **Coding task** through `ollama-repl --provider bridge --model X
   --no-failover`: a mock project (`slug.js` with a buggy `slugify()`,
   `test.js` with 4 cases, 3 failing) and the instruction "read both files, fix
   `slugify()` with `edit_file`, run nothing, touch no test". Pass = the real
   `test.js` run afterwards says `all passed`. The model has the repl's file
   tools (emulated by the bridge as tool calls in text).

## Summary

| provider | plain | stream | tool call | 2 calls | tool result used | coding task | verdict |
|---|---|---|---|---|---|---|---|
| deepseek | ok 6s | 6 chunks / 4s | ok | ok | ok | **pass**, 31s, 5 tool calls | best all-rounder |
| qwen | ok 13s | 6 chunks / 5s | ok | ok | ok | **pass**, 65s, 1 tool call | good, slow per round |
| gemini | ok 15s | 4 chunks / 4s | ok | ok | **no** (see below) | **pass**, 29s | good, one quirk |
| kimi | ok 13s | 6 chunks / 10s | ok | ok | calls the tool again | **pass**, 33s | good |
| openrouter | ok 9s | 112 chunks / 112s | not measured (client timeout) | | | **pass**, 145s, 2 tool calls | works, very slow |
| mistral | ok | ok | ok | ok | ok | not run (message limit hit first) | good until the free limit |
| chatgpt | ok 7s | 4 chunks / 5s | **ignores tools** | ignores | text only | tools **fail**; `--no-tools` **pass**, 15s | chat + files-as-text |
| duck | ok 6s | 7 chunks / 4s | **ignores tools** | ignores | text only | tools **fail**; `--no-tools` **pass**, 6s | chat + files-as-text |
| deepai | ok 5s | 5 chunks / 4s | **ignores tools** | ignores | text only | tools **fail**; `--no-tools` **pass**, 9s | chat + files-as-text |

"Ignores tools" means the site answers the question itself (ChatGPT and duck
searched the web for the weather) or says it has no such tools ("project
file-editing tools are unavailable in this session"), whatever the tool
preamble says.

## Per provider

### deepseek (`chat.deepseek.com`)
- Reply selector `.ds-markdown`. Fastest and most reliable for tool use.
- Code blocks carry the page's button labels in their text ("Kopieren",
  "Herunterladen"). Once a tool call came back as that text plus
  `{"name": "read_file", "path": "slug.js"}` (flat arguments instead of under
  `arguments`), which `extractCalls()` rejects; a retry then sent
  `read_file {}` before the right call. See TODO "tool call tolerance".
- Chats pile up in the sidebar (every fresh chat is a new entry).

### qwen (`chat.qwen.ai`)
- Reply selector `.qwen-markdown`; the account shows plan **Free** and an
  "Upgrade" button; the model picker offers Qwen3.7-Plus.
- Slowest of the good ones: 13 to 17 s for a one-word answer.
- Chat titles are generated from the first prompt, so the sidebar fills with
  test prompts.

### gemini (`gemini.google.com`)
- Input is a Quill editor (`rich-textarea .ql-editor`), reply
  `message-content`.
- **Tool result round trip fails on a replayed transcript:** asked to continue
  after a tool result, it answered "Understood. I am ready to process
  requests according to these rules ..." (it treated the whole replayed
  transcript, preamble included, as instructions). Inside one tab, with the
  conversation continued normally, the coding task worked.
- Leaves `accounts.google.com/RotateCookiesPage` tabs behind.
- Plan label **Free**.

### kimi (`www.kimi.ai/chat`)
- EU users get `www.kimi.ai`, not `kimi.com`: the wrong host looked exactly
  like "Enter does not submit" (the page was a logged-out marketing page).
- Prompt box is a contenteditable (`div[contenteditable="true"]`).
- After a tool result it sometimes calls the tool again instead of answering.
- "Upgrade your plan" shown: free plan.

### chatgpt (`chatgpt.com`)
- Logged in (free plan) since 2026-11-05: replies sit in `[data-markdown-text-style="assistant-message"]` (no `data-message-author-role` any more), and the page shows a floating-chat UI. The sections below describe the earlier logged-out layout.
- Coding without tools works: `ollama-repl --no-tools` attaches the files as text and the reply carries a `File:` block.

- The test browser is not logged in. The page works anonymously but:
  the composer is `#mobile-composer-prompt` (not `#prompt-textarea`), replies
  are `li[data-message-role="assistant"]` (not `data-message-author-role`),
  a cookie banner stays up, and sending raises login prompts ("Chat loeschen?",
  "Anmelden oder registrieren") as dialogs.
- Treats the tool preamble as noise: answers from its own web search, or says
  no file tools exist. Not usable for tool calling, fine for plain chat.
- The logged-in layout is untested.

### duck (`duck.ai`)
- **Caps a message at 16000 characters.** The bridge knows it (`maxPrompt`) and answers `context_length_exceeded`; the default ollama-repl system prompt plus project scan alone exceeded it, hence the short bridge prompt and no scan.
- Coding without tools works (`--no-tools`); the code block comes back with the language label outside the fence, which `extractFileBlocks()` now tolerates.
- Needs a terms dialog accepted once by a human ("Fortsetzen"). The bridge
  does not click through it.
- Class names are hashed; the reply is found by `div.space-y-4.whitespace-normal`.
- Free, anonymous, "Time and Date"-style built-in web search answers weather
  and time questions itself, ignoring tools.

### deepai (`deepai.org/chat`)
- Coding without tools works (`--no-tools`). The attach menu ("Add Photos & Files") exists; CDP file attachment is not implemented because pasting the files as text was enough.
- Composer `#persistentChatbox`, reply `.markdownContainer`.
- The chat has modes; one tab answered with "Error: No image found to edit.
  Please generate or upload an image first." (image edit mode left selected).
  A bridge tab should start from a known mode.
- Ignores tools. Free plan, "Upgrade to DeepAI Pro" banner.

### openrouter (`openrouter.ai/chat`)
- Reply `[data-message-bubble="assistant"]`. Many models behind one chat; the
  bridge uses whatever the page defaults to (see Billing: it was a paid one).
- Very slow: a 120 word stream took 112 s in 112 chunks (about one per
  second), and a coding task 145 s. Tool probes timed out.
- Sends tool-less prompts fine; the pay-as-you-go balance is shown on
  `/settings/credits`.

### mistral (`chat.mistral.ai`)
- Prompt box is a ProseMirror contenteditable; reply
  `[data-message-part-type="answer"]`; chats live under `/work/<id>`.
- Plain, multi-turn, streaming and tool use (single, two calls, round trip)
  all worked before the free message limit hit.
- **Message limit** ("Nachrichtenlimit erreicht", reset in about 2 to 3 h)
  after about 15 test messages. The bridge now reports it as HTTP 429 with
  `Retry-After` and closes the tab.

### Looked at, not adopted
- **venice.ai**: no reply read in a test; anonymous use is gated.
- **aistudio.google.com**: free Gemini API key exists; gemini already covered.
- **console.groq.com/playground**: API playground behind a login, not a chat.
- **mistral.ai/products/vibe**: a product page for a coding CLI.

## Billing: can the bridge cost money?

Looked at read-only on 2026-11-04 (nothing clicked or entered).

- **Consumer chats are free to use.** The plans seen on the sites are all
  free ones: qwen, duck and gemini show "Free"; kimi and mistral show an
  upgrade prompt; deepai shows "Upgrade to DeepAI Pro"; chatgpt works without
  an account; deepseek's web chat has no paid tier. A payment form only
  appears if a human clicks Upgrade, which the bridge never does: it types a
  prompt and presses Enter.
- **openrouter is the exception:** it is pay-as-you-go. Its Activity page
  listed 13 requests, 29.6k tokens and **$0.01 spent** (blended about $0.24
  per million tokens): the chat's default model is a paid one and the bridge's
  test prompts used it. Since then the bridge refuses metered sites unless
  started with `--allow-paid` (see the Billing guard in the README). The page
  is a multi-model compare view with a first-run wizard, so it was not worth
  parsing the selected model.
- **Qwen Chat and Alibaba Cloud are separate services.** `chat.qwen.ai` is a
  free chat with no billing; an Alibaba Cloud bill comes from the cloud
  console (ECS, OSS, Model Studio / API keys, ...) and its own payment
  method. Whoever uses both should check the cloud console's billing page
  separately.

## Ideas to improve the chat-bridge

Collected during this sweep, most valuable first. The actionable ones are in
[TODO.md](TODO.md). **Decided by the user (2026-11-04) to be wanted: 1, 2, 3,
5, 6, 8, 9, 10, 11, 12, 13**, to be done one at a time, not as a batch;
4 and 7 were not chosen. Done so far: 1 (billing guard: `billing` class per site, `--allow-paid`,
Enter only with focus in the prompt box, payment page detection).

1. **Billing guard for openrouter.** Pick `:free` models only, or refuse a
   model whose price is not zero; read the model from the page before sending.
   Consider leaving it out of the default rotation of `--provider bridge`.
2. **Model selection per site** (`site/model`), since openrouter, duck and
   deepai host many models and the default matters for cost and speed.
3. **Tool call tolerance.** Accept flat arguments, strip copy-button text,
   retry once with a short "your call had no arguments" message.
4. **Tools for sites that ignore the preamble** (chatgpt, duck, deepai):
   either mark them `tools: false` and let ollama-repl avoid tool loops on
   them, or put the tool description in every prompt of a fresh chat, not
   only the first, in the system role where the site has one.
5. **Report capabilities in `/v1/models`** (`tools: true/false`, measured
   speed), so a client can prefer a site that can do tool calls when the task
   needs them, and so the repl's failover skips chat-only sites for tool
   work.
6. **Fix the replay problem** (gemini): a replayed transcript with tool
   results is read as instructions. Send a clear frame ("continue this
   conversation, answer the last message only") around the flattened
   transcript.
7. **Known start state per tab**: deepai mode, model pickers, "new chat"
   resets, so a fresh tab does not inherit an odd setting.
8. **A `check` command** that runs plain + tool probes per open site and
   prints a table like this one, to catch selector rot and quirks early.
9. **Measure and expose speed**: openrouter streams one chunk per second; a
   client with a timeout shorter than the site needs fails for no good reason.
   Per-site expected latency, and a per-request timeout override.
10. **Detect more refusals**: consent dialogs, captchas, "image mode"
    errors (deepai), and the site's own error strings, not only limit text.
11. **Per-site free-tier budgets**: count messages per site and warn before a
    known limit (mistral stopped after about 15), spread load across sites
    (the repl's rotation already does part of this).
12. **Housekeeping**: remove or tag chats the bridge creates so the sites'
    sidebars do not fill with test conversations (where a site offers delete),
    and sweep leftover bridge tabs after a crash.
13. **Honest usage numbers**: `usage` is always zero; estimate from lengths.
