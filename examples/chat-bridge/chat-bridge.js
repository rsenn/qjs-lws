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
import { setTimeout, signal, SIGINT, SIGTERM, mkdir } from 'os';
import { getenv, exit, loadFile, open as fopen } from 'std';

/* selectors verified live (2026-11) for deepseek, qwen, gemini, kimi,
   chatgpt (logged out layout), duck, deepai and openrouter. mistral too (answer part). 
   unverified guess: its chat redirects to a login in the test browser.
   a `skip` reason marks a site that was looked at and deliberately not
   adopted (see ACTIVE below). input = prompt box, reply = assistant messages (the
   last one is read) */
const SITES = {
  deepseek: { host: 'chat.deepseek.com', home: 'https://chat.deepseek.com/', input: 'textarea', reply: '.ds-markdown' },
  qwen: { host: 'chat.qwen.ai', home: 'https://chat.qwen.ai/', input: 'textarea.message-input-textarea, textarea', reply: '.qwen-markdown' },
  gemini: { host: 'gemini.google.com', home: 'https://gemini.google.com/app', input: 'rich-textarea .ql-editor, div[contenteditable="true"]', reply: 'message-content, .model-response-text' },
  kimi: { host: 'www.kimi.ai', home: 'https://www.kimi.ai/chat/', input: 'div[contenteditable="true"], textarea', reply: '.markdown' },
  mistral: { host: 'chat.mistral.ai', home: 'https://chat.mistral.ai/chat', input: 'textarea, div[contenteditable="true"]', reply: '[data-message-part-type="answer"]' },
  chatgpt: { host: 'chatgpt.com', home: 'https://chatgpt.com/', input: '#prompt-textarea, #mobile-composer-prompt, div.ProseMirror[contenteditable="true"]', reply: '[data-message-author-role="assistant"], li[data-message-role="assistant"], [data-markdown-text-style="assistant-message"]' },
  venice: { host: 'venice.ai', home: 'https://venice.ai/chat', input: 'textarea', reply: '.prose', skip: 'no reply read in a test (anonymous use is rate-limited and gated), so not worth the fragility' },
  duck: { host: 'duck.ai', home: 'https://duck.ai/chat', maxPrompt: 16000, input: 'textarea', reply: 'div.space-y-4.whitespace-normal' },
  deepai: { host: 'deepai.org', home: 'https://deepai.org/chat', input: '#persistentChatbox', reply: '.markdownContainer' },
  openrouter: { host: 'openrouter.ai', home: 'https://openrouter.ai/chat', input: 'textarea', reply: '[data-message-bubble="assistant"]', billing: 'metered' },
  aistudio: { host: 'aistudio.google.com', home: 'https://aistudio.google.com/prompts/new_chat', input: 'textarea', reply: 'ms-text-chunk', billing: 'metered', skip: 'free Gemini API key exists, and gemini is already covered by the gemini site' },
  groq: { host: 'console.groq.com', home: 'https://console.groq.com/playground', input: 'textarea', reply: '.prose', billing: 'metered', skip: 'API playground behind a login, not a chat, and groq has an OpenAI-compatible API' },
};

/* extra sites (tests, private deployments): $CHAT_BRIDGE_SITES names a JSON
   file { name: { host, home, input, reply, ... } } merged over SITES */
if(getenv('CHAT_BRIDGE_SITES')) Object.assign(SITES, JSON.parse(loadFile(getenv('CHAT_BRIDGE_SITES')) ?? '{}'));

/* every site has a billing class, default 'free': a consumer chat that can
   only cost money if a human clicks Upgrade (the bridge never clicks
   anything but the prompt box). 'metered' = pay-as-you-go credits or an
   API-style account that charges by use: refused unless the bridge was
   started with --allow-paid (or CHAT_BRIDGE_ALLOW_PAID=1) */
/* sites with a `skip` reason were looked at and deliberately not adopted:
   kept here so they are not evaluated again, but never served or matched */
const ACTIVE = Object.fromEntries(Object.entries(SITES).filter(([, s]) => !s.skip));

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

  async newChat() {
    if(this.dirty) {
      await this.cdp.send('Page.navigate', { url: this.site.home });
      await sleep(500);
      await this.waitInput();
      this.dirty = false;
    }
    this.history = [];
  }

  /* true if the open chat already holds exactly the request's history */
  continues(messages) {
    const prev = messages.slice(0, -1);
    /* a tool result is not compared: a client that clips old results to
       save context (ollama-repl does) must not make every round a new chat,
       the open chat saw the real result already */
    return this.history.length > 0 && prev.length == this.history.length && prev.every((m, i) => m.role == this.history[i].role && (m.role == 'tool' || line(m) == line(this.history[i])));
  }

  /* async generator: yields the reply text as it grows, returns when idle */
  async *#ask(prompt) {
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

    const { timeout, idle } = this.opts;
    const deadline = Date.now() + timeout * 1000;
    let last = null, changed = Date.now();
    while(Date.now() < deadline) {
      await sleep(400);
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
  ask(prompt) {
    const prev = this.#tail;
    let release;
    this.#tail = new Promise(r => (release = r));
    return (async function* (self) {
      await prev;
      try {
        yield* self.#ask(prompt);
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
function planPrompt(messages, chat) {
  const last = messages[messages.length - 1];
  if(last.role == 'user' && chat.continues(messages)) return { prompt: line(last), fresh: false };

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

class Bridge {
  chats = new Map(); /* tab id -> Chat */
  pool = new Map(); /* site name -> Chat[] of tabs we own */
  opening = new Map(); /* site name -> tabs being created */
  waiters = [];
  cooldown = new Map(); /* site name -> { until (ms), err } for a refusing site */
  #browser;
  #opening = Promise.resolve();

  constructor(o) {
    this.o = o;
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
  async acquire(name, messages) {
    if(!ACTIVE[name]) throw new Error(`unknown model, use one of: ${Object.keys(ACTIVE).join(', ')}`);
    for(;;) {
      if(!this.pool.has(name)) this.pool.set(name, []);
      const pool = this.pool.get(name); /* same array throughout, open() awaits */
      for(let i = pool.length; i-- > 0; ) if(pool[i].cdp.closed) pool.splice(i, 1);
      const free = pool.filter(c => !c.busy);
      let chat = free.find(c => c.continues(messages)) ?? free[0];
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
    this.cooldown.delete(name);
  }

  refused(name, err) {
    if(err.retry) this.cooldown.set(name, { until: Date.now() + err.retry * 1000, err });
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

  models() {
    return Object.keys(ACTIVE).map(id => {
      const c = this.cooling(id);
      const billing = ACTIVE[id].billing ?? 'free';
      const guarded = billing == 'metered' && !this.o.allowPaid;
      return { id, object: 'model', owned_by: 'chat-bridge', billing, ...(ACTIVE[id].maxPrompt ? { max_prompt_chars: ACTIVE[id].maxPrompt } : {}), available: !c && !guarded, ...(guarded ? { unavailable: 'billing_guard' } : c ? { unavailable: c.err.kind, resets_at: new Date(c.until).toISOString() } : {}) };
    });
  }
}

const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...headers } });

/* the OpenAI error shape for a refusing site; clients read the status, `code` and Retry-After */
function refusalResponse(err, retry = err.retry) {
  const r = REFUSALS[err.kind] ?? REFUSALS.not_accepted;
  return json({ error: { message: err.message, type: r.type, code: r.code, param: null } }, r.status, retry ? { 'retry-after': String(Math.ceil(retry)) } : {});
}

function completions(bridge) {
  return async req => {
    let body;
    try {
      body = await req.json();
    } catch(e) {
      return json({ error: { message: 'invalid JSON' } }, 400);
    }
    const { messages, stream, model = '' } = body;
    const tools = body.tools?.length ? body.tools : null;
    if(!messages?.length) return json({ error: { message: 'messages required' } }, 400);

    const name = Object.keys(ACTIVE).find(n => model.includes(n));
    if(ACTIVE[name]?.billing == 'metered' && !bridge.o.allowPaid)
      return refusalResponse(new SiteRefusal('billing', `${name} is pay-as-you-go and can cost money, so the bridge refuses it; start the bridge with --allow-paid to use it anyway`));

    const cool = bridge.cooling(name);
    if(cool) return refusalResponse(cool.err, (cool.until - Date.now()) / 1000);

    let chat, gen;
    try {
      chat = await bridge.acquire(name, messages);
      const plan = planPrompt(messages, chat);
      if(plan.fresh) await chat.newChat();
      const body = tools ? plan.prompt + TOOL_REMINDER : plan.prompt;
      const full = plan.fresh && tools ? `${toolPreamble(tools)}\n\n${body}` : body;
      const max = ACTIVE[name]?.maxPrompt;
      if(max && full.length > max) {
        bridge.release(chat);
        return json({ error: { message: `${name} takes at most ${max} characters per message, this prompt has ${full.length}`, type: 'invalid_request_error', code: 'context_length_exceeded' } }, 400);
      }
      gen = chat.ask(full);
    } catch(e) {
      if(chat) bridge.release(chat);
      return json({ error: { message: e.message } }, 502);
    }

    const id = `chatcmpl-${Date.now().toString(36)}`,
      created = Math.floor(Date.now() / 1000);
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const remember = msg => (chat.history = [...messages, msg]);

    /* the reply text -> an assistant message, with tool_calls if it has any */
    const toMessage = text => {
      const calls = tools ? extractCalls(text, tools) : [];
      if(!calls.length) return { role: 'assistant', content: text };
      return { role: 'assistant', content: null, tool_calls: calls.map((c, i) => ({ id: `call_${id}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) };
    };

    /* tool calls can only be told apart once the reply is complete, so a
       request with tools is answered whole even when streaming was asked */
    if(!stream || tools) {
      let text = '';
      try {
        for await (const t of gen) text = t;
      } catch(e) {
        chat.history = [];
        if(e instanceof SiteRefusal) {
          bridge.refused(name, e);
          return refusalResponse(e);
        }
        return json({ error: { message: e.message } }, 504);
      } finally {
        await recordChat(ACTIVE[name], name, chat).catch(() => {});
        bridge.release(chat);
      }
      const msg = toMessage(text);
      remember(msg);
      const finish = msg.tool_calls ? 'tool_calls' : 'stop';
      if(!stream) return json({ id, object: 'chat.completion', created, model, choices: [{ index: 0, message: msg, finish_reason: finish }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });

      const delta = msg.tool_calls ? { tool_calls: msg.tool_calls.map((t, index) => ({ index, ...t })) } : { content: text };
      return new Response(chunk({ role: 'assistant', content: '' }) + chunk(delta) + chunk({}, finish) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }

    /* wait for the first reply text, so a refusal can still be a real
       HTTP status instead of an error event in the middle of a stream */
    let first;
    try {
      first = await gen.next();
    } catch(e) {
      chat.history = [];
      bridge.release(chat);
      if(e instanceof SiteRefusal) {
        bridge.refused(name, e);
        return refusalResponse(e);
      }
      return json({ error: { message: e.message } }, 504);
    }
    const replies = (async function* () {
      if(!first.done) yield first.value;
      yield* gen;
    })();

    /* strings, not bytes: serve() drops Uint8Array chunks (see BUGS) */
    return new Response(
      new ReadableStream({
        async start(c) {
          let sent = '';
          try {
            c.enqueue(chunk({ role: 'assistant', content: '' }));
            for await (const t of replies) {
              /* only append-only growth is streamable, a rewrite waits */
              if(t.length > sent.length && t.startsWith(sent)) {
                c.enqueue(chunk({ content: t.slice(sent.length) }));
                sent = t;
              }
            }
            remember({ role: 'assistant', content: sent });
            c.enqueue(chunk({}, 'stop') + 'data: [DONE]\n\n');
          } catch(e) {
            chat.history = [];
            if(e instanceof SiteRefusal) bridge.refused(name, e);
            c.enqueue(`data: ${JSON.stringify({ error: { message: e.message, ...(REFUSALS[e.kind] ? { type: REFUSALS[e.kind].type, code: REFUSALS[e.kind].code } : {}) } })}\n\n`);
          }
          bridge.release(chat);
          c.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } },
    );
  };
}

function parseArgs(argv) {
  const o = { port: 9222, host: '127.0.0.1', listen: 8089, max: 3, idle: 2.5, timeout: 180, site: null, allowPaid: getenv('CHAT_BRIDGE_ALLOW_PAID') == '1', newTabs: false, rest: [] };
  const num = new Set(['port', 'listen', 'max', 'idle', 'timeout']);
  for(let i = 0; i < argv.length; i++) {
    if(argv[i] == '--allow-paid') {
      o.allowPaid = true;
      continue;
    }
    if(argv[i] == '--new-tabs') {
      o.newTabs = true;
      continue;
    }
    const m = /^--(\w+)$/.exec(argv[i]);
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
          if(path == '/chat/completions' && req.method == 'POST') return handle(req);
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
