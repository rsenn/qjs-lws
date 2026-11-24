/* routing-health.js: the one-line "is the gateway running dry?" of the status bar, from the dashboard
   availability (lib/availability.js) and the models the session skipped. Quiet while all is well. */
import { untilText } from './availability.js';

/**
 * @param {{skips: Iterable<{until: number}>, av?: {byModel: Map<string, {blocked: boolean, permanent?: boolean, until?: number|null}>}|null, now?: number}} o
 * @returns {{text: string, level: 'warn'|'bad'}|null} null while at most one model is skipped and under half of the models are limited
 */
export function routingHealth({ skips, av, now = Date.now() }) {
  const skipped = [...skips].filter(s => s.until > now).length;
  const models = av ? [...av.byModel.values()] : [];
  const blocked = models.filter(m => m.blocked);
  const tight = models.length >= 4 && blocked.length * 2 >= models.length;

  if(skipped < 2 && !tight) return null;

  const parts = [];
  if(models.length) parts.push(`${models.length - blocked.length}/${models.length} ready`);
  if(skipped) parts.push(`${skipped} skipped`);

  const ends = blocked.filter(m => !m.permanent && m.until != null && m.until > now).map(m => m.until);
  if(ends.length) parts.push(`first back ${untilText(Math.min(...ends), now)}`);

  return { text: `routing ${parts.join(', ')}`, level: models.length && blocked.length === models.length ? 'bad' : 'warn' };
}
