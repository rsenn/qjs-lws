/**
 * key-models: which models a gateway key can serve, and the set of models a
 * selection of keys reaches.
 *
 * ```js
 * const data = await loadKeyData(gateway);                       // { keys, chain, catalog }
 * const set = modelsOfKeys(data, [3, 7]);
 * set.models   // Map: catalog model id -> [{ platform, modelId, displayName, keyIds }]
 * set.ids      // Set of those catalog model ids
 * set.shared   // [{ platform, others: 2 }]  platforms where other enabled keys can serve a request, too
 * parseKeyScope('key:3,key:7')   // { ids: [3, 7] }, { off: true } for key:off, null when it is not one
 * ```
 *
 * A key serves the provider rows of its platform, those inside its model scope
 * when it has one (the dashboard's "limit this key to these models"). The
 * gateway picks the key of a request itself, there is no way to name one per
 * request: restricting the models to those of some keys is a restriction of
 * the harness's selection, and holds for the key only where it is the only
 * enabled key of its platform (shared tells where it is not).
 */
import { groupId } from './availability.js';

/** the gateway's keys, provider rows and model catalog (dashboard session needed) */
export async function loadKeyData(gateway) {
  const [keys, chain, catalog] = await Promise.all([gateway.api('/api/keys'), gateway.api('/api/fallback').catch(() => []), gateway.models()]);
  return { keys: Array.isArray(keys) ? keys : [], chain: Array.isArray(chain) ? chain : [], catalog: catalog ?? [] };
}

/** `key:3,key:7` / `key:3 key:7` -> { ids }, `key:off` or `key:` -> { off: true }, anything else null */
export function parseKeyScope(text) {
  const words = String(text ?? '').trim().split(/[,\s]+/).filter(Boolean);
  if(!words.length || !words.every(w => /^key:/.test(w))) return null;
  if(words.length === 1 && /^key:(off|none|)$/.test(words[0])) return { off: true };

  const ids = [];
  for(const w of words) {
    const m = /^key:(\d+)$/.exec(w);
    if(!m) return { error: `"${w}" is not key:ID (/gateway keys shows the ids)` };
    ids.push(+m[1]);
  }
  return { ids: [...new Set(ids)] };
}

/**
 * @param {{keys: object[], chain: object[], catalog: object[]}} data
 * @param {number[]} ids  key ids
 * @returns {{keys: object[], missing: number[], models: Map<string, object[]>, ids: Set<string>, shared: {platform: string, others: number}[]}}
 */
export function modelsOfKeys({ keys, chain, catalog }, ids) {
  const picked = ids.map(id => keys.find(k => k.id === id)).filter(Boolean);
  const missing = ids.filter(id => !keys.some(k => k.id === id));
  const known = new Set(catalog.map(m => m.id));
  const models = new Map();

  for(const k of picked.filter(k => k.enabled)) {
    for(const r of chain) {
      if(r.platform !== k.platform || r.enabled === false) continue;
      if(Array.isArray(k.modelScope) && !k.modelScope.includes(r.modelId)) continue;

      /* the catalog id a row is listed under (the gateway merges rows of one logical model, see availability.js) */
      for(const id of new Set([groupId(r.displayName), r.modelId])) {
        if(!known.has(id)) continue;
        const rows = models.get(id) ?? models.set(id, []).get(id);
        const row = rows.find(x => x.platform === r.platform && x.modelId === r.modelId) ?? rows[rows.push({ platform: r.platform, modelId: r.modelId, displayName: r.displayName, keyIds: [] }) - 1];
        if(!row.keyIds.includes(k.id)) row.keyIds.push(k.id);
      }
    }
  }

  const shared = [];
  for(const platform of new Set(picked.map(k => k.platform))) {
    const others = keys.filter(k => k.platform === platform && k.enabled && !ids.includes(k.id)).length;
    if(others) shared.push({ platform, others });
  }

  return { keys: picked, missing, models, ids: new Set(models.keys()), shared };
}
