/**
 * exploration: the async exploration of a gateway's READY models. It runs in
 * the background of the REPL's event loop, two models at a time (not in a
 * thread: lws.so is not safe in a second runtime, see run()). Each model is asked what it is, whether it obeys a system prompt and
 * whether it calls tools; the answers are cached in
 * `~/.cache/ollama-repl/exploration.json`.
 *
 * ```js
 * const ex = new Exploration(gateway.origin);
 * ex.run(ids, id => makeClient(id), { onDone: summary => console.log(summary) });   // background, 2 at a time
 * ex.get('kimi-k2');   // { at, ok, identity, systemOk, toolOk, ms, servedBy, error } or undefined
 * ```
 *
 * One file for everything, all gateways: the key is `ORIGIN|MODEL`.
 *
 * A model is asked only until it passed: two small requests, the model
 * pinned - "which model are you" and a system prompt that demands one word -
 * and a `ping` tool call only when the gateway's catalog does not say whether
 * it supports tools. Once that is recorded the model is never prompted again;
 * what is known about it afterwards comes from other means (setLive():
 * is the gateway reachable, is the model limited by the usage and quota the
 * gateway reports, did a real request of the session succeed on it). A model
 * that failed its prompts is asked again after an hour.
 */
import { loadFile } from 'std';
import { setTimeout, clearTimeout } from 'os';
import { writeConfigFile } from './config.js';
import { cacheDir } from './session-cache.js';
import { probeModel } from './standby.js';

export const explorationPath = () => `${cacheDir()}/exploration.json`;

const FAIL_TTL_MS = 3600e3;
const WORD = 'PINEAPPLE';

/** one request, aborted after timeoutMs; returns the answer text */
async function ask(client, messages, timeoutMs = 45000) {
  const timer = setTimeout(() => client.abort(), timeoutMs);
  try {
    const r = await client.chat(messages, { max_tokens: 96 });
    return { text: String(r.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim(), servedBy: r.meta?.routedVia };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} client  a client pinned to the model
 * @returns {Promise<{ok: boolean, identity: string, systemOk: boolean, toolOk: boolean, ms: number, servedBy?: string, error?: string}>}
 */
export async function probeUsable(client, id, { toolsKnown } = {}) {
  const t0 = Date.now();
  const out = { ok: false, identity: '', systemOk: false, toolOk: false, ms: 0 };

  try {
    const who = await ask(client, [{ role: 'user', content: 'Which model are you? Answer in one short sentence: model name and vendor.' }]);
    out.latencyMs = Date.now() - t0; /* one plain request: what the model costs per reply */
    out.identity = who.text.replace(/\s+/g, ' ').slice(0, 120);
    out.servedBy = who.servedBy;
    if(!who.text) throw new Error('empty answer');

    const sys = await ask(client, [
      { role: 'system', content: `Answer every message with exactly one word: ${WORD}. Nothing else.` },
      { role: 'user', content: 'Hello, how are you?' },
    ]);
    out.systemOk = sys.text.toUpperCase().includes(WORD) && sys.text.length < 40;

    /* the catalog says whether the model takes tools: then there is nothing to ask */
    out.toolOk = typeof toolsKnown === 'boolean' ? toolsKnown : (await probeModel(client, id, { timeoutMs: 45000 })).toolOk;
    out.ok = out.systemOk;
    if(!out.ok) out.error = `ignores the system prompt (says "${sys.text.slice(0, 40)}")`;
  } catch(e) {
    out.error = (e.detail ?? e.message ?? String(e)).split('\n')[0].slice(0, 160);
  }

  out.ms = Date.now() - t0;
  return out;
}

export class Exploration {
  #origin;
  #data = null;
  /** ids being explored or queued now */
  pending = new Set();

  /** models queued and finished since the pending set was last empty, for a progress indicator */
  total = 0;
  done = 0;

  constructor(origin) {
    this.#origin = origin;
  }

  #load() {
    if(this.#data) return this.#data;
    try {
      this.#data = JSON.parse(loadFile(explorationPath())) ?? {};
    } catch(e) {
      this.#data = {};
    }
    return this.#data;
  }

  #key = id => `${this.#origin}|${id}`;

  get(id) {
    return this.#load()[this.#key(id)];
  }

  /** whether anything is known (or being found out) about this gateway's models */
  get any() {
    return this.pending.size > 0 || Object.keys(this.#load()).some(k => k.startsWith(`${this.#origin}|`));
  }

  /** the result for a model id, or for a `platform/modelId` row of the gateway's limit tables */
  find(key) {
    const direct = this.get(key);
    if(direct) return direct;

    const tail = key.slice(key.indexOf('/') + 1);
    return tail !== key ? this.get(tail) : undefined;
  }

  /** the explored models served by a platform: { ok, bad } */
  byPlatform(platform) {
    const out = { ok: 0, bad: 0 };
    for(const [k, e] of Object.entries(this.#load())) if(k.startsWith(`${this.#origin}|`) && e.servedBy?.startsWith(`${platform}/`)) out[e.ok ? 'ok' : 'bad']++;
    return out;
  }

  /** a model that passed its prompts is never prompted again, one that failed is asked again after an hour */
  fresh(id, now = Date.now()) {
    const e = this.get(id);
    return !!e && (e.ok || now - e.at < FAIL_TTL_MS);
  }

  /** whether the model passed its prompts */
  verified(id) {
    return this.get(id)?.ok === true;
  }

  /**
   * what the other means say about verified models now: `{ id: { at, reachable, blocked, kinds, until, servedAt, servedMs } }`;
   * one write
   */
  setLive(states) {
    const data = this.#load();
    let n = 0;

    for(const [id, live] of Object.entries(states)) {
      const e = data[this.#key(id)];
      if(e?.ok) {
        e.live = live;
        n++;
      }
    }

    if(n) writeConfigFile(explorationPath(), JSON.stringify(data, null, 1));
  }

  #set(id, entry) {
    this.#load()[this.#key(id)] = entry;
    writeConfigFile(explorationPath(), JSON.stringify(this.#data, null, 1));
  }

  /**
   * explores the `ids` that have no fresh result, `concurrency` at a time, in the background of the REPL's own
   * event loop (not a thread: lws.so keeps its class prototypes in statics, a second runtime loading it breaks
   * the requests of the first, see BUGS lws-statics-not-multi-runtime)
   *
   * @param {(id: string) => object} makeClient  a client pinned to the model; destroyed after its probe
   * @param {{concurrency?: number, tools?: object, onResult?: (id: string, result: object) => void, onDone?: (s: {explored: number, usable: number}) => void}} o
   *   tools: model id -> whether the catalog says it takes tools
   * @returns {number} how many were queued
   */
  run(ids, makeClient, { concurrency = 2, tools = {}, onResult, onDone } = {}) {
    const todo = ids.filter(id => !this.pending.has(id) && !this.fresh(id));
    if(!todo.length) return 0;
    if(!this.pending.size) this.total = this.done = 0;
    for(const id of todo) this.pending.add(id);
    this.total += todo.length;

    const queue = [...todo];
    let usable = 0;

    const lane = async () => {
      for(let id; (id = queue.shift()); ) {
        let result;
        const c = makeClient(id);

        try {
          result = await probeUsable(c, id, { toolsKnown: tools[id] });
        } catch(e) {
          result = { ok: false, identity: '', systemOk: false, toolOk: false, ms: 0, error: String(e.message).slice(0, 160) };
        } finally {
          c.destroy();
        }

        this.#set(id, { ...result, at: Date.now() });
        this.pending.delete(id);
        this.done++;
        if(result.ok) usable++;
        onResult?.(id, result);
      }
    };

    Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, lane)).then(() => onDone?.({ explored: todo.length, usable }));
    return todo.length;
  }
}

/** a short age: 40s, 5m, 3h */
const age = ms => (ms < 90e3 ? `${Math.round(ms / 1e3)}s` : ms < 5400e3 ? `${Math.round(ms / 60e3)}m` : `${Math.round(ms / 3600e3)}h`);

/** what the other means say about a verified model, as a colored cell, null when nothing is known */
function liveCell(e, now = Date.now()) {
  const l = e.live;
  if(!l) return null;
  if(l.reachable === false) return `\x1b[31m✗ gateway down\x1b[0m \x1b[2m${age(now - l.at)}\x1b[0m`;
  if(l.blocked) return `\x1b[33m⏸ limited${l.kinds?.length ? ` (${l.kinds.join(', ')})` : ''}\x1b[0m`;
  return null;
}

/** the Probe and Says cells of /model health: a cached result, probing, or not yet probed */
export function probeCells(ex, id) {
  const e = ex?.get(id);
  if(ex?.pending.has(id)) return ['\x1b[36m◌ probing\x1b[0m', ''];
  if(!e) return ['\x1b[2m· not probed\x1b[0m', ''];
  if(!e.ok) return [`\x1b[31m✗ ${e.error ?? 'failed'}\x1b[0m`, ''];

  const ms = e.latencyMs ?? e.ms;
  return [liveCell(e) ?? `\x1b[32m✔ usable\x1b[0m ${ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`}${e.toolOk ? ' tools' : '\x1b[2m no tools\x1b[0m'}${e.live?.servedAt ? ` \x1b[2mserved ${age(Date.now() - e.live.servedAt)} ago\x1b[0m` : ''}`, e.identity];
}

/** a short Probe cell for the tables of /gateway and /model list: ✔ 1.2s T (tools), ⏸ limited, ✗, ◌ or nothing */
export function probeBrief(ex, key) {
  if(!ex) return '';
  const id = key.includes('/') && !ex.get(key) ? key.slice(key.indexOf('/') + 1) : key;
  if(ex.pending.has(id) || ex.pending.has(key)) return '\x1b[36m◌\x1b[0m';

  const e = ex.find(key);
  if(!e) return '\x1b[2m·\x1b[0m';
  if(!e.ok) return '\x1b[31m✗\x1b[0m';
  if(e.live?.reachable === false) return '\x1b[31m✗ down\x1b[0m';
  if(e.live?.blocked) return '\x1b[33m⏸\x1b[0m';

  const ms = e.latencyMs ?? e.ms;
  return `\x1b[32m✔\x1b[0m ${ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`}${e.toolOk ? ' T' : ''}`;
}
