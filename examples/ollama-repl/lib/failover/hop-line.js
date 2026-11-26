/**
 * hopLine - the one transcript line of an automatic model switch.
 *
 *   hopLine({ from, why, providers, count, back, next, rating }, { model, paint })
 *   -> '⇄ gemini-3.5-flash-lite upstream failure, skipped 10m → qwen3.8-27b rating 90'
 *
 * from: the spent model (via: the provider that served it, when known); why: the reason; providers/count: the models of those providers
 * that were skipped too; back: when they return (text); next: the model taken now (falsy:
 * none left); rating: its rating. model(id) and paint(kind, text) colour model names and
 * the other parts; both default to plain text (piped output).
 */
const MAX_PROVIDERS = 4;

/** the colours of the parts of a hop line */
export const HOP_COLORS = { provider: '#2dd4bf', time: '#fbbf24', arrow: '#a3e635', warn: '#fbbf24', bad: '#f87171' };

/** the `{ model, paint }` options of hopLine for a terminal: plain (`{}`) when piped */
export function hopStyle({ piped = false, dim = s => s, fgHex, modelName }) {
  return piped ? {} : { model: modelName, paint: (kind, text) => (kind === 'dim' ? dim(text) : fgHex(HOP_COLORS[kind], text)) };
}

export function hopLine({ from, via = '', why, providers = [], count = 0, back = '', next = '', rating = null }, { model = (id) => id, paint = (kind, text) => text } = {}) {
  const shown = providers.slice(0, MAX_PROVIDERS).map(p => paint('provider', p)).join(', ');
  const more = providers.length > MAX_PROVIDERS ? ` ${paint('dim', `+${providers.length - MAX_PROVIDERS} more`)}` : '';
  const spread = providers.length ? `: ${count || ''}${count ? ' models of ' : ''}${shown}${more}` : '';
  const when = back ? `, ${paint('time', back)}` : '';
  const arrow = paint('arrow', '→');
  const to = next ? `${model(next)}${rating != null ? ` ${paint('dim', `rating ${rating}`)}` : ''}` : paint('bad', 'no other model available');
  return `${paint('arrow', '⇄')} ${via ? `${paint('provider', `${via}/`)}` : ''}${model(from)} ${paint(/rate/.test(why) ? 'warn' : 'bad', why)}${spread}${when} ${arrow} ${to}`;
}
