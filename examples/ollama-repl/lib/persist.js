/**
 * persist: what the harness learns about the gateways outlives the process, all of it under
 * `~/.cache/ollama-repl/` (lib/session-cache.js):
 *
 * | file              | content                                                          | writer                    |
 * | exploration.json  | what the async exploration found out per model                   | lib/exploration.js        |
 * | ratings.json      | the rating state per model                                       | lib/rating.js             |
 * | usage.jsonl       | one line per request: model, route, tokens, time, error          | appendUsage()             |
 * | quota.json        | the last quota snapshot per gateway (usage, limits, budgets)     | saveQuota()               |
 * | quota.jsonl       | a line per gateway every 15 minutes: the month's use per platform | saveQuota()               |
 * | cooldowns.json    | learned cooldowns and the local shadow blocks                    | lib/availability.js       |
 *
 * ```js
 * appendUsage(origin, session, record);              // after a request
 * readUsage({ origin, sinceMs: 7 * 86400e3 });       // [{ at, model, usage, ... }]
 * saveQuota(origin, { usage, budget, rate });        // throttled, safe to call on every refresh
 * loadQuota(origin);                                 // { at, usage, budget, rate } | null
 * flushPersist();                                    // at exit
 * ```
 *
 * The jsonl files are trimmed at startup (trimLogs): usage.jsonl keeps 90 days, quota.jsonl 180.
 */
import { loadFile, open as fopen } from 'std';
import { setTimeout, clearTimeout } from 'os';
import { writeConfigFile } from './config.js';
import { cacheDir } from './session-cache.js';
import { timed } from './lag.js';

export const usagePath = () => `${cacheDir()}/usage.jsonl`;
export const quotaPath = () => `${cacheDir()}/quota.json`;
export const quotaLogPath = () => `${cacheDir()}/quota.jsonl`;
export const cooldownsPath = () => `${cacheDir()}/cooldowns.json`;

const QUOTA_LOG_EVERY_MS = 15 * 60e3;

/** adds a line to a jsonl file (the directory is made first) */
function appendLine(path, obj) {
  let f = fopen(path, 'a');
  if(!f) {
    writeConfigFile(path, '');
    f = fopen(path, 'a');
  }
  if(!f) return false;
  f.puts(`${JSON.stringify(obj)}\n`);
  f.close();
  return true;
}

/** the lines of a jsonl file, those that parse, those at or after sinceMs (the `at` field) */
function readLines(path, sinceMs = 0) {
  const text = loadFile(path);
  if(!text) return [];
  const out = [];
  for(const line of text.split('\n')) {
    if(!line) continue;
    try {
      const o = JSON.parse(line);
      if((o.at ?? 0) >= sinceMs) out.push(o);
    } catch(e) {}
  }
  return out;
}

/** the part of a request record worth keeping: no messages, no raw usage */
export function usageRow(origin, session, r, label) {
  return {
    at: r.at ?? Date.now(),
    origin,
    session,
    label: label && label !== 'main' ? label : undefined, /* who asked: explore, standby, sub-agent, local fallback; absent for the main client */
    model: r.model,
    requested: r.requested,
    routedVia: r.routedVia,
    platform: r.platform,
    usage: r.usage ? { prompt: r.usage.prompt, completion: r.usage.completion, reasoning: r.usage.reasoning, cached: r.usage.cached, total: r.usage.total } : undefined,
    ms: r.ms,
    ttfbMs: r.ttfbMs,
    fallbacks: r.fallbacks,
    status: r.status,
    proxied: r.proxied ?? undefined, /* true: upstream went through the gateway's socks proxy, false: direct, absent: not known */
    attempt: r.attempt || undefined, /* 0 (the first try) is the default, not written */
    error: r.error ? String(r.error.message ?? r.error).split('\n')[0].slice(0, 160) : undefined,
  };
}

export const appendUsage = (origin, session, r, label) => appendLine(usagePath(), usageRow(origin, session, r, label));

/** @returns {object[]} the usage rows of a gateway origin since sinceMs, oldest first */
export const readUsage = ({ origin, sinceMs = 0 } = {}) => readLines(usagePath(), sinceMs).filter(r => !origin || r.origin === origin);

const snaps = new Map(); /* origin -> the snapshot waiting to be written */
const timers = new Map();
const lastLogged = new Map();

/** the quota snapshot of a gateway, written at most every 20 s; a line of the history every 15 minutes */
export function saveQuota(origin, snap) {
  snaps.set(origin, snap);
  if(timers.has(origin)) return;
  timers.set(origin, setTimeout(() => timed('writeQuota', () => writeQuota(origin)), 20000));
}

function writeQuota(origin) {
  clearTimeout(timers.get(origin));
  timers.delete(origin);
  const snap = snaps.get(origin);
  snaps.delete(origin);
  if(!snap) return;

  const now = Date.now();
  let all = {};
  try {
    all = JSON.parse(loadFile(quotaPath())) ?? {};
  } catch(e) {}
  all[origin] = { at: now, ...snap };
  writeConfigFile(quotaPath(), JSON.stringify(all));

  if(now - (lastLogged.get(origin) ?? 0) >= QUOTA_LOG_EVERY_MS) {
    lastLogged.set(origin, now);
    appendLine(quotaLogPath(), {
      at: now,
      origin,
      month: snap.usage?.month,
      tokens: snap.usage?.tokens,
      requests: snap.usage?.requests,
      byPlatform: snap.usage?.byPlatform,
      budget: snap.budget ? { totalUsed: snap.budget.totalUsed, totalBudget: snap.budget.totalBudget } : undefined,
    });
  }
}

/** @returns {{at: number, usage?: object, budget?: object, rate?: object[]}|null} the last snapshot of a gateway */
export function loadQuota(origin) {
  try {
    return JSON.parse(loadFile(quotaPath()))?.[origin] ?? null;
  } catch(e) {
    return null;
  }
}

/** @returns {object[]} the quota history lines of a gateway since sinceMs */
export const readQuotaLog = ({ origin, sinceMs = 0 } = {}) => readLines(quotaLogPath(), sinceMs).filter(r => !origin || r.origin === origin);

/** writes what is waiting (at exit) */
export function flushPersist() {
  for(const origin of [...snaps.keys()]) writeQuota(origin);
}

/** drops the old lines of the jsonl files; called once at startup */
export function trimLogs(now = Date.now()) {
  for(const [path, days] of [[usagePath(), 90], [quotaLogPath(), 180]]) {
    const text = loadFile(path);
    if(!text) continue;
    const since = now - days * 86400e3;
    const lines = text.split('\n').filter(Boolean);
    const keep = lines.filter(l => {
      try {
        return (JSON.parse(l).at ?? 0) >= since;
      } catch(e) {
        return false;
      }
    });
    if(keep.length !== lines.length) writeConfigFile(path, keep.length ? `${keep.join('\n')}\n` : '');
  }
}
