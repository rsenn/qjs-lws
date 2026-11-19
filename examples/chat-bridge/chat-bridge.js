#!/usr/bin/env qjsm
/**
 * chat-bridge - drive a chatbot web page in a real browser over CDP, from
 * the command line or as an OpenAI-compatible HTTP endpoint.
 *
 * Usage: qjsm chat-bridge.js [options] serve            OpenAI-style server
 *        qjsm chat-bridge.js [options] send "prompt"    type, submit, print
 *        qjsm chat-bridge.js [options] read             print latest reply
 *        qjsm chat-bridge.js [options] eval "expr"      raw Runtime.evaluate
 *        qjsm chat-bridge.js list                       list page tabs
 *
 * Options: --site NAME (deepseek|qwen|gemini|kimi|chatgpt|duck|deepai|openrouter|mistral, default: first open)
 *   --port N (CDP, 9222)  --host H (CDP, 127.0.0.1)  --listen N (serve,
 *   8089, 0 = any free port)  --max N (serve: chat tabs per site, 3)  --idle SEC (reply
 *   unchanged this long = done, 2.5)  --timeout SEC (180)
 *   --allow-paid (serve: also use pay-as-you-go sites such as openrouter,
 *   refused by default; or CHAT_BRIDGE_ALLOW_PAID=1)
 *   --new-tabs (serve: always create tabs with Target.createTarget; by default
 *   blank tabs that are already open are navigated first, because some
 *   browsers open a new window for a created target)
 *
 * Prerequisites: a browser with a dedicated profile, logged in once:
 *   google-chrome --remote-debugging-port=9222 \
 *     --user-data-dir=$HOME/.chat-bridge-profile \
 *     https://chat.deepseek.com https://chat.qwen.ai
 *
 * Use it from ollama-repl:
 *   qjsm chat-bridge.js serve
 *   OPENAI_API_URL=http://127.0.0.1:8089/v1 OPENAI_API_KEY=x \
 *     qjsm ../ollama-repl/repl.js --provider openai --model deepseek
 *
 * The model name selects the site. serve opens up to --max background
 * tabs per site in the browser's window, one conversation each, so
 * several clients can chat at once; the tabs are closed again on exit. A
 * request that extends the history of a tab's chat goes to that tab and
 * sends only the new turn, otherwise an idle tab is reset to a fresh chat
 * and gets the whole transcript flattened into one prompt. Text is
 * entered with Input.insertText and submitted with a real Enter key
 * event; tabs are never raised, so your own tab and keyboard focus are
 * left alone. Tool
 * calling is emulated, web chats have none: the tools are
 * described in the first prompt and JSON calls in the reply are turned
 * back into tool_calls (see toolPreamble).
 */
import { fetch } from '../../lib/fetch.js';
import { serve, Response } from '../../lib/serve.js';
import { WebSocketStream } from '../../lib/websocketstream.js';
import { ReadableStream } from '../../lib/lws/streams.js';
import { URL } from '../../lib/lws/url.js';
import { extractCalls } from './tool-calls.js';
import { TextDecoder } from 'textcode';
import { setTimeout, signal, SIGINT, SIGTERM, mkdir, rename } from 'os';
import { getenv, exit, loadFile, open as fopen } from 'std';

/* selectors verified live (2026-11) for deepseek, qwen, gemini, kimi,
   chatgpt (logged out layout), duck, deepai and openrouter. mistral too (answer part). 
   unverified guess: its chat redirects to a login in the test browser.
   a `skip` reason marks a site that was looked at and deliberately not
   adopted (see ACTIVE below). input = prompt box, reply = assistant messages (the
   last one is read) */
const SITES = {
  deepseek: { name: 'DeepSeek', rank: 1, host: 'chat.deepseek.com', home: 'https://chat.deepseek.com/', input: 'textarea', reply: '.ds-markdown', context: null, capabilities: { tools: true, vision: false, reasoning: false, stream: true } },
  qwen: { name: 'Qwen', rank: 2, host: 'chat.qwen.ai', home: 'https://chat.qwen.ai/', input: 'textarea.message-input-textarea, textarea', reply: '.qwen-markdown', context: null, capabilities: { tools: true, vision: false, reasoning: false, stream: true } },
  gemini: { name: 'Gemini', rank: 3, host: 'gemini.google.com', home: 'https://gemini.google.com/app', input: 'rich-textarea .ql-editor, div[contenteditable="true"]', reply: 'message-content, .model-response-text', context: null, capabilities: { tools: true, vision: true, reasoning: false, stream: true } },
  kimi: { name: 'Kimi', rank: 4, host: 'www.kimi.ai', home: 'https://www.kimi.ai/chat/', input: 'div[contenteditable="true"], textarea', reply: '.markdown', context: null, capabilities: { tools: true, vision: false, reasoning: false, stream: true } },
  mistral: { name: 'Mistral', rank: 5, host: 'chat.mistral.ai', home: 'https://chat.mistral.ai/chat', input: 'textarea, div[contenteditable="true"]', reply: '[data-message-part-type="answer"]', context: null, capabilities: { tools: true, vision: false, reasoning: false, stream: true } },
  chatgpt: { name: 'ChatGPT', rank: 6, host: 'chatgpt.com', home: 'https://chatgpt.com/', input: '#prompt-textarea, #mobile-composer-prompt, div.ProseMirror[contenteditable="true"]', reply: '[data-message-author-role="assistant"], li[data-message-role="assistant"], [data-markdown-text-style="assistant-message"]', context: null, capabilities: { tools: false, vision: false, reasoning: false, stream: true } },
  venice: { host: 'venice.ai', home: 'https://venice.ai/chat', input: 'textarea', reply: '.prose', skip: 'no reply read in a test (anonymous use is rate-limited and gated), so not worth the fragility' },
  duck: { name: 'Duck', rank: 8, host: 'duck.ai', home: 'https://duck.ai/chat', maxPrompt: 16000, input: 'textarea', reply: 'div.space-y-4.whitespace-normal', context: Math.floor(16000/3.5), capabilities: { tools: false, vision: false, reasoning: false, stream: true } },
  deepai: { name: 'DeepAI', rank: 9, host: 'deepai.org', home: 'https://deepai.org/chat', input: '#persistentChatbox', reply: '.markdownContainer', context: null, capabilities: { tools: false, vision: false, reasoning: false, stream: true } },
  openrouter: { name: 'OpenRouter', rank: 7, host: 'openrouter.ai', home: 'https://openrouter.ai/chat', input: 'textarea', reply: '[data-message-bubble="assistant"]', billing: 'metered', context: null, capabilities: { tools: true, vision: false, reasoning: false, stream: true } },
  aistudio: { host: 'aistudio.google.com', home: 'https://aistudio.google.com/prompts/new_chat', input: 'textarea', reply: 'ms-text-chunk', billing: 'metered', skip: 'free Gemini API key exists, and gemini is already covered by the gemini site' },
  groq: { host: 'console.groq.com', home: 'https://console.groq.com/playground', input: 'textarea', reply: '.prose', billing: 'metered', skip: 'API playground behind a login, not a chat, and groq has an OpenAI-compatible API' },
};

/* extra sites (tests, private deployments): $CHAT_BRIDGE_SITES names a JSON
   file { name: { host, home, input, reply, ... } } merged over SITES (with
   "$replace": true they replace the built-in sites) */
if(getenv('CHAT_BRIDGE_SITES')) {
  const extra = JSON.parse(loadFile(getenv('CHAT_BRIDGE_SITES')) ?? '{}');
  /* "$replace": true drops the built-in sites first (a test that must not route to a real one) */
  if(extra.$replace) for(const k of Object.keys(SITES)) delete SITES[k];
  delete extra.$replace;
  Object.assign(SITES, extra);
}

/* every site has a billing class, default 'free': a consumer chat that can
   only cost money if a human clicks Upgrade (the bridge never clicks
   anything but the prompt box). 'metered' = pay-as-you-go credits or an
   API-style account that charges by use: refused unless the bridge was
   started with --allow-paid (or CHAT_BRIDGE_ALLOW_PAID=1) */
/* sites with a `skip` reason were looked at and deliberately not adopted:
   kept here so they are not evaluated again, but never served or matched */
const ACTIVE = Object.fromEntries(Object.entries(SITES).filter(([, s]) => !s.skip));

/* the request's `model`: a site name, or `site/model` (split at the first slash: openrouter/anthropic/claude-sonnet-4
   is site openrouter, model anthropic/claude-sonnet-4). A name that is no site is not guessed from a substring.
   Returns { site, pick } (pick null = the site's default), or { error } with the HTTP status and message */
function resolveModel(model) {
  const names = Object.keys(ACTIVE);
  const i = model.indexOf('/');
  const site = ACTIVE[model] ? model : i > 0 && ACTIVE[model.slice(0, i)] ? model.slice(0, i) : null;
  if(!site) return { error: { status: 404, code: 'model_not_found', message: `unknown model "${model}", use auto, a site (${names.join(', ')}) or site/model` } };

  const pick = site == model ? null : model.slice(i + 1) || null;
  if(pick && !ACTIVE[site].pick) return { error: { status: 400, code: 'model_selection_unsupported', message: `${site} has no model selection, use the plain name "${site}"` } };
  return { site, pick };
}

/* a site that will not answer: kind is rate_limit, login or not_accepted.
   `retry` = seconds until it is worth trying again */
class SiteRefusal extends Error {
  constructor(kind, message, retry) {
    super(message);
    this.kind = kind;
    this.retry = retry;
  }
}

const REFUSALS = {
  rate_limit: { status: 429, type: 'rate_limit_error', code: 'rate_limit_exceeded' },
  login: { status: 401, type: 'authentication_error', code: 'login_required' },
  not_accepted: { status: 502, type: 'api_error', code: 'prompt_not_accepted' },
  /* the billing guard: see `billing` in SITES */
  billing: { status: 402, type: 'billing_error', code: 'paid_site_blocked' },
  payment_page: { status: 402, type: 'billing_error', code: 'payment_page_reached' },
};

/* a path the site would only send a tab to for a purchase */
const PAY_RE = /\/(checkout|billing|pricing|subscribe|subscription|upgrade|payment|purchase|plans?)(\/|$|\?)/i;

/* new page text that says the quota is used up (de/en) */
const LIMIT_RE = /(message|nachrichten|usage|request|anfrage|daily|tages|free)[\s-]*(limit|quota|kontingent)|limit[\s\w]{0,20}(reached|erreicht|exceeded|überschritten)|(reached|erreicht|exceeded)[\s\w]{0,30}limit|too many (requests|messages)|zu viele (anfragen|nachrichten)|rate[\s-]?limit|quota (exceeded|exhausted)|out of (free )?(messages|credits)/i;
const LOGIN_RE = /\/(log-?in|sign-?in|sign-?up|auth|authenticate|authorize)\b/i;

/* "in 3 Stunden", "in 45 minutes", "after 2 days" -> seconds, else undefined */
function parseReset(text) {
  const m = /(\d+)\s*(hours?|stunden?|std|h|minutes?|minuten?|min|days?|tage?n?)\b/i.exec(text);
  if(!m) return undefined;
  const unit = m[2].toLowerCase();
  return +m[1] * (/^(h|std|hour|stund)/.test(unit) ? 3600 : /^(d|tag)/.test(unit) ? 86400 : 60);
}

/* a tab that holds nothing of the user's: the bridge may use it */
const BLANK_RE = /^(about:blank|chrome:\/\/(newtab|new-tab-page)\/?|edge:\/\/newtab\/?|brave:\/\/newtab\/?)/;

/* what `check` sends: short, one word back */
const CHECK_PROMPT = 'Reply with the single word: pong';

const sleep = ms => new Promise(r => setTimeout(r, ms));

class CDP {
  #id = 0;
  #pending = new Map();
  #writer;

  async open(wsUrl) {
    const { readable, writable } = await new WebSocketStream(wsUrl).opened;
    this.#writer = writable.getWriter();
    this.#read(readable);
  }

  async #read(readable) {
    const reader = readable.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for(;;) {
      const { done, value } = await reader.read();
      if(done) break;
      buf += typeof value == 'string' ? value : dec.decode(value, { stream: true });
      try {
        var msg = JSON.parse(buf);
      } catch(e) {
        continue; /* incomplete frame, keep buffering */
      }
      buf = '';
      const p = this.#pending.get(msg.id);
      if(!p) continue;
      this.#pending.delete(msg.id);
      if(msg.error) p.reject(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
    }
    for(const p of this.#pending.values()) p.reject(new Error('CDP connection closed'));
    this.closed = true;
  }

  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#writer.write(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if(r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
}

/* one Chat per browser tab: owns the CDP session and serializes asks */
class Chat {
  history = []; /* messages known to be in the open chat */
  dirty = false; /* anything typed since the page was loaded */
  model = null; /* the model picked on the site (site/model), null = the site's default */
  stopped = false; /* set by interrupt(): the running ask() returns at its next poll */
  busy = false;
  #tail = Promise.resolve();

  constructor(site, cdp, opts) {
    this.site = site;
    this.cdp = cdp;
    this.opts = opts;
  }

  readReply() {
    return this.cdp.eval(`(() => { const n = [...document.querySelectorAll(${JSON.stringify(this.site.reply)})];
      const last = n[n.length - 1]; if(!last) return { count: 0, text: '' };
      /* innerText loses the code fences (and keeps the copy-button labels
         of a code block): put the fences back from the <pre> elements */
      let text = last.innerText;
      for(const pre of last.querySelectorAll('pre')) {
        const code = pre.querySelector('code'), raw = pre.innerText, at = text.indexOf(raw);
        if(at < 0) continue;
        const lang = ((code ?? pre).className.match(/language-([\\w+-]+)/) ?? [])[1] ?? '';
        text = text.slice(0, at) + '\\x60\\x60\\x60' + lang + '\\n' + (code ?? pre).innerText.replace(/\\n$/, '') + '\\n\\x60\\x60\\x60' + text.slice(at + raw.length);
      }
      return { count: n.length, text }; })()`);
  }

  /* a page in the middle of a navigation has no body (or no execution
     context yet): that is an empty state, not an error */
  pageState() {
    return this.cdp
      .eval(`({ href: location.href, lines: (document.body?.innerText ?? '').split('\\n').map(l => l.trim()).filter(Boolean) })`)
      .catch(() => ({ href: '', lines: [] }));
  }

  /* remove an unsent prompt, so it does not pile up in front of the next one */
  clearInput() {
    return this.cdp.eval(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(this.site.input)})].find(e => e.offsetParent);
      if(e) { e.focus(); document.execCommand('selectAll'); document.execCommand('delete'); } })()`).catch(() => {});
  }

  async waitInput(ms = 20000) {
    const sel = JSON.stringify(this.site.input);
    for(const end = Date.now() + ms; Date.now() < end; await sleep(300))
      if(await this.cdp.eval(`!![...document.querySelectorAll(${sel})].find(e => e.offsetParent)`).catch(() => false)) return; /* false while navigating */
    throw new Error('input field not found, selector outdated? (try: eval)');
  }

  inputEmpty() {
    return this.cdp.eval(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(this.site.input)})].find(e => e.offsetParent);
      return !e || !(e.value ?? e.innerText).trim(); })()`);
  }

  /* where a chat with this model starts: `pick.url` is a template with {model}, else the home page */
  startUrl(model) {
    return model && this.site.pick?.url ? this.site.pick.url.replace('{model}', encodeURI(model)) : this.site.home;
  }

  /* a fresh chat on the site, with `model` picked (null = the site's default). A tab that is still clean and has the
     right model is kept as it is. The page is navigated, then `pick` (URL template, or `open` + `option` selectors
     clicked in the page) and `reset` (a script for a known start state: leave an image mode, say) run */
  async newChat(model = null) {
    if(this.dirty || this.model !== model) {
      this.dirty = true; /* until the start state is reached: a failed pick leaves the tab to be navigated again */
      await this.cdp.send('Page.navigate', { url: this.startUrl(model) });
      await sleep(500);
      await this.waitInput();
      if(model && this.site.pick?.open) await this.pickUi(model);
      if(this.site.reset) await this.cdp.eval(this.site.reset).catch(() => {});
      this.dirty = false;
    }
    this.model = model;
    this.history = [];
  }

  /* open the site's model menu and click the entry whose text contains the model (case-insensitive) */
  async pickUi(model) {
    const { open, option } = this.site.pick;
    await this.cdp.eval(`document.querySelector(${JSON.stringify(open)})?.click()`);
    for(let i = 0; i < 20; i++) {
      await sleep(250);
      const hit = await this.cdp.eval(`(() => { const want = ${JSON.stringify(model.toLowerCase())};
        const e = [...document.querySelectorAll(${JSON.stringify(option)})].find(e => e.offsetParent && e.innerText.toLowerCase().includes(want));
        if(!e) return false; e.click(); return true; })()`).catch(() => false);
      if(hit) {
        await sleep(300);
        return;
      }
    }
    throw new Error(`${this.site.host} has no model matching "${model}" in its menu`);
  }

  /* stop the running ask(): it returns at its next poll */
  interrupt() {
    this.stopped = true;
  }

  /* abandon an answer the client no longer wants: the site keeps generating until the page is left, so go home */
  async abandon() {
    this.dirty = true;
    this.history = [];
    await this.newChat(this.model).catch(() => {});
  }

  /* true if the open chat already holds exactly the request's history */
  continues(messages, model = null) {
    if(this.model !== model) return false;
    const prev = messages.slice(0, -1);
    /* a tool result is not compared: a client that clips old results to
       save context (ollama-repl does) must not make every round a new chat,
       the open chat saw the real result already */
    return this.history.length > 0 && prev.length == this.history.length && prev.every((m, i) => m.role == this.history[i].role && (m.role == 'tool' || line(m) == line(this.history[i])));
  }

  /* async generator: yields the reply text as it grows, returns when idle */
  async *#ask(prompt, o = {}) {
    this.stopped = false;
    this.dirty = true;
    await this.waitInput();
    const before = await this.readReply();
    const start = await this.pageState();
    const seen = new Set(start.lines);
    const startPath = start.href ? new URL(start.href).pathname : '';
    await this.cdp.eval(`[...document.querySelectorAll(${JSON.stringify(this.site.input)})].find(e => e.offsetParent).focus()`);
    await this.cdp.send('Input.insertText', { text: prompt });
    await sleep(300);
    /* Enter, repeated until the input has emptied = the page took it */
    for(let tries = 0; tries < 4; tries++) {
      /* never press Enter anywhere but in the prompt box: with focus on a
         button (an Upgrade dialog, say) it would activate that button */
      const focused = await this.cdp.eval(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(this.site.input)})].find(e => e.offsetParent);
        if(!e) return false; e.focus(); return e === document.activeElement || e.contains(document.activeElement); })()`);
      if(!focused) {
        await this.clearInput();
        throw new SiteRefusal('not_accepted', 'the prompt box does not have the focus, not pressing Enter');
      }
      for(const type of ['keyDown', 'keyUp'])
        await this.cdp.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: type == 'keyDown' ? '\r' : undefined });
      for(let i = 0; i < 10; i++) {
        await sleep(300);
        if(await this.inputEmpty()) break;
      }
      if(await this.inputEmpty()) break;
    }

    if(!(await this.inputEmpty())) {
      await this.clearInput();
      const st = await this.pageState();
      throw this.refusal(st, seen, prompt, startPath) ?? new SiteRefusal('not_accepted', 'the page did not take the prompt (a dialog in the way? try: eval)');
    }

    /* the request's override, else the site's own expected latency, else the bridge's option */
    const timeout = o.timeout ?? this.site.timeout ?? this.opts.timeout;
    const idle = o.idle ?? this.site.idle ?? this.opts.idle;
    const deadline = Date.now() + timeout * 1000;
    let last = null, changed = Date.now();
    while(Date.now() < deadline) {
      await sleep(400);
      if(this.stopped) return;
      const cur = await this.readReply();
      if(cur.count <= before.count && cur.text == before.text) {
        const why = this.refusal(await this.pageState(), seen, prompt, startPath);
        if(why) throw why;
        continue;
      }
      if(cur.text != last) {
        last = cur.text;
        changed = Date.now();
        yield last;
      } else if(last && Date.now() - changed >= idle * 1000) return;
    }
    if(last === null) throw new Error('no reply seen before timeout');
  }

  /* a SiteRefusal if the page now says it will not answer, else undefined.
     only text that is new since before the send counts, and not the
     prompt's own lines (the user bubble echoes them) */
  refusal(state, seen, prompt, startPath) {
    if(!state.href) return undefined; /* page mid-navigation, look again next poll */
    const path = new URL(state.href).pathname;
    if(path != startPath && PAY_RE.test(path)) return new SiteRefusal('payment_page', `${this.site.host} sent the tab to a payment page (${path}); the bridge never buys anything, close it yourself`, 300);
    if(path != startPath && LOGIN_RE.test(path)) return new SiteRefusal('login', `${this.site.host} wants a login (${state.href})`, 30);
    const fresh = state.lines.filter(l => !seen.has(l) && !prompt.includes(l)).join('\n');
    const m = LIMIT_RE.exec(fresh);
    if(!m) return undefined;
    const line = fresh.split('\n').find(l => LIMIT_RE.test(l)) ?? m[0];
    return new SiteRefusal('rate_limit', `${this.site.host}: ${line}`, parseReset(fresh.slice(fresh.indexOf(line))) ?? 900);
  }

  /* serialized: one prompt at a time per tab */
  ask(prompt, o) {
    const prev = this.#tail;
    let release;
    this.#tail = new Promise(r => (release = r));
    return (async function* (self) {
      await prev;
      try {
        yield* self.#ask(prompt, o);
      } finally {
        release();
      }
    })(this);
  }
}

const strip = c => (typeof c == 'string' ? c : (c ?? []).map(p => p.text ?? '').join(''));

/* text for one message, tool traffic flattened since web chats have none */
function line(m) {
  const c = strip(m.content);
  if(m.role == 'tool') return `[tool result]\n${c}`;
  if(m.tool_calls?.length) return m.tool_calls.map(t => '```tool_call\n' + JSON.stringify({ name: t.function.name, arguments: parseArgs1(t.function.arguments) }) + '\n```').join('\n');
  return c;
}

function parseArgs1(a) {
  try {
    return typeof a == 'string' ? JSON.parse(a) : (a ?? {});
  } catch(e) {
    return {};
  }
}

/* tool calling is emulated: the tools are described in the first prompt
   of a chat and JSON calls found in the reply become tool_calls again */
/* an example call for the first tool, filled from its schema */
function exampleCall(tools) {
  const t = tools[0].function ?? tools[0];
  const props = t.parameters?.properties ?? {};
  const args = {};
  for(const [k, v] of Object.entries(props))
    args[k] = v.type == 'number' || v.type == 'integer' ? 1 : v.type == 'boolean' ? true : /path|file/i.test(k) ? 'notes.txt' : 'example';
  return { name: t.name, arguments: args };
}

/* The tools are described in the first prompt of a chat. Several sites wrap
   their own system prompt around ours and answer "I have no such tools", so
   the text says whose tools these are, shows a worked exchange, and
   TOOL_REMINDER is added at the end of every prompt (what is read last wins). */
function toolPreamble(tools) {
  const list = tools.map(t => `- ${(t.function ?? t).name}: ${(t.function ?? t).description ?? ''}\n  parameters: ${JSON.stringify((t.function ?? t).parameters ?? {})}`).join('\n');
  const ex = exampleCall(tools);
  const call = '```tool_call\n' + JSON.stringify(ex) + '\n```';
  return `You are the language-model engine of an automated agent. No human reads this chat: a program parses every reply you write and carries out the tool calls in it. The tools below belong to that program, not to this website, so it does not matter which tools or features this website normally has: you can use these, and you do have access to the files and the system through them.

Tools:
${list}

A tool call is your whole reply: one fenced block, nothing before or after it (one block per call if you need several):

${call}

The program runs the call and answers with a message that starts with "[tool result]". Then you continue. A short worked example:

program: Task: use the tool ${ex.name} as in the example above.
you:
${call}
program: [tool result]
(whatever the tool printed)
you: (the answer, in plain text, once no further tool is needed)

Rules: never search the web, never say you lack tools or file access, never describe a call in prose instead of making it, never invent what a tool would return - call it. Use only the tools listed, in exactly this format. When no tool is needed, answer in plain text.`;
}

const TOOL_REMINDER = '\n\n(Reminder: if you need a tool, your whole reply is one tool_call block. Never say you cannot use the tools; call them.)';

/* returns { prompt, fresh }: only the last user turn if the chat already
   holds the history, else the whole transcript flattened into one prompt */
function planPrompt(messages, chat, model = null) {
  const last = messages[messages.length - 1];
  if(last.role == 'user' && chat.continues(messages, model)) return { prompt: line(last), fresh: false };

  const names = { system: 'System', user: 'User', assistant: 'Assistant', tool: 'Tool' };
  const body = messages.length == 1 ? line(last) : messages.map(m => `${names[m.role] ?? m.role}: ${line(m)}`).join('\n\n') + '\n\nAssistant:';
  return { prompt: body, fresh: true };
}

/* chats the bridge created, so they can be listed and cleaned up later:
   ~/.cache/chat-bridge/chats.json, [{ site, url, created }] */
const CHATS_FILE = `${getenv('HOME') ?? '.'}/.cache/chat-bridge/chats.json`;

function loadChats() {
  try {
    return JSON.parse(loadFile(CHATS_FILE) ?? '[]');
  } catch(e) {
    return [];
  }
}

function saveChats(list) {
  mkdir(`${getenv('HOME') ?? '.'}/.cache`, 0o755);
  mkdir(`${getenv('HOME') ?? '.'}/.cache/chat-bridge`, 0o755);
  const f = fopen(CHATS_FILE, 'w');
  f.puts(JSON.stringify(list, null, 1));
  f.close();
}

/* remember the open chat of a tab (once per URL) */
async function recordChat(site, name, chat) {
  const { href } = await chat.pageState();
  if(!href || href == site.home || href.replace(/\/$/, '') == site.home.replace(/\/$/, '')) return;
  const list = loadChats();
  if(list.some(c => c.url == href)) return;
  list.push({ site: name, url: href, created: new Date().toISOString() });
  saveChats(list);
}

/* what the bridge counts per site, kept in $CHAT_BRIDGE_STATE (default ~/.cache/chat-bridge/state.json) together
   with the cooldowns, so a restart forgets neither:
     { version: 1, month: '2026-11', sites: { NAME: {
         requests, ok, failed, refusals: { kind: n }, promptChars, replyChars, tokens (estimated),
         lat: [ms of the last 20 answers], lastOk, lastError: { kind, message, at },
         sent: messages since the last limit (or the start), learned: { budget, windowSec } } },
       cooldowns: { NAME: { until, kind, message, retry } } }
   `learned.budget` is what the site took before it refused: the messages sent since the previous refusal (a
   fresh install knows nothing until a site has refused once); `windowSec` the reset time its notice named. */
const STATE_FILE = getenv('CHAT_BRIDGE_STATE') || `${getenv('HOME') ?? '.'}/.cache/chat-bridge/state.json`;
const monthOf = (t = Date.now()) => new Date(t).toISOString().slice(0, 7);
const LAT_KEEP = 20;

class Stats {
  data = { version: 1, month: monthOf(), sites: {}, cooldowns: {} };

  constructor(file = STATE_FILE) {
    this.file = file;
    try {
      const d = JSON.parse(loadFile(file) ?? 'null');
      if(d?.version == 1) this.data = d;
    } catch(e) {}
    this.#roll();
  }

  /* a new month starts the counters again, the learned limits stay */
  #roll() {
    const m = monthOf();
    if(this.data.month == m) return;
    for(const s of Object.values(this.data.sites)) Object.assign(s, { requests: 0, ok: 0, failed: 0, refusals: {}, promptChars: 0, replyChars: 0, tokens: 0 });
    this.data.month = m;
  }

  site(name) {
    this.#roll();
    return (this.data.sites[name] ??= { requests: 0, ok: 0, failed: 0, refusals: {}, promptChars: 0, replyChars: 0, tokens: 0, lat: [], lastOk: null, lastError: null, sent: 0, learned: null });
  }

  /** one finished request: ok, or the refusal kind / 'error' */
  record(name, { ok, ms, promptChars = 0, replyChars = 0, kind, message }) {
    const s = this.site(name);
    s.requests++;
    s.promptChars += promptChars;
    s.replyChars += replyChars;
    s.tokens += Math.ceil(promptChars / 4) + Math.ceil(replyChars / 4);

    if(ok) {
      s.ok++;
      s.sent++;
      if(s.lastCheck && !s.lastCheck.ok) delete s.lastCheck; /* it answers a request again: the failed check is stale */
      s.lastOk = new Date().toISOString();
      s.lat.push(ms);
      if(s.lat.length > LAT_KEEP) s.lat.shift();
    } else {
      s.failed++;
      s.refusals[kind] = (s.refusals[kind] ?? 0) + 1;
      s.lastError = { kind, message: String(message ?? '').slice(0, 200), at: new Date().toISOString() };
    }
    this.save();
  }

  /** the site refused with a limit: what it took since the last one is its budget, the notice's time its window */
  limited(name, retry) {
    const s = this.site(name);
    if(s.sent > 0) s.learned = { budget: s.sent, ...(retry ? { windowSec: Math.round(retry) } : s.learned?.windowSec ? { windowSec: s.learned.windowSec } : {}) };
    s.sent = 0;
    this.save();
  }

  median(name) {
    const l = [...(this.data.sites[name]?.lat ?? [])].sort((a, b) => a - b);
    return l.length ? l[l.length >> 1] : null;
  }

  setCooldown(name, c) {
    if(c) this.data.cooldowns[name] = { until: c.until, kind: c.err.kind, message: c.err.message, retry: c.err.retry };
    else delete this.data.cooldowns[name];
    this.save();
  }

  save() {
    try {
      mkdir(this.file.replace(/\/[^\/]*$/, ''), 0o755);
      const f = fopen(`${this.file}.tmp`, 'w');
      f.puts(JSON.stringify(this.data));
      f.close();
      rename(`${this.file}.tmp`, this.file);
    } catch(e) {}
  }
}

class Bridge {
  chats = new Map(); /* tab id -> Chat */
  pool = new Map(); /* site name -> Chat[] of tabs we own */
  opening = new Map(); /* site name -> tabs being created */
  waiters = [];
  cooldown = new Map(); /* site name -> { until (ms), err } for a refusing site */
  sticky = new Map(); /* x-session-id -> the site that last answered it (auto routing keeps a conversation on one site) */
  #browser;
  #opening = Promise.resolve();

  constructor(o) {
    this.o = o;
    this.stats = new Stats();

    /* a limit that was still running when the bridge stopped */
    for(const [name, c] of Object.entries(this.stats.data.cooldowns))
      if(c.until > Date.now() && ACTIVE[name]) this.cooldown.set(name, { until: c.until, err: new SiteRefusal(c.kind, c.message, c.retry) });
      else this.stats.setCooldown(name, null);
  }

  url(path) {
    return `http://${this.o.host}:${this.o.port}${path}`;
  }

  /* chrome omits the port in the ws urls when asked by Host: header */
  ws(u) {
    return /:\d+\//.test(u) ? u : u.replace(/^(ws:\/\/[^\/]+)/, `$1:${this.o.port}`);
  }

  async tabs() {
    return (await (await fetch(this.url('/json'))).json()).filter(t => t.type == 'page');
  }

  siteOf(tab) {
    let host;
    try {
      host = new URL(tab.url).host;
    } catch(e) {}
    return Object.entries(ACTIVE).find(([, s]) => s.host == host);
  }

  async attach(tab, site) {
    const cdp = new CDP();
    await cdp.open(this.ws(tab.webSocketDebuggerUrl));
    await cdp.send('Runtime.enable');
    /* the page believes it has focus, so no need to raise the window and
       steal the user's keyboard focus */
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    return new Chat(site, cdp, this.o);
  }

  /* an already open tab of the site (CLI commands) */
  async chat(name) {
    const tab = (await this.tabs()).find(t => (this.siteOf(t) ?? [])[0] == name || (!name && this.siteOf(t)));
    if(!tab) throw new Error(`no open tab for ${name ?? 'any known site'} (see: list)`);
    let chat = this.chats.get(tab.id);
    if(!chat || chat.cdp.closed) this.chats.set(tab.id, (chat = await this.attach(tab, this.siteOf(tab)[1])));
    return chat;
  }

  /* a tab for a chat: by default a blank tab that is already open gets
     navigated, and only when there is none a background tab is created
     (CDP cannot place a created tab in a given window, and some browsers
     open a new window for it); with --new-tabs one is always created.
     Same profile, so logged in */
  async open(name) {
    const prev = this.#opening;
    let done;
    this.#opening = new Promise(r => (done = r));
    await prev;
    try {
      return await this.#open(name);
    } finally {
      done();
    }
  }

  async #open(name) {
    if(!this.o.newTabs) {
      const owned = new Set([...this.pool.values()].flat().map(c => c.targetId));
      const spare = (await this.tabs()).find(t => !owned.has(t.id) && BLANK_RE.test(t.url));
      if(spare) {
        const chat = await this.attach(spare, ACTIVE[name]);
        chat.targetId = spare.id;
        chat.borrowed = true;
        await chat.cdp.send('Page.navigate', { url: ACTIVE[name].home });
        return chat;
      }
    }
    if(!this.#browser) {
      const v = await (await fetch(this.url('/json/version'))).json();
      this.#browser = new CDP();
      await this.#browser.open(this.ws(v.webSocketDebuggerUrl));
    }
    const { targetId } = await this.#browser.send('Target.createTarget', { url: ACTIVE[name].home, newWindow: false, background: true });
    const tab = (await this.tabs()).find(t => t.id == targetId);
    const chat = await this.attach(tab, ACTIVE[name]);
    chat.targetId = targetId;
    return chat;
  }

  /* a free chat for the request: one already holding its history, else
     any idle one (reset to a fresh chat), else a new tab up to --max,
     else wait for one to be released */
  async acquire(name, messages, model = null) {
    if(!ACTIVE[name]) throw new Error(`unknown model, use one of: ${Object.keys(ACTIVE).join(', ')}`);
    for(;;) {
      if(!this.pool.has(name)) this.pool.set(name, []);
      const pool = this.pool.get(name); /* same array throughout, open() awaits */
      for(let i = pool.length; i-- > 0; ) if(pool[i].cdp.closed) pool.splice(i, 1);
      const free = pool.filter(c => !c.busy);
      /* the chat holding the history, else an idle one that already has the model, else any idle one */
      let chat = free.find(c => c.continues(messages, model)) ?? free.find(c => c.model === model) ?? free[0];
      if(!chat && pool.length + (this.opening.get(name) ?? 0) < this.o.max) {
        this.opening.set(name, (this.opening.get(name) ?? 0) + 1);
        try {
          chat = await this.open(name);
        } finally {
          this.opening.set(name, this.opening.get(name) - 1);
        }
        pool.push(chat);
      }
      if(chat) {
        chat.busy = true;
        return chat;
      }
      await new Promise(r => this.waiters.push(r));
    }
  }

  /* close the tabs this bridge opened */
  async closeAll() {
    for(const pool of this.pool.values())
      for(const c of pool) await this.dispose(c);
  }

  /* close a tab the bridge created; a borrowed one goes back to blank */
  async dispose(chat) {
    if(chat.borrowed) await chat.cdp.send('Page.navigate', { url: 'about:blank' }).catch(() => {});
    else await this.#browser?.send('Target.closeTarget', { targetId: chat.targetId }).catch(() => {});
  }

  release(chat) {
    chat.busy = false;
    if(chat.retired) {
      for(const pool of this.pool.values()) {
        const i = pool.indexOf(chat);
        if(i >= 0) pool.splice(i, 1);
      }
      this.dispose(chat);
    }
    for(const r of this.waiters.splice(0)) r();
  }

  /* a site that refused, until it is worth asking again */
  cooling(name) {
    const c = this.cooldown.get(name);
    if(c && c.until > Date.now()) return c;
    if(c) this.stats.setCooldown(name, null);
    this.cooldown.delete(name);
  }

  refused(name, err) {
    if(err.retry) {
      const c = { until: Date.now() + err.retry * 1000, err };
      this.cooldown.set(name, c);
      this.stats.setCooldown(name, c);
    }
    if(err.kind == 'rate_limit') this.stats.limited(name, err.retry);
    if(err.kind == 'rate_limit') this.retire(name);
  }

  /* close the tabs of a site that hit its message limit: they cannot
     receive a prompt until it resets, and nothing in the tab can fix that.
     (A tab that can still take a prompt is never closed, nor one waiting
     for the user to log in or accept a dialog; a tab still answering a
     request is closed once released, see release().) */
  async retire(name) {
    const pool = this.pool.get(name) ?? [];

    for(let i = pool.length; i-- > 0; ) {
      const c = pool[i];
      if(c.busy) {
        c.retired = true;
        continue;
      }
      pool.splice(i, 1);
      await this.#browser?.send('Target.closeTarget', { targetId: c.targetId }).catch(() => {});
    }
  }

  /* one site's health for /v1/providers: healthy, rate_limited, logged_out or billing_guard */
  status(id) {
    const c = this.cooling(id);
    if(ACTIVE[id].billing == 'metered' && !this.o.allowPaid) return 'billing_guard';
    if(c) return c.err.kind == 'login' ? 'logged_out' : 'rate_limited';
    if(this.broken(id)) return 'invalid';
    return 'healthy';
  }

  /* the last `check` of the site failed less than an hour ago and no request has worked since: its selectors are
     probably out of date, so auto routing leaves it out (a request to it by name still goes through) */
  broken(id) {
    const k = this.stats.data.sites[id]?.lastCheck;
    return !!k && !k.ok && Date.now() - Date.parse(k.at) < 3600_000;
  }

  /**
   * Selector self-test of one site: a fresh chat, the input found, a fixed prompt taken, a reply read. It sends one
   * real prompt, so it costs a message of the site's quota. The result is kept in the stats (lastCheck) and shows in
   * /v1/providers and the site's status. { site, ok, stage, ms, error?, reply?, skipped? }; stage is where it stopped:
   * input, send, reply or done.
   */
  async check(name) {
    const site = ACTIVE[name];
    if(!site) return { site: name, ok: false, stage: 'input', ms: 0, error: 'unknown site' };
    if(site.billing == 'metered' && !this.o.allowPaid) return { site: name, ok: false, skipped: 'billing_guard', stage: 'input', ms: 0 };
    const c = this.cooling(name);
    if(c) return { site: name, ok: false, skipped: c.err.kind, stage: 'input', ms: 0, error: c.err.message };

    const t0 = Date.now();
    const r = { site: name, ok: false, stage: 'input', ms: 0 };
    let chat;

    try {
      chat = await this.acquire(name, [{ role: 'user', content: CHECK_PROMPT }]);
      await chat.newChat();
      await chat.waitInput();
      r.stage = 'send';
      let text = '';
      for await (const t of chat.ask(CHECK_PROMPT)) {
        r.stage = 'reply';
        text = t;
      }
      if(!text.trim()) throw new Error('the reply selector matched no text');
      r.ok = true;
      r.stage = 'done';
      r.reply = text.trim().slice(0, 80);
    } catch(e) {
      r.error = e.message;
      if(/no reply seen/.test(e.message)) r.stage = 'reply'; /* the prompt was taken, nothing matched the reply selector */
      if(e instanceof SiteRefusal) {
        r.kind = e.kind;
        this.refused(name, e);
      }
      if(chat) chat.history = [];
    } finally {
      if(chat) this.release(chat);
    }

    r.ms = Date.now() - t0;
    this.stats.site(name).lastCheck = { ok: r.ok, at: new Date().toISOString(), ms: r.ms, stage: r.stage, ...(r.error ? { error: r.error.slice(0, 200) } : {}) };
    this.stats.save();
    return r;
  }

  /* what is left of the learned budget: { limit, remaining, pct } or null while the site never refused */
  budget(id) {
    const s = this.stats.data.sites[id];
    const limit = s?.learned?.budget;
    if(!limit) return null;
    const remaining = Math.max(0, limit - s.sent);
    return { limit, remaining, pct: Math.round((100 * remaining) / limit) };
  }

  /* GET /v1/usage: the month's ledger in the shape of a freellmapi gateway, tokens estimated */
  usage() {
    const d = this.stats.data;
    const sites = Object.entries(d.sites).filter(([id]) => ACTIVE[id]);
    const next = new Date(`${d.month}-01T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);

    return {
      object: 'usage',
      source: 'chat-bridge',
      month: d.month,
      requests: sites.reduce((n, [, s]) => n + s.requests, 0),
      tokens: sites.reduce((n, [, s]) => n + s.tokens, 0),
      tokens_estimated: true,
      resetsAt: next.toISOString(),
      byPlatform: sites.map(([platform, s]) => ({ platform, requests: s.requests, tokens: s.tokens })),
      byKey: [],
    };
  }

  /* GET /v1/providers: health of every site */
  providers() {
    const providers = Object.keys(ACTIVE).map(id => {
      const s = this.stats.site(id);
      const c = this.cooling(id);
      const b = this.budget(id);
      const pool = this.pool.get(id) ?? [];

      return {
        platform: id,
        name: ACTIVE[id].name ?? id,
        status: this.status(id),
        keys: 1,
        ...(c ? { resume_at: new Date(c.until).toISOString() } : {}),
        ...(b ? { requests_remaining_pct: b.pct } : {}),
        last_error: s.lastError ? `${s.lastError.kind}: ${s.lastError.message}` : null,
        tabs: { open: pool.length, busy: pool.filter(t => t.busy).length },
        ...(s.lastCheck ? { check: s.lastCheck } : {}),
        median_ms: this.stats.median(id),
        success_rate: s.requests ? Math.round((1000 * s.ok) / s.requests) / 1000 : null,
      };
    });
    const counts = { healthy: 0, rate_limited: 0, invalid: 0, unknown: 0 };
    for(const p of providers) counts[p.status] = (counts[p.status] ?? 0) + 1;

    return { object: 'list', source: 'chat-bridge', counts, providers };
  }

  /* GET /v1/quota-forecast: a pool per site whose limit was learned from a refusal */
  forecast() {
    const pools = [];

    for(const id of Object.keys(ACTIVE)) {
      const b = this.budget(id);
      if(!b) continue;
      const c = this.cooling(id);
      pools.push({ platform: id, pool: id, limit: b.limit, used: b.limit - b.remaining, remaining: b.remaining, remaining_pct: b.pct, reset_at: c ? new Date(c.until).toISOString() : null, low_balance: b.pct <= 20, seconds_until_reset: c ? Math.max(0, Math.round((c.until - Date.now()) / 1000)) : null, rate_per_min: null, estimated_exhaustion_at: null, learned: true });
    }

    return { object: 'quota_forecast', source: 'chat-bridge', generated_at: new Date().toISOString(), low_balance_threshold: { pct: 0.2, absolute: 0, absolute_min_limit: 0 }, pools };
  }

  /**
   * The sites that can take a request now, best first, for `auto` and `auto:AXIS`. Ready sites only (not on
   * cooldown, not logged out, not billing-guarded), tool-capable ones when the request has tools. The score mixes
   * what the bridge measured (reliability: the share of good answers with a prior; speed: the median latency) with
   * the static `rank` of a site (doc/PROVIDERS.md verdicts); `cheap` prefers the site used least this month, so the
   * free quotas wear evenly. A conversation stays on its site (x-session-id) while the site is ready.
   */
  route(axis, { tools = false, session = null } = {}) {
    const ids = Object.keys(ACTIVE).filter(id => this.status(id) == 'healthy' && ACTIVE[id].auto !== false && (!tools || ACTIVE[id].capabilities?.tools !== false));
    const ranks = Object.values(ACTIVE).map(s => s.rank ?? 9);
    const worst = Math.max(...ranks);
    const W = { smart: [0.2, 0.1, 0.7, 0], fast: [0.2, 0.7, 0.1, 0], reliable: [0.7, 0.15, 0.15, 0], cheap: [0.1, 0, 0, 0.9], balanced: [0.4, 0.2, 0.4, 0] }[axis] ?? [0.4, 0.2, 0.4, 0];

    const score = id => {
      const s = this.stats.site(id);
      const med = this.stats.median(id);
      const reliability = (s.ok + 1) / (s.requests + 2);
      const speed = med == null ? 0.5 : 1 / (1 + med / 20000);
      const smart = 1 - ((ACTIVE[id].rank ?? 9) - 1) / worst;
      const cheap = 1 / (1 + s.requests / 50);
      return W[0] * reliability + W[1] * speed + W[2] * smart + W[3] * cheap;
    };

    const order = ids.sort((a, b) => score(b) - score(a) || (ACTIVE[a].rank ?? 9) - (ACTIVE[b].rank ?? 9));
    const home = session && this.sticky.get(session);
    return home && order.includes(home) ? [home, ...order.filter(id => id != home)] : order;
  }

  models() {
    return [...this.siteModels(), ...this.autoModels()];
  }

  /* auto and auto:AXIS: the bridge picks the site (route) */
  autoModels() {
    const ready = Object.keys(ACTIVE).filter(id => this.status(id) == 'healthy');
    const tools = ready.some(id => ACTIVE[id].capabilities?.tools !== false);
    const names = { auto: 'Auto (balanced)', 'auto:smart': 'Auto, smartest first', 'auto:fast': 'Auto, fastest first', 'auto:reliable': 'Auto, most reliable first', 'auto:cheap': 'Auto, least used first', 'auto:balanced': 'Auto, balanced' };

    return Object.entries(names).map(([id, name]) => ({
      id,
      object: 'model',
      owned_by: 'chat-bridge',
      name,
      billing: 'free',
      available: ready.length > 0,
      execution_status: ready.length ? 'ready' : 'exhausted',
      supported_parameters: ['temperature', 'max_tokens', 'stream', ...(tools ? ['tools', 'tool_choice'] : [])],
      capabilities: { tools, vision: false, reasoning: false, stream: true },
    }));
  }

  siteModels() {
    return Object.keys(ACTIVE).map(id => {
      const c = this.cooling(id);
      const billing = ACTIVE[id].billing ?? 'free';
      const guarded = billing == 'metered' && !this.o.allowPaid;
      const site = ACTIVE[id];
      const name = site.name ?? id;
      const context = site.context ?? null;
      const capabilities = { tools: true, vision: false, reasoning: false, stream: true, ...site.capabilities };
      const available = !c && !guarded;
      let execution_status = 'ready';
      if(c) execution_status = c.err.kind == 'login' ? 'needsKey' : 'exhausted';
      else if(guarded) execution_status = 'needsKey';
      const supported_parameters = ['temperature', 'max_tokens', 'stream'];
      if(capabilities.tools) supported_parameters.push('tools', 'tool_choice');
      const result = {
        id,
        object: 'model',
        owned_by: 'chat-bridge',
        name,
        billing,
        available,
        execution_status,
        supported_parameters,
        capabilities,
        ...(context !== null ? { context_window: context, context_length: context } : {}),
        ...(site.maxPrompt ? { max_prompt_chars: site.maxPrompt } : {}),
        ...(guarded ? { unavailable: 'billing_guard' } : c ? { unavailable: c.err.kind, resets_at: new Date(c.until).toISOString() } : {})
      };
      return result;
    }).flatMap(m => [m, ...(ACTIVE[m.id].models ?? []).map(x => ({ ...m, id: `${m.id}/${x}`, name: `${m.name} ${x}` }))]);
  }
}

const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...headers } });

/* the OpenAI error shape for a refusing site; clients read the status, `code` and Retry-After */
function refusalResponse(err, retry = err.retry, extra = {}) {
  const r = REFUSALS[err.kind] ?? REFUSALS.not_accepted;
  return json({ error: { message: err.message, type: r.type, code: r.code, param: null } }, r.status, { ...(retry ? { 'retry-after': String(Math.ceil(retry)) } : {}), ...extra });
}

/* how much of a growing reply may be sent on while the request has tools: everything before what could be the start
   of a tool call (a `{`, a fence, the label some pages print before it, or the first characters of those, which
   the next poll may complete). The calls themselves are only known once the reply is whole (extractCalls) */
function holdIndex(t) {
  let n = t.length;
  for(const m of ['{', '```', 'tool_call']) {
    const i = t.indexOf(m);
    if(i >= 0 && i < n) n = i;
  }
  const head = t.slice(0, n);
  if(n == t.length) {
    for(const m of ['```', 'tool_call']) {
      for(let k = Math.min(m.length - 1, n); k > 0; k--) {
        if(head.endsWith(m.slice(0, k))) return n - k;
      }
    }
    return n;
  }
  return head.trimEnd().length; /* the blank lines before a call are not content */
}

/* max_tokens and stop of a request as a function: text -> { text, finish }. The first stop string ends the reply
   (finish 'stop'), max_tokens cuts at four characters a token (finish 'length') */
function limiter(body) {
  const stops = [].concat(body.stop ?? []).filter(x => typeof x == 'string' && x);
  const max = +(body.max_completion_tokens ?? body.max_tokens);
  const maxChars = max > 0 ? max * 4 : Infinity;
  const limit = text => {
    let finish = null;
    for(const x of stops) {
      const i = text.indexOf(x);
      if(i >= 0) {
        text = text.slice(0, i);
        finish = 'stop';
      }
    }
    if(text.length > maxChars) {
      text = text.slice(0, maxChars);
      finish = 'length';
    }
    return { text, finish };
  };
  limit.hold = Math.max(0, ...stops.map(x => x.length - 1)); /* a stop string may arrive split over two polls */
  return limit;
}

function completions(bridge) {
  return async req => {
    const t0 = Date.now();
    let body;
    try {
      body = await req.json();
    } catch(e) {
      return json({ error: { message: 'invalid JSON' } }, 400);
    }
    const { messages, stream, model = '' } = body;
    const tools = body.tools?.length ? body.tools : null;
    if(!messages?.length) return json({ error: { message: 'messages required' } }, 400);

    const limit = limiter(body);
    /* what the harness sees of a request: a view of the reply so far, { text: what may be sent, finish } */
    const view = (t, final) => {
      const v = limit(tools && !final ? t.slice(0, holdIndex(t)) : t);
      return !final && !v.finish && limit.hold ? { text: v.text.slice(0, Math.max(0, v.text.length - limit.hold)), finish: null } : v;
    };
    /* a request's own timeout and idle time (seconds) beat the site's and the bridge's */
    const secs = h => (Number.isFinite(+req.headers.get(h)) && +req.headers.get(h) > 0 ? +req.headers.get(h) : undefined);
    const over = { timeout: secs('x-chat-bridge-timeout'), idle: secs('x-chat-bridge-idle') };
    /* the client went away: stop the site's generation (a cancelled request is no failure of the site) */
    let cancelled = false, current = null;
    const cancel = () => {
      cancelled = true;
      current?.interrupt();
    };
    req.signal?.addEventListener('abort', cancel);

    /* one attempt on one site: its Response. ctx.failed says why when the site gave no reply, so the router can try
       the next one (a refusal, a timeout, a prompt too long); ctx.attempts are the sites that failed before it */
    const attempt = async (name, ctx = { attempts: [] }, pick = null) => {
    const via = `${name}/${pick ?? 'default'}`;
    const fail = (kind, message) => (ctx.failed = { kind, message });
    if(ACTIVE[name]?.billing == 'metered' && !bridge.o.allowPaid) {
      fail('billing');
      return refusalResponse(new SiteRefusal('billing', `${name} is pay-as-you-go and can cost money, so the bridge refuses it; start the bridge with --allow-paid to use it anyway`));
    }

    const cool = bridge.cooling(name);
    if(cool) {
      fail(cool.err.kind, cool.err.message);
      return refusalResponse(cool.err, (cool.until - Date.now()) / 1000, { 'x-routed-via': via });
    }

    let chat, gen, full;
    try {
      chat = await bridge.acquire(name, messages, pick);
      current = chat;
      const plan = planPrompt(messages, chat, pick);
      if(plan.fresh) await chat.newChat(pick);
      const body = tools ? plan.prompt + TOOL_REMINDER : plan.prompt;
      full = plan.fresh && tools ? `${toolPreamble(tools)}\n\n${body}` : body;
      const max = ACTIVE[name]?.maxPrompt;
      if(ctx.attempts.length && full.length > bridge.o.maxReplay) {
        bridge.release(chat);
        fail('replay_too_long');
        return json({ error: { message: `the conversation is ${full.length} characters, more than the ${bridge.o.maxReplay} the bridge replays on another site after a failure (--max-replay)`, type: 'invalid_request_error', code: 'context_length_exceeded' } }, 400);
      }
      if(max && full.length > max) {
        bridge.release(chat);
        fail('too_long');
        return json({ error: { message: `${name} takes at most ${max} characters per message, this prompt has ${full.length}`, type: 'invalid_request_error', code: 'context_length_exceeded' } }, 400);
      }
      gen = chat.ask(full, over);
    } catch(e) {
      if(chat) bridge.release(chat);
      bridge.stats.record(name, { ok: false, ms: Date.now() - t0, promptChars: full?.length, kind: 'error', message: e.message });
      fail('error', e.message);
      return json({ error: { message: e.message } }, 502);
    }

    /* the counters of the site: one record per request that reached it */
    const done = (ok, reply = '', e) => bridge.stats.record(name, { ok, ms: Date.now() - t0, promptChars: full.length, replyChars: reply.length, kind: e?.kind ?? 'error', message: e?.message });

    const id = `chatcmpl-${Date.now().toString(36)}`,
      created = Math.floor(Date.now() / 1000);
    /* what the harness reads of every answer: the site that served it, the id, the time; tokens are estimated (chars / 4) */
    const hdr = () => {
      const b = bridge.budget(name);
      const w = bridge.stats.data.sites[name]?.learned?.windowSec;
      return {
        'x-routed-via': via,
        'x-request-id': id,
        'x-response-ms': String(Date.now() - t0),
        ...(ctx.attempts.length ? { 'x-fallback-attempts': String(ctx.attempts.length), 'x-fallback-trail': ctx.attempts.map(a => `${a.site}/default key1: ${a.kind}`).join('; ') } : {}),
        /* the learned budget; the reset is an estimate (the window as the last notice named it, else a day from now) */
        ...(b ? { 'x-ratelimit-limit': String(b.limit), 'x-ratelimit-remaining': String(b.remaining), 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + (w ?? 86400)) } : {}),
      };
    };
    const usageOf = reply => {
      const prompt = Math.ceil(full.length / 4);
      const completion = Math.ceil(reply.length / 4);
      return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, estimated: true };
    };
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const remember = msg => (chat.history = [...messages, msg]);

    /* the reply text -> an assistant message, with tool_calls if it has any */
    const toMessage = text => {
      const calls = tools ? extractCalls(text, tools) : [];
      if(!calls.length) return { role: 'assistant', content: text };
      return { role: 'assistant', content: null, tool_calls: calls.map((c, i) => ({ id: `call_${id}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) };
    };

    if(!stream) {
      let text = '';
      try {
        for await (const t of gen) text = t;
      } catch(e) {
        chat.history = [];
        done(false, '', e);
        fail(e.kind ?? 'timeout', e.message);
        if(e instanceof SiteRefusal) {
          bridge.refused(name, e);
          return refusalResponse(e, e.retry, hdr());
        }
        return json({ error: { message: e.message } }, 504);
      } finally {
        if(cancelled) await chat.abandon();
        else await recordChat(ACTIVE[name], name, chat).catch(() => {});
        bridge.release(chat);
      }
      if(cancelled) return json({ error: { message: 'the client closed the request' } }, 499);
      done(true, text);
      let msg = toMessage(text);
      let finish = msg.tool_calls ? 'tool_calls' : 'stop';
      remember(msg);
      /* max_tokens and stop cut a text answer, never a tool call; the chat then holds more than the client got */
      if(!msg.tool_calls) {
        const v = limit(text);
        if(v.finish) {
          msg = { role: 'assistant', content: v.text };
          finish = v.finish;
          chat.history = [];
        }
      }
      return json({ id, object: 'chat.completion', created, model, choices: [{ index: 0, message: msg, finish_reason: finish }], usage: usageOf(text) }, 200, hdr());
    }

    /* wait for the first reply text, so a refusal can still be a real
       HTTP status instead of an error event in the middle of a stream */
    let first;
    try {
      first = await gen.next();
    } catch(e) {
      chat.history = [];
      bridge.release(chat);
      done(false, '', e);
      fail(e.kind ?? 'timeout', e.message);
      if(e instanceof SiteRefusal) {
        bridge.refused(name, e);
        return refusalResponse(e, e.retry, hdr());
      }
      return json({ error: { message: e.message } }, 504);
    }
    if(cancelled) {
      await chat.abandon();
      bridge.release(chat);
      return json({ error: { message: 'the client closed the request' } }, 499);
    }
    /* leaving this generator early (a cut, a cancel) must finish gen too, or the tab's queue never frees */
    const replies = (async function* () {
      try {
        if(!first.done) yield first.value;
        yield* gen;
      } finally {
        await gen.return();
      }
    })();

    /* strings, not bytes: serve() drops Uint8Array chunks (see BUGS).
       Text streams as it grows; with tools only up to what could be the start of a tool call (holdIndex), and the
       calls follow as tool_calls once the reply is whole */
    return new Response(
      new ReadableStream({
        async start(c) {
          let sent = '', text = '', cut = null;
          const emit = x => {
            try {
              c.enqueue(x);
            } catch(e) {
              cancel(); /* the stream is gone */
            }
          };
          try {
            emit(chunk({ role: 'assistant', content: '' }));
            for await (const t of replies) {
              text = t;
              if(cancelled) break;
              const v = view(t, false);
              /* only append-only growth is streamable, a rewrite waits */
              if(v.text.length > sent.length && v.text.startsWith(sent)) {
                emit(chunk({ content: v.text.slice(sent.length) }));
                sent = v.text;
              }
              /* a cut that no tool call can still follow: stop the site, it would go on generating */
              if(v.finish && !tools) {
                cut = v.finish;
                break;
              }
            }
            if(cancelled) {
              await chat.abandon();
              bridge.release(chat);
              try {
                c.close();
              } catch(e) {}
              return;
            }
            done(true, text);
            let finish = cut;
            if(!cut) {
              const msg = toMessage(text);
              if(msg.tool_calls) {
                emit(chunk({ tool_calls: msg.tool_calls.map((t, index) => ({ index, ...t })) }));
                finish = 'tool_calls';
                remember(msg);
              } else {
                const v = view(text, true);
                if(v.text.length > sent.length && v.text.startsWith(sent)) emit(chunk({ content: v.text.slice(sent.length) }));
                finish = v.finish ?? 'stop';
                sent = v.text;
                remember({ role: 'assistant', content: text });
                if(v.finish) chat.history = [];
              }
            } else {
              await chat.abandon();
            }
            emit(chunk({}, finish) + `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: usageOf(sent || text) })}\n\n` + 'data: [DONE]\n\n');
          } catch(e) {
            chat.history = [];
            done(false, sent, e);
            if(e instanceof SiteRefusal) bridge.refused(name, e);
            emit(`data: ${JSON.stringify({ error: { message: e.message, ...(REFUSALS[e.kind] ? { type: REFUSALS[e.kind].type, code: REFUSALS[e.kind].code } : {}) } })}\n\n`);
          }
          bridge.release(chat);
          try {
            c.close();
          } catch(e) {}
        },
        cancel,
      }),
      { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...hdr() } },
    );
    };

    const auto = /^auto(?::(smart|fast|reliable|cheap|balanced))?$/.exec(model);
    if(!auto) {
      const r = resolveModel(model);
      if(r.error) return json({ error: { message: r.error.message, type: 'invalid_request_error', code: r.error.code, param: 'model' } }, r.error.status);
      return attempt(r.site, undefined, r.pick);
    }

    /* auto: the best ready site, the next one when it refuses before any reply text (the conversation is replayed
       there as one transcript); a streamed answer that already began cannot move */
    const session = req.headers.get('x-session-id') ?? req.headers.get('x-chat-bridge-conversation');
    const ctx = { attempts: [], session };

    for(const name of bridge.route(auto[1] ?? 'balanced', { tools: !!tools, session })) {
      ctx.failed = null;
      const res = await attempt(name, ctx);
      if(!ctx.failed) {
        if(session) bridge.sticky.set(session, name);
        return res;
      }
      ctx.attempts.push({ site: name, ...ctx.failed });
    }

    /* nothing answered: the gateway's wording, so a client that reads its errors (the harness skip) understands it */
    const trail = ctx.attempts.map(a => `${a.site}/default key1: ${a.kind}`).join('; ');
    const soonest = Math.min(...[...bridge.cooldown.values()].map(c => c.until).filter(u => u > Date.now()));
    const retry = Number.isFinite(soonest) ? Math.ceil((soonest - Date.now()) / 1000) : null;
    const limited = !ctx.attempts.length || ctx.attempts.every(a => ['rate_limit', 'login', 'billing'].includes(a.kind));
    const message = ctx.attempts.length
      ? `All models ${limited ? 'rate-limited' : 'failed'} after ${ctx.attempts.length} attempt${ctx.attempts.length == 1 ? '' : 's'}.${retry ? ` Soonest cooldown reset ~${retry}s.` : ''} Attempt trail: ${trail}. Last error: ${ctx.attempts.at(-1).message ?? ctx.attempts.at(-1).kind}`
      : `All models exhausted: no site can serve this request right now${tools ? ' (tool-capable sites only)' : ''}.${retry ? ` Soonest cooldown reset ~${retry}s.` : ''}`;
    return json({ error: { message, type: limited ? 'rate_limit_error' : 'api_error', code: limited ? 'routing_exhausted' : 'upstream_failed', param: null } }, limited ? 429 : 502, {
      ...(retry && limited ? { 'retry-after': String(retry) } : {}),
      'x-fallback-attempts': String(ctx.attempts.length),
      ...(trail ? { 'x-fallback-trail': trail } : {}),
    });
  };
}

function parseArgs(argv) {
  const o = { maxReplay: 60000, port: 9222, host: '127.0.0.1', listen: 8089, max: 3, idle: 2.5, timeout: 180, site: null, allowPaid: getenv('CHAT_BRIDGE_ALLOW_PAID') == '1', newTabs: false, rest: [] };
  const num = new Set(['port', 'listen', 'max', 'idle', 'timeout', 'maxReplay']);
  for(let i = 0; i < argv.length; i++) {
    if(argv[i] == '--allow-paid') {
      o.allowPaid = true;
      continue;
    }
    if(argv[i] == '--new-tabs') {
      o.newTabs = true;
      continue;
    }
    const m = /^--(\w+)$/.exec(argv[i].replace(/^--max-replay$/, '--maxReplay'));
    if(m && m[1] in o && m[1] != 'rest') o[m[1]] = num.has(m[1]) ? +argv[++i] : argv[++i];
    else o.rest.push(argv[i]);
  }
  return o;
}

async function main() {
  const o = parseArgs(scriptArgs.slice(1));
  const [cmd, arg] = o.rest;
  if(!cmd) throw new Error('usage: chat-bridge.js [options] serve|send|read|eval|list [arg]');

  const bridge = new Bridge(o);

  if(cmd == 'chats') {
    /* chats the bridge created: `chats` lists them, `chats forget [site]`
       drops the records (the sites' own history is untouched) */
    const list = loadChats();
    if(arg == 'forget') {
      const keep = list.filter(c => o.rest[2] && c.site != o.rest[2]);
      saveChats(keep);
      console.log(`forgot ${list.length - keep.length} of ${list.length} records`);
      return;
    }
    const per = {};
    for(const c of list) {
      per[c.site] = (per[c.site] ?? 0) + 1;
      console.log(`${c.site}\t${c.created}\t${c.url}`);
    }
    console.log(Object.entries(per).map(([k, v]) => `${k}: ${v}`).join(', ') || 'no chats recorded');
    return;
  }

  if(cmd == 'list') {
    for(const t of await bridge.tabs()) console.log(`${bridge.siteOf(t)?.[0] ?? '-'}\t${t.url}\t${t.title}`);
    return;
  }

  if(cmd == 'check') {
    /* asks the running bridge (tabs it holds are busy for it, and its stats are the ones that count) */
    const r = await fetch(`http://127.0.0.1:${o.listen}/v1/check`, { method: 'POST', body: JSON.stringify(o.rest.length > 1 ? { site: o.rest.slice(1) } : {}) }).catch(() => null);
    if(!r) throw new Error(`no chat-bridge serving on port ${o.listen} (--listen); start one with: serve`);
    const { results } = await r.json();
    for(const x of results) console.log(`${x.ok ? 'ok  ' : 'FAIL'}  ${x.site.padEnd(12)} ${x.stage.padEnd(6)} ${String(x.ms).padStart(6)} ms  ${x.skipped ? `skipped (${x.skipped})` : (x.error ?? x.reply ?? '')}`);
    exit(results.every(x => x.ok) ? 0 : 1);
  }

  if(cmd == 'serve') {
    const handle = completions(bridge);

    /* fail now, with the fix, rather than on the first request */
    try {
      await fetch(bridge.url('/json/version'));
    } catch(e) {
      throw new Error(`no browser on CDP ${o.host}:${o.port}, start one with: google-chrome --remote-debugging-port=${o.port} --user-data-dir=$HOME/.chat-bridge-profile`);
    }

    /* loopback only: this endpoint types into logged-in sessions */
    let server;
    try {
      server = serve({
        hostname: '127.0.0.1',
        port: o.listen,
        async fetch(req) {
          const path = new URL(req.url).pathname.replace(/^\/v1/, '');
          if(path == '/models') return json({ object: 'list', data: bridge.models() });
          if(path == '/usage') return json(bridge.usage());
          if(path == '/providers') return json(bridge.providers());
          if(path == '/quota-forecast') return json(bridge.forecast());
          if(path == '/health') return json({ status: 'ok', source: 'chat-bridge', ready: bridge.providers().providers.filter(p => p.status == 'healthy').length });
          if(path == '/chat/completions' && req.method == 'POST') return handle(req);
          if(path == '/check' && req.method == 'POST') {
            /* body { site: name | [names] }, default every site that can be asked now (one real prompt each) */
            const want = [].concat((await req.json().catch(() => ({}))).site ?? Object.keys(ACTIVE));
            const results = [];
            for(const name of want) results.push(await bridge.check(name));
            return json({ object: 'check', source: 'chat-bridge', results });
          }
          return json({ error: { message: 'not found' } }, 404);
        },
      });
    } catch(e) {
      throw new Error(e.code == 'EADDRINUSE' ? `${e.message} (another chat-bridge running? pick another port with --listen)` : e.message);
    }

    for(const sig of [SIGINT, SIGTERM])
      signal(sig, () => bridge.closeAll().finally(() => exit(0)));
    /* --listen 0 = any free port; this line is how a parent finds it */
    console.log(`chat-bridge: http://127.0.0.1:${server.port}/v1 (browser CDP ${o.host}:${o.port})`);
    return new Promise(() => {}); /* run until killed */
  }

  const chat = await bridge.chat(o.site);
  if(cmd == 'eval') console.log(JSON.stringify(await chat.cdp.eval(arg), null, 2));
  else if(cmd == 'read') console.log((await chat.readReply()).text);
  else if(cmd == 'send') {
    if(!arg) throw new Error('send needs a prompt');
    let text = '';
    for await (const t of chat.ask(arg)) text = t;
    console.log(text);
  } else throw new Error(`unknown command ${cmd}`);
}

main().then(
  () => exit(0),
  e => {
    console.log('chat-bridge:', e.message);
    exit(1);
  },
);
