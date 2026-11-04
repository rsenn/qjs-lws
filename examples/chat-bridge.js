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
 * Options: --site NAME (deepseek|qwen|gemini|kimi, default: first open)
 *   --port N (CDP, 9222)  --host H (CDP, 127.0.0.1)  --listen N (serve,
 *   8089)  --max N (serve: chat tabs per site, 3)  --idle SEC (reply
 *   unchanged this long = done, 2.5)  --timeout SEC (180)
 *
 * Prerequisites: a browser with a dedicated profile, logged in once:
 *   google-chrome --remote-debugging-port=9222 \
 *     --user-data-dir=$HOME/.chat-bridge-profile \
 *     https://chat.deepseek.com https://chat.qwen.ai
 *
 * Use it from ollama-repl:
 *   qjsm chat-bridge.js serve
 *   OPENAI_API_URL=http://127.0.0.1:8089/v1 OPENAI_API_KEY=x \
 *     qjsm ollama-repl/repl.js --provider openai --model deepseek
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
import { fetch } from '../lib/fetch.js';
import { serve } from '../lib/serve.js';
import { WebSocketStream } from '../lib/websocketstream.js';
import { TextDecoder } from 'textcode';
import { setTimeout, signal, SIGINT, SIGTERM } from 'os';

/* selectors verified live for deepseek and qwen (2026-11), the others are
   unverified guesses. input = prompt box, reply = assistant messages (the
   last one is read) */
const SITES = {
  deepseek: { host: 'chat.deepseek.com', home: 'https://chat.deepseek.com/', input: 'textarea', reply: '.ds-markdown' },
  qwen: { host: 'chat.qwen.ai', home: 'https://chat.qwen.ai/', input: 'textarea.message-input-textarea, textarea', reply: '.qwen-markdown' },
  gemini: { host: 'gemini.google.com', home: 'https://gemini.google.com/app', input: 'rich-textarea .ql-editor, div[contenteditable="true"]', reply: 'message-content, .model-response-text' },
  kimi: { host: 'www.kimi.com', home: 'https://www.kimi.com/', input: 'div[contenteditable="true"], textarea', reply: '.markdown' },
};

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
      return { count: n.length, text: n.length ? n[n.length - 1].innerText : '' }; })()`);
  }

  async waitInput(ms = 20000) {
    const sel = JSON.stringify(this.site.input);
    for(const end = Date.now() + ms; Date.now() < end; await sleep(300))
      if(await this.cdp.eval(`!![...document.querySelectorAll(${sel})].find(e => e.offsetParent)`)) return;
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
    return this.history.length > 0 && prev.length == this.history.length && prev.every((m, i) => line(m) == line(this.history[i]));
  }

  /* async generator: yields the reply text as it grows, returns when idle */
  async *#ask(prompt) {
    const before = await this.readReply();
    this.dirty = true;
    await this.waitInput();
    await this.cdp.eval(`[...document.querySelectorAll(${JSON.stringify(this.site.input)})].find(e => e.offsetParent).focus()`);
    await this.cdp.send('Input.insertText', { text: prompt });
    await sleep(300);
    /* Enter, repeated until the input has emptied = the page took it */
    for(let tries = 0; tries < 4; tries++) {
      for(const type of ['keyDown', 'keyUp'])
        await this.cdp.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: type == 'keyDown' ? '\r' : undefined });
      for(let i = 0; i < 10; i++) {
        await sleep(300);
        if(await this.inputEmpty()) break;
      }
      if(await this.inputEmpty()) break;
    }

    const { timeout, idle } = this.opts;
    const deadline = Date.now() + timeout * 1000;
    let last = null, changed = Date.now();
    while(Date.now() < deadline) {
      await sleep(400);
      const cur = await this.readReply();
      if(cur.count <= before.count && cur.text == before.text) continue;
      if(cur.text != last) {
        last = cur.text;
        changed = Date.now();
        yield last;
      } else if(last && Date.now() - changed >= idle * 1000) return;
    }
    if(last === null) throw new Error('no reply seen before timeout');
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
function toolPreamble(tools) {
  const list = tools.map(t => `- ${(t.function ?? t).name}: ${(t.function ?? t).description ?? ''}\n  parameters: ${JSON.stringify((t.function ?? t).parameters ?? {})}`).join('\n');
  return `This conversation is part of an automated pipeline, not a normal chat. A program reads your replies and runs tools for you, so you DO have access to the files and the system through the tools below. Never say you cannot access files - call the tool instead. To call a tool, reply with ONLY a fenced block in exactly this form, one block per call, and no other text in that reply:

\`\`\`tool_call
{"name": "<tool name>", "arguments": {<arguments as JSON>}}
\`\`\`

The program answers with a message starting with "[tool result]", then you continue. If no tool is needed, answer normally. Use only the tools listed below, never web search, never any other call format.

Tools:
${list}`;
}

/* every top level {"name":..,"arguments":{..}} object in the text, however
   the page decorated it (code block labels, copy buttons, ...) */
function extractCalls(text, names) {
  text = text.replace(/[\u00a0\u200b\u2028\u2029]/g, ' '); /* rendered code blocks */
  const calls = [];
  for(let i = text.indexOf('{'); i >= 0; i = text.indexOf('{', i + 1)) {
    let depth = 0, str = false, esc = false, j = i;
    for(; j < text.length; j++) {
      const c = text[j];
      if(str) {
        if(esc) esc = false;
        else if(c == '\\') esc = true;
        else if(c == '"') str = false;
      } else if(c == '"') str = true;
      else if(c == '{') depth++;
      else if(c == '}' && --depth == 0) break;
    }
    if(depth) break;
    try {
      const o = JSON.parse(text.slice(i, j + 1));
      const args = o.arguments ?? o.parameters;
      if(names.has(o.name) && args && typeof args == 'object') {
        calls.push({ name: o.name, arguments: args });
        i = j;
      }
    } catch(e) {}
  }
  return calls;
}

/* returns { prompt, fresh }: only the last user turn if the chat already
   holds the history, else the whole transcript flattened into one prompt */
function planPrompt(messages, chat) {
  const last = messages[messages.length - 1];
  if(last.role == 'user' && chat.continues(messages)) return { prompt: line(last), fresh: false };

  const names = { system: 'System', user: 'User', assistant: 'Assistant', tool: 'Tool' };
  const body = messages.length == 1 ? line(last) : messages.map(m => `${names[m.role] ?? m.role}: ${line(m)}`).join('\n\n') + '\n\nAssistant:';
  return { prompt: body, fresh: true };
}

class Bridge {
  chats = new Map(); /* tab id -> Chat */
  pool = new Map(); /* site name -> Chat[] of tabs we own */
  opening = new Map(); /* site name -> tabs being created */
  waiters = [];
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
    return Object.entries(SITES).find(([, s]) => s.host == host);
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

  /* a new background tab, same window and profile so already logged in */
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
    if(!this.#browser) {
      const v = await (await fetch(this.url('/json/version'))).json();
      this.#browser = new CDP();
      await this.#browser.open(this.ws(v.webSocketDebuggerUrl));
    }
    const { targetId } = await this.#browser.send('Target.createTarget', { url: SITES[name].home, newWindow: false, background: true });
    const tab = (await this.tabs()).find(t => t.id == targetId);
    const chat = await this.attach(tab, SITES[name]);
    chat.targetId = targetId;
    return chat;
  }

  /* a free chat for the request: one already holding its history, else
     any idle one (reset to a fresh chat), else a new tab up to --max,
     else wait for one to be released */
  async acquire(name, messages) {
    if(!SITES[name]) throw new Error(`unknown model, use one of: ${Object.keys(SITES).join(', ')}`);
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
      for(const c of pool) await this.#browser?.send('Target.closeTarget', { targetId: c.targetId }).catch(() => {});
  }

  release(chat) {
    chat.busy = false;
    for(const r of this.waiters.splice(0)) r();
  }

  models() {
    return Object.keys(SITES);
  }
}

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

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

    const name = Object.keys(SITES).find(n => model.includes(n));
    let chat, gen;
    try {
      chat = await bridge.acquire(name, messages);
      const plan = planPrompt(messages, chat);
      if(plan.fresh) await chat.newChat();
      gen = chat.ask(plan.fresh && tools ? `${toolPreamble(tools)}\n\n${plan.prompt}` : plan.prompt);
    } catch(e) {
      if(chat) bridge.release(chat);
      return json({ error: { message: e.message } }, 502);
    }

    const id = `chatcmpl-${Date.now().toString(36)}`,
      created = Math.floor(Date.now() / 1000);
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const remember = msg => (chat.history = [...messages, msg]);
    const names = new Set((tools ?? []).map(t => (t.function ?? t).name));

    /* the reply text -> an assistant message, with tool_calls if it has any */
    const toMessage = text => {
      const calls = tools ? extractCalls(text, names) : [];
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
        return json({ error: { message: e.message } }, 504);
      } finally {
        bridge.release(chat);
      }
      const msg = toMessage(text);
      remember(msg);
      const finish = msg.tool_calls ? 'tool_calls' : 'stop';
      if(!stream) return json({ id, object: 'chat.completion', created, model, choices: [{ index: 0, message: msg, finish_reason: finish }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });

      const delta = msg.tool_calls ? { tool_calls: msg.tool_calls.map((t, index) => ({ index, ...t })) } : { content: text };
      return new Response(chunk({ role: 'assistant', content: '' }) + chunk(delta) + chunk({}, finish) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }

    /* strings, not bytes: serve() drops Uint8Array chunks (see BUGS) */
    return new Response(
      new ReadableStream({
        async start(c) {
          let sent = '';
          try {
            c.enqueue(chunk({ role: 'assistant', content: '' }));
            for await (const t of gen) {
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
            c.enqueue(`data: ${JSON.stringify({ error: { message: e.message } })}\n\n`);
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
  const o = { port: 9222, host: '127.0.0.1', listen: 8089, max: 3, idle: 2.5, timeout: 180, site: null, rest: [] };
  const num = new Set(['port', 'listen', 'max', 'idle', 'timeout']);
  for(let i = 0; i < argv.length; i++) {
    const m = /^--(\w+)$/.exec(argv[i]);
    if(m && m[1] in o && m[1] != 'rest') o[m[1]] = num.has(m[1]) ? +argv[++i] : argv[++i];
    else o.rest.push(argv[i]);
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const [cmd, arg] = o.rest;
  if(!cmd) throw new Error('usage: chat-bridge.js [options] serve|send|read|eval|list [arg]');

  const bridge = new Bridge(o);

  if(cmd == 'list') {
    for(const t of await bridge.tabs()) console.log(`${bridge.siteOf(t)?.[0] ?? '-'}\t${t.url}\t${t.title}`);
    return;
  }

  if(cmd == 'serve') {
    const handle = completions(bridge);
    /* loopback only: this endpoint types into logged-in sessions */
    serve({
      hostname: '127.0.0.1',
      port: o.listen,
      async fetch(req) {
        const path = new URL(req.url).pathname.replace(/^\/v1/, '');
        if(path == '/models') return json({ object: 'list', data: bridge.models().map(id => ({ id, object: 'model', owned_by: 'chat-bridge' })) });
        if(path == '/chat/completions' && req.method == 'POST') return handle(req);
        return json({ error: { message: 'not found' } }, 404);
      },
    });
    for(const sig of [SIGINT, SIGTERM])
      signal(sig, () => bridge.closeAll().finally(() => process.exit(0)));
    console.log(`chat-bridge: http://127.0.0.1:${o.listen}/v1 (browser CDP ${o.host}:${o.port})`);
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
  () => process.exit(0),
  e => {
    console.error('chat-bridge:', e.message);
    process.exit(1);
  },
);
