/**
 * exploration: the async exploration of a gateway's READY models. It runs in
 * the background of the REPL's event loop, two models at a time (not in a
 * thread: lws.so is not safe in a second runtime, see run()). Two tiers: tier 0 is one tiny request with a tool
 * offered (does it answer, does it call tools, how fast); tier 1, for the candidates only, sends a fixed synthetic
 * compacted conversation sized to the model's context window (lib/probe-context.js) and checks that it recalls three
 * facts from it with one tool call. The answers are cached in `~/.cache/ollama-repl/exploration.json`.
 *
 * ```js
 * const ex = new Exploration(gateway.origin);
 * ex.run(ids, id => makeClient(id), { onDone: summary => console.log(summary) });   // background, 2 at a time
 * ex.get('kimi-k2');   // { at, ok, toolOk, ms, latencyMs, servedBy, deep, error } or undefined
 * ```
 *
 * One file for everything, all gateways: the key is `ORIGIN|MODEL`.
 *
 * A model is asked only until it passed each tier, the model pinned. Once that is recorded it is never prompted again;
 * what is known about it afterwards comes from other means (setLive(): is the gateway reachable, is the model limited
 * by the usage and quota the gateway reports, did a real request of the session succeed on it). A failed tier 0 is asked
 * again after an hour (a diagnosed one when the diagnosis says), a failed tier 1 after six.
 */
import { loadFile } from 'std';
import { setTimeout, clearTimeout } from 'os';
import { writeConfigFile } from './config.js';
import { cacheDir } from './session-cache.js';
import { probeModel } from './standby.js';
import { buildProbe, grade, plainQuestion } from './probe-context.js';

export const explorationPath = () => `${cacheDir()}/exploration.json`;

const FAIL_TTL_MS = 3600e3;
/** a probe that failed only because the provider was busy or down is asked again after this */
const BUSY_TTL_MS = 10 * 60e3;
const TRANSIENT = /rate.?limit|429|upstream|provider-side|5\d\d\b|timeout|timed out|no response|exhaust|cooldown|quota|model_not_found|unavailable|too many|overloaded|connection|ECONN/i;

/** whether a failed probe says nothing about the model: the provider was rate limited, down or timed out */
export const isTransientProbe = e => !!e && e.ok === false && (e.diagnosis?.transient ?? e.transient ?? TRANSIENT.test(String(e.error ?? '')));

/** one request, aborted after timeoutMs; returns the answer text */
async function ask(client, messages, timeoutMs = 45000, maxTokens = 96) {
  const timer = setTimeout(() => client.abort(), timeoutMs);
  try {
    const r = await client.chat(messages, { max_tokens: maxTokens });
    return { text: String(r.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim(), servedBy: r.meta?.routedVia };
  } finally {
    clearTimeout(timer);
  }
}

/** tier 1 failed for a reason of the model (too big a prompt, lost facts, no tool call) is asked again after this */
const DEEP_RETRY_MS = 6 * 3600e3;

/**
 * Tier 0 and, with `deep` tokens, tier 1.
 *
 * @param {object} client  a client pinned to the model
 * @param {{toolsKnown?: boolean, onStep?: Function, deep?: number, base?: object}} o
 *   deep: send a synthetic context of about this many tokens; base: an earlier passed tier 0 result to build on
 * @returns {Promise<{ok: boolean, toolOk: boolean, ms: number, latencyMs?: number, servedBy?: string, deep?: object, error?: string}>}
 */
export async function probeUsable(client, id, { toolsKnown, onStep, deep = 0, base } = {}) {
  const t0 = Date.now();
  const out = base?.ok ? { ...base } : { ok: false, toolOk: false, ms: 0, v: 3 };

  try {
    if(!out.ok) {
      /* tier 0: one small request with a tool on offer (unless the catalog says there are none) */
      const withTools = toolsKnown !== false;
      onStep?.({ step: 'tier 0', kind: 'ask', text: withTools ? 'call the ping tool with value 7' : 'reply with a word (no tools)' });
      const r = withTools ? await probeModel(client, id, { timeoutMs: 45000 }) : await ask(client, [{ role: 'user', content: 'Reply with the word OK.' }], 45000, 16).then(a => ({ ok: !!a.text, toolOk: false, servedBy: a.servedBy, ...(a.text ? {} : { error: 'empty answer' }) }));
      out.latencyMs = Date.now() - t0;
      out.servedBy = r.servedBy;
      out.toolOk = r.toolOk;
      onStep?.({ step: 'tier 0', kind: 'answer', text: r.ok ? (r.toolOk ? 'called ping' : 'answered, no tool call') : r.error, ok: r.ok, ms: out.latencyMs });
      if(!r.ok) throw new Error(r.error ?? 'empty answer');
      out.ok = true;
    }

    if(deep > 0 && !out.deep) out.deep = await probeDeep(client, deep, out.toolOk && toolsKnown !== false, onStep);
  } catch(e) {
    out.error = (e.detail ?? e.message ?? String(e)).split('\n')[0].slice(0, 160);
    out.transient = TRANSIENT.test(out.error);
    out.ok = false;
  }

  out.ms = Date.now() - t0;
  return out;
}

/** reply budget of the tier 1 probe, and of its one retry after a reply cut off at the limit */
const DEEP_TOKENS = 1500;
const DEEP_RETRY_TOKENS = 3000;

/** tier 1: the synthetic compacted context; the result is `{ ok, tokens, recall, toolCall, ms, tps?, finish?, error?, transient? }` */
async function probeDeep(client, tokens, withTools, onStep) {
  const p = buildProbe(tokens);
  const t = Date.now();
  onStep?.({ step: 'tier 1', kind: 'ask', text: `a compacted context of ~${p.approxTokens} tokens, ${withTools ? 'asks for one tool call that reports three facts from it' : 'asks for three facts from it'}` });

  const timer = setTimeout(() => client.abort(), 120000);
  try {
    /* a reasoning model spends part of the budget on thinking: a reply cut off at the limit (finish length) that already
       recalled the facts but made no tool call is asked once more with a larger budget before it counts as failed */
    const ask1 = async max => {
      const r = await client.chat(withTools ? p.messages : plainQuestion(p), { ...(withTools ? { tools: p.tools, toolChoice: 'auto' } : {}), max_tokens: max });
      return [r, grade({ content: String(r.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, ''), toolCalls: r.toolCalls })];
    };

    let [r, g] = await ask1(DEEP_TOKENS);
    const retried = withTools && g.recall === 3 && !g.toolCall && r.meta?.finish === 'length';
    if(retried) [r, g] = await ask1(DEEP_RETRY_TOKENS);

    const ms = Date.now() - t;
    const done = r.meta?.usage?.completionTokens ?? r.meta?.usage?.completion_tokens;
    const res = { ok: g.recall === 3 && (!withTools || g.toolCall), tokens: p.approxTokens, recall: g.recall, toolCall: g.toolCall, ms, ...(done && ms > 0 ? { tps: Math.round((done / ms) * 1e4) / 10 } : {}), ...(r.meta?.finish ? { finish: r.meta.finish } : {}), ...(retried ? { retried: true } : {}), at: Date.now() };
    onStep?.({ step: 'tier 1', kind: 'answer', text: `${g.recall}/3 facts${withTools ? (g.toolCall ? ', tool call made' : ', no tool call') : ''}${r.meta?.finish ? `, finish ${r.meta.finish}` : ''}`, ok: res.ok, ms });
    return res;
  } catch(e) {
    const error = (e.detail ?? e.message ?? String(e)).split('\n')[0].slice(0, 160);
    const transient = TRANSIENT.test(error) && !/413|too (large|long)|context|maximum|token limit/i.test(error);
    onStep?.({ step: 'tier 1', kind: 'answer', text: error, ok: false, ms: Date.now() - t });
    return { ok: false, tokens: p.approxTokens, recall: 0, toolCall: false, ms: Date.now() - t, error, transient, at: Date.now() };
  } finally {
    clearTimeout(timer);
  }
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
    if(!e) return false;
    if(e.ok) return true;
    /* a failure of the old system-prompt test (before tier 0/1) is asked again */
    if((e.v ?? 1) < 3 && /system prompt/.test(e.error ?? '')) return false;
    /* a diagnosed failure says when it is worth asking again */
    return e.retryAt ? now < e.retryAt : now - e.at < (isTransientProbe(e) ? BUSY_TTL_MS : FAIL_TTL_MS);
  }

  /** whether tier 1 still has to run for a model that passed tier 0: never run, or failed for a transient reason / long ago */
  needsDeep(id, now = Date.now()) {
    const e = this.get(id);
    if(!e?.ok) return false;
    return !e.deep || (!e.deep.ok && (e.deep.transient ? now - e.deep.at > BUSY_TTL_MS : now - e.deep.at > DEEP_RETRY_MS));
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
  run(ids, makeClient, { concurrency = 2, tools = {}, onResult, onDone, onEvent, diagnose, deep = () => 0, force = false } = {}) {
    /* force: probe again whatever is cached (a sweep the user asked for) */
    const todo = ids.filter(id => !this.pending.has(id) && (force || !this.fresh(id) || (deep(id) > 0 && this.needsDeep(id))));
    if(!todo.length) return 0;
    if(!this.pending.size) this.total = this.done = 0;
    for(const id of todo) this.pending.add(id);
    this.total += todo.length;

    const queue = [...todo];
    let usable = 0;

    const lane = async n => {
      let count = 0;
      for(let id; (id = queue.shift()); ) {
        let result;
        const c = makeClient(id);
        onEvent?.(n, id, { type: 'start', queued: queue.length });

        try {
          result = await probeUsable(c, id, { toolsKnown: tools[id], deep: deep(id), base: force ? undefined : this.get(id), onStep: s => onEvent?.(n, id, { type: 'step', ...s }) });
        } catch(e) {
          result = { ok: false, toolOk: false, ms: 0, error: String(e.message).slice(0, 160) };
        } finally {
          c.destroy();
        }

        /* a failure is looked into right here, in the worker: the error text, the gateway's picture of the model, its
           provider and keys, and one more try when it looks like a hiccup */
        if(!result.ok && diagnose && !result.deep) {
          onEvent?.(n, id, { type: 'step', step: 'diagnosis', kind: 'ask', text: 'why did it fail?' });
          const d = await diagnose(id, result).catch(() => null);

          if(d) {
            for(const s of d.steps) onEvent?.(n, id, { type: 'step', step: 'diagnosis', kind: 'known', text: s });
            onEvent?.(n, id, { type: 'step', step: 'diagnosis', kind: 'answer', text: `${d.cause}: ${d.detail}`, ok: d.cause === 'flaky' });
            result = { ...result, diagnosis: d, transient: d.transient, retryAt: Date.now() + d.retryInMs };

            if(d.cause === 'flaky') {
              onEvent?.(n, id, { type: 'step', step: 'diagnosis', kind: 'ask', text: 'running the probe again' });
              const c2 = makeClient(id);
              try {
                const again = await probeUsable(c2, id, { toolsKnown: tools[id], deep: deep(id), onStep: s => onEvent?.(n, id, { type: 'step', ...s }) });
                result = again.ok ? { ...again, recovered: true } : { ...again, diagnosis: d, transient: true, retryAt: Date.now() + BUSY_TTL_MS };
              } catch(e) {
                /* the first failure stands, as diagnosed */
              } finally {
                c2.destroy();
              }
            }
          }
        }

        this.#set(id, { ...result, at: result.at && result.ok ? result.at : Date.now() });
        this.pending.delete(id);
        this.done++;
        if(result.ok) usable++;
        count++;
        onEvent?.(n, id, { type: 'done', result });
        onResult?.(id, result);
      }
      onEvent?.(n, null, { type: 'idle', count });
    };

    Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, (_, n) => lane(n))).then(() => onDone?.({ explored: todo.length, usable }));
    return todo.length;
  }
}

/** a short age: 40s, 5m, 3h */
const now0 = () => Date.now();
/** the short word of a diagnosed cause for the Probe column */
const LABEL = { 'model-gone': 'gone', 'no-key': 'no key', auth: 'auth', 'system-prompt': 'sys', empty: 'empty' };
const age = ms => (ms < 90e3 ? `${Math.round(ms / 1e3)}s` : ms < 5400e3 ? `${Math.round(ms / 60e3)}m` : `${Math.round(ms / 3600e3)}h`);

/** what the other means say about a verified model, as a colored cell, null when nothing is known */
function liveCell(e, now = Date.now()) {
  const l = e.live;
  if(!l) return null;
  if(l.reachable === false) return `\x1b[31m✗ gateway down\x1b[0m \x1b[2m${age(now - l.at)}\x1b[0m`;
  if(l.blocked) return `\x1b[33m⏸ limited${l.kinds?.length ? ` (${l.kinds.join(', ')})` : ''}\x1b[0m`;
  return null;
}

/** what tier 1 found, for the Says column: "12k ctx: 3/3 facts, 41 tok/s" or why it failed */
export function deepText(e) {
  const d = e?.deep;
  if(!d) return '';
  const size = `${Math.round(d.tokens / 1000)}k ctx`;
  if(d.ok) return `\x1b[32m${size}: 3/3 facts${d.tps ? `, ${d.tps} tok/s` : ''}, ${(d.ms / 1000).toFixed(1)}s\x1b[0m`;
  return `\x1b[33m${size}: ${d.error ? d.error.slice(0, 80) : `${d.recall}/3 facts${d.toolCall ? '' : ', no tool call'}`}\x1b[0m`;
}

/** the Probe and Says cells of /model health: a cached result, probing, or not yet probed */
export function probeCells(ex, id) {
  const e = ex?.get(id);
  if(ex?.pending.has(id)) return ['\x1b[36m◌ probing\x1b[0m', ''];
  if(!e) return ['\x1b[2m· not probed\x1b[0m', ''];
  /* a failure: a short marker here and the reason in the Says column (empty for a model that did not answer), same colour, so the text runs on into it */
  const why = String(e.diagnosis ? `${e.diagnosis.cause}: ${e.diagnosis.detail}` : (e.error ?? '')).replace(/\s+/g, ' ');
  if(isTransientProbe(e)) return [`\x1b[33m⚠ busy\x1b[0m \x1b[2m${age(now0() - e.at)} ago\x1b[0m`, `\x1b[33m${why || 'the provider was busy'}\x1b[0m`];
  if(!e.ok) return [`\x1b[31m✗ ${LABEL[e.diagnosis?.cause] ?? 'failed'}\x1b[0m`, `\x1b[31m${why || 'no usable answer'}\x1b[0m`];

  const ms = e.latencyMs ?? e.ms;
  return [liveCell(e) ?? `\x1b[32m✔ usable\x1b[0m ${ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`}${e.toolOk ? ' tools' : '\x1b[2m no tools\x1b[0m'}${e.live?.servedAt ? ` \x1b[2mserved ${age(Date.now() - e.live.servedAt)} ago\x1b[0m` : ''}`, deepText(e)];
}

/** a short Probe cell for the tables of /gateway and /model list: ✔ 1.2s T (tools), ⏸ limited, ✗, ◌ or nothing */
export function probeBrief(ex, key) {
  if(!ex) return '';
  const id = key.includes('/') && !ex.get(key) ? key.slice(key.indexOf('/') + 1) : key;
  if(ex.pending.has(id) || ex.pending.has(key)) return '\x1b[36m◌\x1b[0m';

  const e = ex.find(key);
  if(!e) return '\x1b[2m·\x1b[0m';
  if(isTransientProbe(e)) return '\x1b[33m⚠ busy\x1b[0m';
  if(!e.ok) return `\x1b[31m✗${e.diagnosis?.cause && LABEL[e.diagnosis.cause] ? ` ${LABEL[e.diagnosis.cause].replace('failed', '')}`.trimEnd() : /system prompt/.test(e.error ?? '') ? ' sys' : /empty/.test(e.error ?? '') ? ' empty' : ''}\x1b[0m`;
  if(e.live?.reachable === false) return '\x1b[31m✗ down\x1b[0m';
  if(e.live?.blocked) return '\x1b[33m⏸\x1b[0m';

  const ms = e.latencyMs ?? e.ms;
  return `\x1b[32m✔\x1b[0m ${ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`}${e.toolOk ? ' T' : ''}${e.deep ? (e.deep.ok ? ` \x1b[32m${Math.round(e.deep.tokens / 1000)}k\x1b[0m` : ` ${e.deep.transient ? '\x1b[2m' : '\x1b[33m'}${Math.round(e.deep.tokens / 1000)}k${e.deep.transient ? '?' : '✗'}\x1b[0m`) : ''}`;
}
