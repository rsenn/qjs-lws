/**
 * key-events: a provider key that went unhealthy, or healthy again, as a `key` event. Fed with the key list of any look
 * at the gateway (the availability load, /gateway keys), so a change is seen at the next refresh without a request of
 * its own, and said once whichever look saw it first.
 *
 *   reportKeys(keys, name => name)   // keys: [{ id, platform, label?, status, lastHealthError? }]
 */
import { emit } from './events.js';

const seen = new Map(); /* key id -> its status at the last look */
let started = false;

/** @param {object[]} keys  @param {(platform: string) => string} [nameOf]  display name of a platform */
export function reportKeys(keys, nameOf = p => p) {
  const before = started ? new Map(seen) : null;
  started = true;
  seen.clear();
  for(const k of keys) seen.set(k.id, k.enabled === false ? 'disabled' : (k.status ?? 'unknown'));
  if(!before) return 0;

  let n = 0;
  for(const k of keys) {
    const was = before.get(k.id);
    const is = seen.get(k.id);
    if(was === undefined || was === is) continue;
    n++;
    const label = `${nameOf(k.platform) ?? k.platform}${k.label ? ` (${k.label})` : ''} key ${k.id}`;
    if(is === 'healthy') emit('key', `${label} is healthy again`, 'good');
    else emit('key', `${label}: ${was} -> ${is}${k.lastHealthError ? ` (${String(k.lastHealthError).slice(0, 80)})` : ''}`, is === 'error' ? 'bad' : 'warn');
  }
  return n;
}

/** forgets the last look (a new gateway) */
export const resetKeys = () => (started = false);
