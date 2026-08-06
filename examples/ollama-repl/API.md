# Message/tool-use format rewrite

## Problem

`GeminiClient#chat()`/`#chatStream()` (`lib/gemini-client.js`) took the same
flat `[{ role: 'system'|'user'|'assistant', content: string }, ...]` array
`OllamaClient` (`lib/ollama-client.js`) takes, and converted it into Gemini's
`contents`/`systemInstruction` shape internally (`#toContents()`). That array
is really *Ollama's* wire shape, not a neutral one - it has no room for
anything Gemini (or Ollama itself, for that matter) can do beyond plain text
turns, tool/function calling above all. Forcing Gemini through it meant the
client could never expose tool use to a caller even though the underlying
API supports it.

## Research: what each API actually offers for tool use

### Gemini `generateContent`/`streamGenerateContent`
(https://ai.google.dev/api/generate-content - the endpoint this project's
`GeminiClient` already talks to; Google's newer "Interactions API" docs
were checked too but describe a different, non-`contents[]` endpoint this
client doesn't use, so they're not the reference here.)

- `Content.role` is only ever `"user"` or `"model"` - there is no third
  `"function"`/`"tool"` role. A function's *result* is sent back as a
  `"user"`-role turn whose part is a `functionResponse`, not a special role.
- `Content.parts[]` entries relevant here:
  - `{ text: string }`
  - `{ functionCall: { name: string, args: object } }` - appears in a
    **model**-role turn (the model's reply asking for a call). No call id
    in this shape.
  - `{ functionResponse: { name: string, response: object } }` - appears in
    a **user**-role turn (the app's reply). `response` must be an object,
    not a bare string/number.
- Request-level `tools: [{ functionDeclarations: [{ name, description,
  parameters }] }]` - `parameters` is an OpenAPI-subset JSON Schema object,
  same shape `properties`/`required`/`type` as JSON Schema.
- `toolConfig: { functionCallingConfig: { mode: 'AUTO'|'ANY'|'NONE',
  allowedFunctionNames?: string[] } }` - `AUTO` (default) lets the model
  choose, `ANY` forces a call, `NONE` disables calling for that request.
- A response candidate's `content.parts[]` can mix `text` and
  `functionCall` parts in the same turn.
- Streaming (`streamGenerateContent?alt=sse`) sends whole parts per SSE
  event - a `functionCall` part arrives complete in one event, it isn't
  streamed token-by-token the way `text` is.

### Ollama `/api/chat`
(https://github.com/ollama/ollama/blob/main/docs/api.md)

- `tools: [{ type: 'function', function: { name, description, parameters
  } }]` - same `{name, description, parameters}` triple as Gemini's
  `functionDeclarations` entries, just wrapped one level deeper.
- A tool-calling reply comes back as `message.tool_calls: [{ function:
  { name, arguments } }]` (note: `arguments`, not `args`; also no call id).
- A tool result is sent back as its own message: `{ role: 'tool', content:
  string, tool_name: string }` - unlike Gemini, Ollama *does* have a real
  `tool` role.
- No `tool_choice`/forced-call knob in the documented schema - Ollama
  always behaves like Gemini's `AUTO` mode.
- Streaming: `tool_calls` can appear on an intermediate NDJSON chunk before
  the final one, same "arrives whole, not token-by-token" behavior as
  Gemini's `functionCall` parts.

### The common shape

Both APIs want the same `{ name, description, parameters }` triple for
declaring a tool, and neither one gives a call id - a call is identified by
its `name` alone (documented limitation: neither provider lets a client
disambiguate two parallel calls to the *same* tool name in one turn). That's
enough overlap for one caller-facing message format, converted natively by
each client into its own wire shape - no shared converter, no
translate-through-Ollama step.

## Design: extended message format

Callers keep building a plain array, just with two more optional message
shapes layered onto the existing `{ role, content }` one:

```js
// plain turn (unchanged)
{ role: 'system' | 'user' | 'assistant', content: string }

// assistant turn requesting one or more tool calls
{ role: 'assistant', content?: string, toolCalls: [{ id, name, args }] }

// the app's reply with a tool's result
{ role: 'tool', name: string, content: string | object, toolCallId?: string }
```

- `toolCalls[].id` is synthesized by the client when it parses a response
  (`` `${name}#${index}` ``) purely as a local handle for matching a call to
  the `tool` message that answers it in *your* code - it is never sent over
  either wire protocol, since neither API has anywhere to put it.
- `tool` message `content` may be a plain string (the common case) or an
  object; `GeminiClient` wraps a string as `{ result: content }` to satisfy
  `functionResponse.response`'s object requirement, `OllamaClient`
  stringifies an object (`JSON.stringify`) since Ollama's `tool_name`
  message wants a plain string `content`.

`chat()`/`chatStream()` grow two new options, both optional and additive -
existing plain-text calls are unaffected:

- `tools: [{ name, description, parameters }]` - `parameters` is a JSON
  Schema object, passed straight through to whichever wire shape the
  client needs.
- `toolChoice: 'auto' | 'any' | 'none'` - maps to Gemini's
  `toolConfig.functionCallingConfig.mode`; `OllamaClient` accepts and
  silently ignores it (documented in its own comment - the Ollama API has
  no equivalent).

And the return value of both methods changes from a bare `string` to:

```js
{ content: string, toolCalls?: [{ id, name, args }] }
```

`toolCalls` is only present when the model actually asked for a call;
plain replies still just have `content`. `chatStream()`'s `onToken`
callback is unchanged (fires per text token only - tool calls aren't
streamed piecemeal by either API, so they're only visible in the final
returned object, same as a non-streamed `chat()` call).

## What's explicitly out of scope here

- Multimodal parts (`inlineData`/`fileData` - images, audio, PDFs). Gemini
  supports them, Ollama's `/api/chat` has separate image handling that
  doesn't share this shape; not needed for this project's text-only,
  file-attachment-via-prompt-text workflow. Noted here as the natural next
  extension point (another optional message field, e.g. `parts: [...]`)
  if it's ever needed.
- Wiring real tool-calling into `repl.js`'s automatic `LIST:`/`READ:`/
  `RUN:` loop (`lib/tool-requests.js`, `runToolLoop()`). That loop is a
  plain-text protocol parsed out of the reply body, independent of either
  API's native tool-calling - replacing or complementing it with real
  `tools`/`toolCalls` is a bigger, separate change (system prompt rewrite,
  round-trip loop rewrite, `--provider`-specific behavior since only
  `GeminiClient` enforces `toolChoice`). This rewrite only makes the
  *client* API capable of it; see `TODO.md` for that as a follow-up.
- A call id that round-trips through the wire protocol - not possible,
  neither API has one.

## Manual REPL usage

Both clients can be driven by hand from a `qjsm` REPL (see `TODO.md` item 1
for the still-missing in-chat `ASK:`-style version of this same idea).
Plain text, no tools:

```js
import { OllamaClient } from './lib/ollama-client.js';

const client = new OllamaClient({ model: 'qwen2.5-coder' });
const { content } = await client.chat([{ role: 'user', content: 'hi' }]);
console.log(content);
```

Tool use, one round trip, either client - same message shapes, same
return shape:

```js
import { GeminiClient } from './lib/gemini-client.js';

const client = new GeminiClient({});

const tools = [{
  name: 'get_weather',
  description: 'Get the current weather for a city',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
}];

const messages = [{ role: 'user', content: 'What\'s the weather in Zurich?' }];

let { content, toolCalls } = await client.chat(messages, { tools });

while(toolCalls) {
  messages.push({ role: 'assistant', content, toolCalls });

  for(const { name, args } of toolCalls) {
    // however you actually implement the tool:
    const result = name === 'get_weather' ? `${args.city}: 21C, sunny` : `unknown tool ${name}`;
    messages.push({ role: 'tool', name, content: result });
  }

  ({ content, toolCalls } = await client.chat(messages, { tools }));
}

console.log(content);
```

Same loop works unchanged against `OllamaClient` (with a tool-capable
model, e.g. `qwen2.5-coder`) - just swap the constructor and drop
`toolChoice` if you were relying on it, since only Gemini honors it:

```js
import { OllamaClient } from './lib/ollama-client.js';
const client = new OllamaClient({ model: 'qwen2.5-coder' });
// ... identical messages/tools/loop as above
```

Forcing a call (Gemini only) or streaming both work the same way `chat()`
does above, just with the extra option / callback:

```js
const { content, toolCalls } = await client.chat(messages, { tools, toolChoice: 'any' });

const { content, toolCalls } = await client.chatStream(messages, { tools }, token => stdout.puts(token));
```
