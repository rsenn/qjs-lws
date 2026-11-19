/**
 * delegates: weaker sub-agent models the primary model can hand bounded jobs
 * to, how they are found, and a memory of which ones were useful.
 *
 * ```js
 * const d = new Delegates();                              // loads ~/.local/state/ollama-repl/delegates.json
 * const list = d.rank('docs', candidates);                // [{id, score, ok, fail, ...}], best first
 * d.record('freellm:gemma-4-31b', 'docs', { ok: true, ms: 8200 });
 * d.vote('freellm:gemma-4-31b', 'docs', -1);              // the user: that one was bad
 * ```
 *
 * Candidates come from the gateway (discoverGateway: enabled, usable now,
 * able to call tools, reliable and fast, but not the strongest ones - those
 * are the primary's) or from the installed Ollama models, plus the ones set
 * by hand (`add`, `pin`). A model is keyed `PROVIDER:MODEL`.
 *
 * Memory, per model and per kind of job (docs, build, summary, repetitive,
 * other): runs that finished and answered (ok), runs that failed or came back
 * empty (fail), the user's votes, the mean time. The rank is the share of
 * good runs with a prior (so one lucky run does not win), votes weigh three
 * runs, and a model never tried gets the prior alone, so new ones are tried
 * now and then. A model that failed three times in a row for a kind is left
 * out of it for a day.
 */
import { loadFile } from 'std';
import { configDir, writeConfigFile } from './config.js';

export const KINDS = ['docs', 'build', 'summary', 'repetitive', 'other'];

const PRIOR = 2; // pseudo-runs of a model nobody has tried: half of them good
const VOTE_WEIGHT = 3;
const STREAK_BENCH = 3;
const BENCH_MS = 24 * 3600_000;

/** the instruction the primary model gets (added to the system prompt) */
export const DELEGATE_NOTES = `

You can hand bounded, low-risk jobs to cheaper sub-agent models with spawn_agent: writing or updating documentation, build-system wiring (CMake, Makefile, package manifests), summarizing files or logs, simple repetitive edits across many files. Give a self-contained task (exact paths, what the result must look like) and set kind to docs, build, summary or repetitive. Leave model empty: the harness picks the model that worked best for that kind in the past. Sub-agents are weaker: read what they return or changed before you rely on it, and do design work, debugging and anything security-relevant yourself.`;

export const stateFile = () => `${configDir()}/delegates.json`;

const blank = () => ({ ok: 0, fail: 0, votes: 0, streak: 0, ms: 0, last: 0, benchedUntil: 0 });

export class Delegates {
  path;
  data = { version: 1, enabled: true, models: {}, pinned: {}, added: [], banned: [] };

  constructor(path = stateFile()) {
    this.path = path;
    this.load();
  }

  load() {
    try {
      const text = loadFile(this.path);
      if(text) this.data = { ...this.data, ...JSON.parse(text) };
    } catch(e) {
      /* no memory yet, or an unreadable one: start empty, the next save replaces it */
    }
  }

  save() {
    return writeConfigFile(this.path, JSON.stringify(this.data, null, 1));
  }

  get enabled() {
    return this.data.enabled !== false;
  }

  set enabled(on) {
    this.data.enabled = !!on;
    this.save();
  }

  #stat(id, kind, create = false) {
    const m = this.data.models[id] ?? (create ? (this.data.models[id] = { kinds: {} }) : null);
    if(!m) return null;
    return m.kinds[kind] ?? (create ? (m.kinds[kind] = blank()) : null);
  }

  /** the memory of one model for one kind */
  stats(id, kind) {
    return this.#stat(id, kind) ?? blank();
  }

  /**
   * @param {string} id
   * @param {string} kind
   * @param {{ok: boolean, ms?: number}} result  ok: it finished and answered
   */
  record(id, kind, { ok, ms = 0 }) {
    const s = this.#stat(id, kind, true);
    const n = s.ok + s.fail;

    if(ok) {
      s.ok++;
      s.streak = 0;
    } else {
      s.fail++;
      s.streak++;
      if(s.streak >= STREAK_BENCH) s.benchedUntil = Date.now() + BENCH_MS;
    }

    s.ms = Math.round((s.ms * n + ms) / (n + 1));
    s.last = Date.now();
    this.save();
  }

  /** the user's verdict on a model's last work: +1 good, -1 bad */
  vote(id, kind, v) {
    const s = this.#stat(id, kind, true);
    s.votes += v;
    if(v > 0) s.benchedUntil = 0;
    this.save();
  }

  /** share of good runs, with the prior; votes count VOTE_WEIGHT runs each */
  score(id, kind) {
    const s = this.stats(id, kind);
    const good = s.ok + Math.max(0, s.votes) * VOTE_WEIGHT + PRIOR / 2;
    const bad = s.fail + Math.max(0, -s.votes) * VOTE_WEIGHT + PRIOR / 2;
    return good / (good + bad);
  }

  /** whether a model may do this kind now: not banned, not benched after failures */
  allowed(id, kind) {
    return !this.data.banned.includes(id) && this.stats(id, kind).benchedUntil < Date.now();
  }

  /**
   * The candidates for a kind, best first: the model pinned for the kind
   * always leads; the rest by score, ties broken by the order given
   * (discovery order: the better ranked by the gateway first) and then by
   * the shorter mean time.
   *
   * @param {string} kind
   * @param {string[]} candidates  ids, in discovery order
   * @returns {{id: string, score: number, ok: number, fail: number, votes: number, ms: number, pinned: boolean, tried: boolean}[]}
   */
  rank(kind, candidates) {
    const pinned = this.data.pinned[kind];
    const ids = [...new Set([...(pinned ? [pinned] : []), ...this.data.added, ...candidates])].filter(id => this.allowed(id, kind) || id === pinned);

    return ids
      .map((id, order) => {
        const s = this.stats(id, kind);
        return { id, order, score: this.score(id, kind), ok: s.ok, fail: s.fail, votes: s.votes, ms: s.ms, pinned: id === pinned, tried: s.ok + s.fail > 0 };
      })
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.score - a.score || a.order - b.order || (a.ms || Infinity) - (b.ms || Infinity));
  }

  add(id, kinds = []) {
    if(!this.data.added.includes(id)) this.data.added.push(id);
    for(const k of kinds) this.data.pinned[k] = id;
    this.data.banned = this.data.banned.filter(b => b !== id);
    this.save();
  }

  remove(id) {
    this.data.added = this.data.added.filter(a => a !== id);
    for(const k of Object.keys(this.data.pinned)) if(this.data.pinned[k] === id) delete this.data.pinned[k];
    this.save();
  }

  pin(kind, id) {
    if(id) this.data.pinned[kind] = id;
    else delete this.data.pinned[kind];
    this.save();
  }

  ban(id, on = true) {
    this.data.banned = this.data.banned.filter(b => b !== id);
    if(on) this.data.banned.push(id);
    this.save();
  }

  forget() {
    this.data.models = {};
    this.save();
  }

  /** every model with a memory, for the report */
  known() {
    return Object.entries(this.data.models).map(([id, m]) => ({ id, kinds: m.kinds }));
  }
}

/**
 * Candidates on a freellmapi gateway: models usable now that can call tools,
 * ranked by reliability and speed, leaving out the strongest ones (the
 * primary's) and the excluded ids. Needs a dashboard session (the routing
 * scores); without one the gateway's own order of ready models is used.
 *
 * @param {import('./freellm.js').Gateway} gateway
 * @param {{byModel: Map<string, object>}|null} av  availability.js result
 * @returns {Promise<string[]>} model ids to pin, best first
 */
export async function discoverGateway(gateway, av, { exclude = [], max = 8 } = {}) {
  const skip = new Set(exclude);
  const ok = id => !skip.has(id) && id !== 'auto' && id !== 'fusion' && !id.startsWith('auto:') && (!av || (av.byModel.get(id)?.blocked === false && av.byModel.get(id)?.status === 'ready'));

  if(av && gateway.dashboard) {
    const [routing, chain] = await Promise.all([gateway.api('/api/fallback/routing').catch(() => null), gateway.api('/api/fallback').catch(() => null)]);
    const rows = new Map((Array.isArray(chain) ? chain : []).map(r => [r.modelDbId, r]));

    const found = (routing?.scores ?? [])
      .filter(s => s.enabled && rows.get(s.modelDbId)?.supportsTools && rows.get(s.modelDbId)?.keyCount && s.reliability >= 0.6 && s.intelligence < 0.95)
      .map(s => ({ id: rows.get(s.modelDbId).canonicalId ?? s.modelId, rank: s.reliability * 0.6 + s.speed * 0.4 }))
      .filter(c => ok(c.id))
      .sort((a, b) => b.rank - a.rank);

    return [...new Set(found.map(c => c.id))].slice(0, max);
  }

  return (await gateway.models()).filter(m => m.execution_status === 'ready' && ok(m.id)).map(m => m.id).slice(0, max);
}

/** one line per known model and kind: 'gemma-4-31b  docs 4 ok 1 failed +1, 7.2s' */
export function memoryLines(d, fmtMs) {
  const rows = [];

  for(const { id, kinds } of d.known())
    for(const [kind, s] of Object.entries(kinds))
      if(s.ok || s.fail || s.votes) rows.push(`${id}  ${kind}: ${s.ok} ok, ${s.fail} failed${s.votes ? `, votes ${s.votes > 0 ? '+' : ''}${s.votes}` : ''}${s.ms ? `, mean ${fmtMs(s.ms)}` : ''}${s.benchedUntil > Date.now() ? ', benched' : ''}`);

  return rows;
}
