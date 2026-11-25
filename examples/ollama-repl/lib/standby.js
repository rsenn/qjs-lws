/**
 * standby: a second model of a freellmapi gateway, probed and warm, ready to
 * take over when the current one fails or to run a sub-agent.
 *
 * ```js
 * const next = await pickNext(gateway, availability, { exclude: ['kimi-k2'] });  // { id, platform, name, score }
 * const r = await probeModel(makeClient(next.id), next.id);                      // { ok, toolOk, ms, servedBy, error }
 * ```
 *
 * The next model is the one the gateway itself would prefer after the
 * current one: its routing scores (/api/fallback/routing, best first), only
 * models that are enabled, have a key and are usable now (availability.js),
 * without the excluded ones. Without a dashboard session the order of
 * /v1/models decides (usable first, then smartest).
 *
 * The probe is one small request with the model pinned: it must answer, and
 * a tool call for a `ping` tool shows whether the model can drive the
 * harness at all (a model without tool calls still works as a plain
 * chat standby). The request also warms the gateway's connection and key
 * selection for that model.
 */

import { setTimeout, clearTimeout } from 'os';

/** the tool the probe offers */
const PING = { name: 'ping', description: 'Reports that the model can call tools.', parameters: { type: 'object', properties: { value: { type: 'integer', description: 'the number to report' } }, required: ['value'] } };

/**
 * The model the gateway would use after the excluded ones.
 *
 * @param {import('./freellm.js').Gateway} gateway
 * @param {{byModel: Map<string, object>}|null} av  loadAvailability() result, null without a dashboard session
 * @param {{exclude?: string[], allowed?: (id: string) => boolean, rate?: (id: string) => number|null}} opts  model ids, or platform/modelId of a row, not to pick; allowed limits the choice (a key selection); rate: the best rating wins, else the gateway's routing order
 * @returns {Promise<{id: string, platform?: string, name: string, score?: number}|null>}
 */
export async function pickNext(gateway, av, { exclude = [], allowed = () => true, rate = () => null } = {}) {
  const skip = new Set(exclude);
  const usable = id => allowed(id) && !skip.has(id) && id !== 'auto' && id !== 'fusion' && !id.startsWith('auto:') && (av ? av.byModel.get(id)?.blocked === false : true);

  if(av && gateway.dashboard) {
    const [routing, chain] = await Promise.all([gateway.api('/api/fallback/routing').catch(() => null), gateway.api('/api/fallback').catch(() => null)]);
    const idOf = new Map((Array.isArray(chain) ? chain : []).map(r => [r.modelDbId, r.canonicalId ?? r.modelId]));
    const scores = (routing?.scores ?? []).filter(s => s.enabled).sort((a, b) => b.score - a.score);

    const found = [];
    for(const s of scores) {
      const id = idOf.get(s.modelDbId) ?? s.modelId;
      const e = av.byModel.get(id);
      if(skip.has(`${s.platform}/${s.modelId}`)) continue;
      if(usable(id) && e?.status === 'ready' && e.platforms.length) found.push({ id, platform: s.platform, name: s.displayName, score: s.score, rating: rate(id) });
    }

    /* the best rating wins, the gateway's own order (its routing score) breaks ties and decides without ratings */
    if(found.length) return found.reduce((best, c) => ((c.rating ?? -1) > (best.rating ?? -1) ? c : best));
  }

  /* /v1/models lists the models that can serve a request first, the smartest first */
  const listed = (await gateway.models()).filter(m => m.execution_status === 'ready' && m.capabilities?.tools !== false && usable(m.id));
  if(listed.length) return listed.map(m => ({ id: m.id, name: m.name ?? m.id, rating: rate(m.id) })).reduce((best, c) => ((c.rating ?? -1) > (best.rating ?? -1) ? c : best));

  return null;
}

/**
 * One pinned request to `id` through `client` (a client whose model is `id`).
 *
 * @returns {Promise<{ok: boolean, toolOk: boolean, ms: number, servedBy?: string, error?: string}>}
 */
export async function probeModel(client, id, { timeoutMs = 45000 } = {}) {
  const t0 = Date.now();
  const timer = setTimeout(() => client.abort(), timeoutMs);

  try {
    const r = await client.chat([{ role: 'user', content: 'Call the ping tool with value 7. Do not write anything else.' }], { tools: [PING], toolChoice: 'auto', max_tokens: 64 });
    const toolOk = !!r.toolCalls?.some(c => c.name === 'ping');
    const answered = toolOk || String(r.content ?? '').trim().length > 0;

    return { ok: answered, toolOk, ms: Date.now() - t0, servedBy: r.meta?.routedVia, ...(answered ? {} : { error: 'empty answer' }) };
  } catch(e) {
    return { ok: false, toolOk: false, ms: Date.now() - t0, error: (e.detail ?? e.message ?? String(e)).split('\n')[0].slice(0, 160) };
  } finally {
    clearTimeout(timer);
  }
}

/** an error another model could make up for: a limit, an outage or a dead connection */
export function isTransient(e) {
  const status = e?.status;
  if(status === 429 || (status >= 500 && status < 600) || status === 408) return true;
  return /no response after|stream stalled|connection|timed? ?out|ECONN|EPIPE/i.test(String(e?.message ?? ''));
}
