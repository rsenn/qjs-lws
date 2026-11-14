# Models for ollama-repl

What was tested and what is only a candidate. Status as of 2026-10-20. Anything
marked *unverified* comes from third-party blog posts (see Sources), not from a
run here - check the provider's own page before relying on it.

Benchmark task: "add a 1-2 line documentation comment in front of every
function declaration in lib/path.h, inferring its purpose from
lib/path/<function-name>.c" (25 declarations, a copy of ~/Sources/shish).
Details and the harness changes that came out of it are in `TODO.md`.

## Tested

| Model | Provider | Result on the benchmark | Notes |
|---|---|---|---|
| `qwen3.5:4b` | ollama | 25/25, ~115 s (2 runs; one run duplicated a declaration line) | Best local model so far. Native tool calls work. |
| `qwen2.5-coder` (7.6B) | ollama | 17-20/25, ~100-140 s (5 runs), nothing lost or duplicated | Writes tool calls as text instead of `tool_calls`; needs `lib/text-tool-calls.js`, the nudges and the retry. |
| `gemini-3.5-flash` | gemini | tool loop works (needs the `thoughtSignature` fix) | Free tier quota exhausted during testing (see below). |
| `gemini-3.5-flash-lite` | gemini | 0/25: 503 "high demand" outlasted all retries | Answered a trivial request, so it exists and has quota. |

## Ollama candidates (8 GB VRAM, 32 GB RAM) - not tried yet

Up to about 9B parameters fits entirely in the 8 GB of VRAM. Larger models
run partly offloaded to system RAM (slower). Raising `--num-ctx` costs VRAM:
the default here is 16384; one source recommends 64k for agent tools, which
on this card means more CPU offload.

| Model | Size | Why | Caveat |
|---|---|---|---|
| `qwen3.5:9b` | ~6.6 GB | Bigger sibling of the 4B that scored 25/25; fits in VRAM | One guide lists an open Qwen3.5 tool-call parser issue - test it |
| `gemma4:e4b` | small | Reported to have built-in tool calling and vision, released April 2026 | *unverified* tag |
| `qwen2.5-coder:7b` | ~5 GB | Already tested (the default `qwen2.5-coder` build is 7.6B) | Text tool calls |
| `gpt-oss:20b` | ~14 GB | MoE, few active parameters, so usable with RAM offload | partly offloaded |
| `qwen3-coder:30b` | ~19 GB? | MoE, ~3.3B active parameters | *unverified* tag and size; needs offload |
| `devstral-small:24b` | ~14 GB+ | Described as a strong agentic coder | dense 24B: slow on this card |

Not realistic here: Qwen3.6-27B and similar (wants a 24 GB GPU).

`ollama list` shows what is installed; `ollama show <model>` lists its
capabilities (look for `tools`).

## Gemini

`ollama-repl --provider gemini --model list` prints the chat-capable models
the key can use (needs `GEMINI_API_KEY`; the key file `~/.gemini-api-key`
holds an `export` line, so `source` it).

Findings with a free-tier key:

- Hard quota of **20 generate requests per model per day**
  ("limit: 20, model: gemini-3.6-flash"); `gemini-3.5-flash` shares the
  `gemini-3.6-flash` bucket. A `for_each` over 25 items needs 50+ requests,
  so it cannot finish on a free flash model.
- `gemini-3.1-pro*`: limit 0 on a free key. `gemini-2.5-*`: 404 "no longer
  available to new users".
- "High demand" 503s and very slow answers on the newest flash models
  (one-line request: 115 s on `gemini-3.8-flash`, 92 s on `gemini-3.7-flash`).
  `GeminiClient` retries 429/5xx with backoff (3, 6, 12, 24, 40 s).
- `thinkingConfig.thinkingLevel`: `"low"` is accepted by `gemini-3.8-flash`,
  `"minimal"` is not. Not wired into the client yet.
- Not for coding: the `*-tts`, `*-image`, `nano-banana*`, `lyria*`,
  `*-transcribe`, `robotics`, `computer-use`, `omni`, `deep-research` and
  `antigravity` entries. `gemma-4-*` are open models, probably weaker at tool
  calling. `gemini-4-argon` is an unknown codename with a 32k output limit.
- Coding picks, by name and version only (not benchmarked): quality
  `gemini-3.1-pro-preview` (and `-customtools`, tuned for function calling;
  needs a paid key), day to day `gemini-3.8-flash`, cheap/fast
  `gemini-3.5-flash-lite` / `gemini-3.1-flash-lite`.

## Other free API tiers (*unverified*)

`--provider openai` talks to any OpenAI-compatible endpoint; today the base
URL is set with the `OPENAI_API_URL` environment variable (and the key with
`OPENAI_API_KEY`). Untested with this harness.

| Provider | Free tier (per recent third-party sources) |
|---|---|
| Groq | ~30 requests/min, 1,000/day, 200k tokens/day per model; no card; Llama reportedly removed from free, gpt-oss and Qwen models remain |
| OpenRouter | ~19 `:free` models; 20 requests/min, 50/day (1,000/day after a $10 purchase) |
| Mistral | ~$10/month free credit, ~1 request/s; Codestral listed; older pages mention opting into data training |
| Cerebras | conflicting: ~1M tokens/day on older pages, a $5 trial needing a card on a newer one |
| GitHub Models | reportedly retired 2026-07-30 (one source) |
| Codex / Copilot | subscription products, no public chat-completion endpoint to point this harness at |

A 20-50 requests/day tier cannot run the `for_each` benchmark; Groq-sized
limits or packing several items per request would be needed.

## Sources

- <https://openrouter.ai/blog/tutorials/free-llm-apis-compared/>
- <https://wetheflywheel.com/en/ai-model-access/free-llm-api-tiers-2026/>
- <https://opengpuradar.com/free-llm-apis>
- <https://github.com/mnfst/awesome-free-llm-apis>
- <https://klymentiev.com/blog/free-llm-api>
- <https://www.agenticwire.news/article/best-ollama-model-for-coding>
- <https://localaimaster.com/vram/best-coding-llm-8gb-vram>
- <https://localaimaster.com/vram/best-ollama-models-8gb-vram>
- <https://toolhalla.ai/blog/best-local-llms-for-coding-2026>
- <https://www.benchlm.ai/best/ollama-models>
