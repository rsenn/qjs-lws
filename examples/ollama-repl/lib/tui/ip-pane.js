/**
 * ip-pane: the pane shown when the exit address of the anonymizing proxy (Tor / anon) changes - the old and the new
 * address in warning colors, and the models that were limited per IP address and could work again through the new one.
 *
 * ```js
 * const groups = ipGroups(availability, keys);                       // the models an address change could free
 * console.log(ipChangePanel({ before, after, direct, groups }, tui.width));
 * pane.update(...ipChangeParts({ before, after, direct, groups }));  // a livePanel: title, lines, { border }
 * ```
 *
 * Amber border: the address changed. Red: it did not (Tor keeps the circuit, a probe host answers from a cache) or the
 * new one is our own (the proxy is not in the way). Nothing is said about models then: nothing can have changed for them.
 */
import { style } from 'terminal/style';
import { ARROWS, ERROR, TEXT, WARN } from '../palette.js';
import { IP_KINDS, ipLimitedPlatforms } from '../gateway/ip-fix.js';
import { kindsText, untilText } from '../gateway/availability.js';
import { panel } from '../look.js';

const MAX_PROVIDERS = 8;
const MAX_NAMES = 3;

/**
 * the models an address change could free, by provider: blocked by a limit that is counted per IP address, on a
 * provider of an enabled keyless key or one that has a model limited as an IP matter
 *
 * @param {{byModel: Map<string, object>}} av  loadAvailability() result
 * @param {object[]} [keys]  GET /api/keys
 * @returns {{platform: string, models: {id: string, kinds: string[], until: number|null}[]}[]}  the most models first
 */
export function ipGroups(av, keys = []) {
  const platforms = new Set([...keys.filter(k => k.keyless && k.enabled).map(k => k.platform), ...ipLimitedPlatforms(av)]);
  const groups = new Map();

  for(const [id, e] of av?.byModel ?? []) {
    if(!e.blocked || !e.kinds?.some(k => IP_KINDS.has(k))) continue;

    const platform = (e.platforms ?? []).find(p => platforms.has(p));
    if(!platform) continue;
    if(!groups.has(platform)) groups.set(platform, { platform, models: [] });
    groups.get(platform).models.push({ id, kinds: e.kinds.filter(k => IP_KINDS.has(k)), until: e.until ?? null });
  }

  return [...groups.values()].sort((a, b) => b.models.length - a.models.length || a.platform.localeCompare(b.platform));
}

/**
 * title, lines and border of the pane
 *
 * @param {{before: string|null, after: string|null, direct?: string|null, groups?: object[], now?: number}} x
 *   before, after: the exit address of the proxy; direct: our own address, to tell a proxy that is not used
 * @returns {[string, string, {border: string}]}
 */
export function ipChangeParts({ before, after, direct = null, groups = [], now = Date.now() }) {
  const changed = !!after && after !== before;
  const own = changed && !!direct && after === direct;
  const bad = !changed || own;
  const color = bad ? ERROR : WARN;
  const label = (t, c) => style(t.padEnd(5), { fg: c ?? '#94a3b8' });

  const title = style(`⚠ exit address ${!changed ? 'UNCHANGED' : own ? 'is our own' : 'changed'}`, { fg: color, bold: true });
  const lines = [`${label('old')} ${style(before ?? '?', { fg: ERROR, strike: changed })}`, `${label('new', ARROWS)} ${style(after ?? '?', { fg: changed ? ARROWS : ERROR, bold: true })}`];
  if(direct) lines.push(`${label('ours')} ${style(direct, { fg: '#94a3b8' })}`);

  if(!changed) lines.push('', style('Tor keeps the circuit, or the probe hosts answer from a cache: nothing changes for the models', { fg: ERROR }));
  else if(own) lines.push('', style('the proxy is not in the way: requests leave from this address', { fg: ERROR }));
  else if(!groups.length) lines.push('', style('no model is limited per IP address right now', { dim: true }));
  else {
    const n = groups.reduce((sum, g) => sum + g.models.length, 0);
    const width = Math.max(...groups.map(g => g.platform.length));
    lines.push('', style(`${n} model${n > 1 ? 's' : ''} of ${groups.length} provider${groups.length > 1 ? 's' : ''} could work again:`, { fg: WARN, bold: true }));

    for(const g of groups.slice(0, MAX_PROVIDERS)) {
      const names = g.models.slice(0, MAX_NAMES).map(m => m.id).join(', ') + (g.models.length > MAX_NAMES ? ` +${g.models.length - MAX_NAMES}` : '');
      const kinds = kindsText({ kinds: [...new Set(g.models.flatMap(m => m.kinds))] });
      const untils = g.models.map(m => m.until).filter(u => u != null);
      const back = untils.length ? `, back ${untilText(Math.min(...untils), now)}` : '';

      lines.push(`${style('↻', { fg: WARN })} ${style(g.platform.padEnd(width), { fg: TEXT, bold: true })} ${names} ${style(`(${kinds}${back})`, { dim: true })}`);
    }

    if(groups.length > MAX_PROVIDERS) lines.push(style(`… and ${groups.length - MAX_PROVIDERS} more providers`, { dim: true }));
    lines.push('', style('the gateway looks again in 6 s and 30 s; /model list shows what is usable', { dim: true }));
  }

  return [title, lines.join('\n'), { border: color }];
}

/** the pane as a string, at most cols - 1 wide */
export function ipChangePanel(x, cols = 100) {
  const [title, text, opts] = ipChangeParts(x);
  return panel(title, text, cols, opts);
}
