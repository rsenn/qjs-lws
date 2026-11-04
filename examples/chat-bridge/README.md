# chat-bridge

`chat-bridge.js` drives a chatbot **web page in a real browser** over the
Chrome DevTools Protocol (CDP) and exposes it either on the command line or
as an **OpenAI-compatible HTTP endpoint**. Any OpenAI client, ollama-repl
included, can then use the free web tiers of DeepSeek, Qwen, Gemini, Kimi,
ChatGPT, Duck.ai, DeepAI, OpenRouter and Mistral as if they were an API.

It exists because those sites have no (free) API, only a chat page that is
logged in once in a browser. The bridge types into that page and reads the
answer back out of the DOM.

- [Usage](#usage)
- [Design](#design)
- [Specification](#specification)
- [Sites](#sites)
- [Install](#install)
- [Limits](#limits)
- [Backlog](#backlog)

Files: `chat-bridge.js` (the program), `README.md` (this document),
`TODO.md` (open work).

## Usage

    qjsm chat-bridge.js [options] serve            OpenAI-style server
    qjsm chat-bridge.js [options] send "prompt"    type, submit, print
    qjsm chat-bridge.js [options] read             print latest reply
    qjsm chat-bridge.js [options] eval "expr"      raw Runtime.evaluate
    qjsm chat-bridge.js list                       list page tabs

| option | default | meaning |
|---|---|---|
| `--site NAME` | first open | site for `send`/`read`/`eval` |
| `--port N` | 9222 | browser CDP port |
| `--host H` | 127.0.0.1 | browser CDP host |
| `--listen N` | 8089 | `serve`: HTTP port |
| `--max N` | 3 | `serve`: chat tabs per site |
| `--idle SEC` | 2.5 | reply unchanged this long = finished |
| `--timeout SEC` | 180 | give up waiting for a reply |

Prerequisite: a browser with a dedicated profile, logged in once to the
sites you want, started with remote debugging:

    google-chrome --remote-debugging-port=9222 \
      --user-data-dir=$HOME/.chat-bridge-profile \
      https://chat.deepseek.com https://chat.qwen.ai

From ollama-repl:

    qjsm chat-bridge.js serve
    OPENAI_API_URL=http://127.0.0.1:8089/v1 OPENAI_API_KEY=x \
      qjsm ../ollama-repl/repl.js --provider openai --model deepseek

The **model name selects the site** (`deepseek`, `qwen`, ...): the first
site whose name the model string contains.

## Design

### Principles

- **Real browser, real session.** No scraping of private endpoints, no
  credentials handled: the browser already holds the login.
- **Loopback only.** The endpoint types into logged-in sessions, so `serve`
  binds `127.0.0.1` and has no authentication.
- **Never steal focus.** Tabs the bridge opens are background tabs, text is
  entered with `Input.insertText` and submitted with a real Enter key event
  dispatched over CDP; the user's own tabs and keyboard focus are left alone.
- **Own your tabs.** `serve` opens up to `--max` tabs per site and closes
  them again on SIGINT/SIGTERM. It never reuses or closes tabs it did not
  create (`send`/`read`/`eval` are the exception: they attach to an
  existing tab of the site).

### Components

| piece | role |
|---|---|
| `CDP` | one WebSocket to a tab or to the browser, request/response by `id`, `eval()` helper over `Runtime.evaluate` |
| `SITES` / `ACTIVE` | per-site table (host, home URL, input selector, reply selector); `ACTIVE` is `SITES` without entries that carry a `skip` reason |
| `Chat` | one browser tab: its CDP session, the `history` it is known to hold, `busy` flag, a promise chain that serializes asks |
| `Bridge` | the tab pool per site, tab discovery over `/json`, `acquire()`/`release()` |
| `planPrompt()` | decides between "send only the new turn" and "replay the transcript" |
| `toolPreamble()` / `extractCalls()` | tool calling emulation |
| `completions()` | the `/v1/chat/completions` handler |

### Request flow

    client ──POST /v1/chat/completions──▶ completions()
        pick site from `model`
        Bridge.acquire(site, messages)   ── tab holding this history,
                                            else an idle tab,
                                            else a new tab (≤ --max),
                                            else wait for a release
        planPrompt()                     ── continue or fresh
        Chat.ask(prompt)                 ── type, Enter, poll the DOM
        ◀── JSON or SSE ──
        Bridge.release()

### Context handling

OpenAI clients send the **whole message history with every request**. The
bridge keeps, per tab, the exact message list the open chat holds
(`chat.history`, including the assistant reply it just produced).

- **Continuation:** if the request minus its last user turn equals a free
  tab's history, line for line, the request goes to that tab and only the new
  user turn is typed. The site's own conversation carries on.
- **New context:** otherwise an idle tab is reset (`newChat()` navigates to
  the site's home page, only if the tab is dirty) and the entire transcript is
  flattened into one prompt (`System: … User: … Assistant:`).
- A new context therefore needs no signal from the client: `/clear`, an edited
  or rewound history, a different conversation, all simply fail to match.
- After an error the tab's history is cleared, so the next request replays
  the transcript instead of trusting a half-sent state.

### Reply detection

The reply text is read by querying the site's `reply` selector and taking the
**last** match. A reply is *new* when the match count grew or its text
differs from before the send. It is *finished* when the text stayed unchanged
for `--idle` seconds. There is no portable "generation done" signal across
sites, hence the idle timer.

### Streaming

`stream: true` yields an SSE chunk each time the reply text grows, but only
for **append-only** growth. A rewrite of earlier text (some sites re-render
markdown) waits until the text is append-only again.

### Tool calling (emulated)

Web chats have no tool API. For a request with `tools`:

1. On a fresh chat the first prompt is prefixed with `toolPreamble()`: the
   tools are described and the model is told to answer a call with only a
   fenced `tool_call` JSON block.
2. Tool results come back as `role: tool` messages and are flattened to
   `[tool result]` lines; earlier assistant tool calls are re-rendered as the
   same fenced blocks, so the model sees a consistent transcript.
3. The reply is scanned by `extractCalls()` for top-level
   `{"name":…, "arguments":…}` objects whose name is a declared tool, however
   the page decorated them. Matches become `tool_calls` and
   `finish_reason: "tool_calls"`.
4. Calls can only be told apart once the reply is complete, so a request
   **with tools is answered whole even when streaming was asked**.

### Refusals

While waiting for a reply the bridge also watches the page. It reports, as
OpenAI-style errors with a `Retry-After` header where a time is known:

| situation | status / `error.code` | how it is detected |
|---|---|---|
| quota or rate limit used up | 429 `rate_limit_exceeded` | new page text (not there before the send, not part of the prompt) matches `LIMIT_RE`; reset time parsed from "in 3 Stunden" style text, else 15 min |
| login wanted | 401 `login_required` | the tab moved to a login/auth path |
| prompt never taken | 502 `prompt_not_accepted` | the input did not empty after four Enter presses |

The unsent prompt is cleared from the input box. A site that refused is put
on **cooldown** for the `Retry-After` time: later requests for it fail at
once, without touching the browser. For `stream: true` the status is
returned before any chunk, so a client sees a real HTTP error.
ollama-repl uses this to fail over to another model.

## Specification

### HTTP endpoints

| method, path | behaviour |
|---|---|
| `GET /v1/models` | one entry per active site, `owned_by: "chat-bridge"`, plus `available` (false while on cooldown) and, then, `unavailable` (kind) and `resets_at` |
| `POST /v1/chat/completions` | OpenAI chat completion; `messages`, `model`, `stream`, `tools` are honoured |

Everything else returns 404. Fields that are accepted and ignored:
`temperature`, `max_tokens`, `stop`, `top_p`, `response_format`, … (a web
chat offers no such knobs). `usage` is always zero.

Errors: bad JSON → 400, no messages → 400, tab/site problems → 502, no reply
before `--timeout` → 504, site refusals as in [Refusals](#refusals).

### Site table entry

    name: {
      host,   // hostname of the chat page, used to match open tabs
      home,   // URL that opens a fresh chat
      input,  // selector of the prompt box (first visible match)
      reply,  // selector of the assistant messages (last match is read)
      skip,   // optional: why the site was looked at and not adopted
    }

`input` is waited for (up to 20 s) before typing; "input field not found,
selector outdated?" means the site changed its markup. An input that has
emptied again is how the bridge knows the page took the prompt: Enter is
repeated up to four times until it does.

### Concurrency

One prompt at a time per tab (a promise chain per `Chat`); parallel requests
use parallel tabs up to `--max` per site, extra requests wait for a release.

## Sites

Status as of 2026-11. "verified" = a prompt/reply round trip through `serve`.

| site | status | notes |
|---|---|---|
| deepseek | verified | plain, streaming, tool calls |
| qwen | verified | plain |
| gemini | verified | plain |
| kimi | verified | EU users: `www.kimi.ai/chat` (not `kimi.com`) |
| chatgpt | verified, logged out layout | logged-in layout not tested; input `#prompt-textarea, #mobile-composer-prompt` |
| duck | verified | needs the terms dialog accepted once by the user |
| deepai | verified | |
| openrouter | verified | |
| mistral | verified (plain, multi-turn, streaming, tools) | free tier has a message limit; concurrency and a long stream untested because the limit was hit |
| venice | skipped | no reply read in a test (anonymous use is rate-limited and gated) |
| aistudio | skipped | free Gemini API key exists, and gemini is already covered |
| groq | skipped | API playground behind a login, not a chat; groq has an OpenAI-compatible API |

`mistral.ai/products/vibe` was also considered: it is a product page for a
coding CLI, not a chat, so it has no entry.

To add a site: open it logged in, find the prompt box and the element that
holds one assistant reply (`eval` is made for this), add a `SITES` entry,
then check plain, multi-turn, streaming and a tool request through `serve`.
Prefer stable attributes (`data-*`, utility classes) over hashed class names.

## Install

`cmake --install` puts it in `bin/` as `chat-bridge`. The build copies
`examples/chat-bridge.js` with the in-repo `../lib/` import prefix stripped
(`cmake/subst-lib-imports.cmake`), so the imports resolve as bare module
names from the QuickJS module dir.

## Limits

- Needs a running, logged-in browser; sites change their markup without
  notice, so selectors rot.
- Free tiers have their own message limits, captchas, consent dialogs and
  terms pages. The bridge does not click through any of them on purpose.
- Replay of a long transcript into a fresh chat is one big text prompt: it
  costs the site's context and quota.
- Context matching is exact; a client that rewrites old messages
  (compaction, edited system prompt) triggers a replay every time.
- No token accounting, no sampling parameters.
- Use only with accounts and services whose terms allow automated use.

## Backlog

Open work is tracked in [TODO.md](TODO.md); bugs in `BUGS` at the repo root.
