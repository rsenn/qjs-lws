/**
 * model-status.js: gather per-model health data from availability and routing state.
 */
import { loadAvailability, backShort } from './availability.js';
import { formatTable } from './usage-stats.js';
import { probeCells } from './exploration.js';
import { quotaCell as quotaMeter } from './look.js';
import { fmtNum } from './usage-stats.js';
import { ratingCell } from './rating.js';
import { timed } from './lag.js';

/**
 * @param {object} av  loadAvailability() result
 * @param {object} [exploration]
 * @param {(id: string) => {ctx?: number, used?: number, budget?: number}|undefined} [info]  context window and monthly token budget of a model id
 * @param {(id: string) => number|null} [rate]  rating 0..100 (lib/rating.js)
 */
export const modelStatusTable = (...args) => timed('modelStatusTable', () => modelStatusTableNow(...args));
function modelStatusTableNow(av, exploration = null, info = () => undefined, rate = () => null) {
  const now = av?.at ?? Date.now();
  const rows = [];

  for (const [modelId, entry] of av.byModel) {
    // Hide OFFLINE models (permanent, or outside key scope). READY models are shown.
    if (entry.permanent || (entry.kinds?.length === 1 && entry.kinds[0] === 'scope')) continue;

    let statusLabel = 'READY';
    let statusColor = '\x1b[32m'; // green
    let quotaCell = '-';

    if (entry.blocked) {
      if (entry.kinds?.includes('credit') || entry.kinds?.includes('cap')) {
        statusLabel = 'OUT_OF_QUOTA';
        statusColor = '\x1b[31m'; // red
      } else if (entry.permanent) {
        statusLabel = 'OFFLINE';
        statusColor = '\x1b[2m'; // dim
      } else {
        statusLabel = 'RATE_LIMITED';
        statusColor = '\x1b[33m'; // yellow
      }
      const detail = entry.blocks?.[0]?.detail ?? 'limited';
      /* use backShort for the Quota / Reset cell: "67m · 08:59", colored and formatted */
      const backText = entry.until != null ? backShort(entry.until, now, entry.approx) : '-';
      /* for long details, show just the back time; for short details with until, show "detail · backTime" */
      if (detail.length > 20 && backText !== '-') {
        quotaCell = statusColor + backText + '\x1b[0m';
      } else if (backText !== '-') {
        quotaCell = statusColor + detail.slice(0, 20) + ' · ' + backText + '\x1b[0m';
      } else {
        quotaCell = statusColor + (entry.blocks?.[0]?.detail ?? 'limited') + '\x1b[0m';
      }
    } else if (entry.until != null) {
      statusLabel = 'COOLDOWN';
      statusColor = '\x1b[33m';
      const backText = backShort(entry.until, now, entry.approx);
      quotaCell = statusColor + backText + '\x1b[0m';
    } else if (entry.status === 'needsKey') {
      /* the model is listed but its platform has no API key configured */
      statusLabel = 'NEEDS_KEY';
      statusColor = '\x1b[35m'; // magenta
      quotaCell = statusColor + 'add an API key for this platform' + '\x1b[0m';
    }

    const providers = (entry.platforms ?? []).join(', ') || '-';
    const i = info(modelId);
    rows.push([
      modelId,
      ratingCell(rate(modelId)),
      statusColor + statusLabel + '\x1b[0m',
      i?.ctx ? fmtNum(i.ctx) : '-',
      i?.budget > 0 ? quotaMeter(i.used ?? 0, i.budget, 0) : '-',
      quotaCell,
      providers,
      ...(exploration ? (statusLabel === 'READY' ? probeCells(exploration, modelId) : ['', '']) : []),
      entry.intelligence ?? -1,
    ]);
  }

  /* READY models on top, the strongest first (the gateway's intelligence score), then what is waiting, then what is not usable */
  const rank = { READY: 0, COOLDOWN: 1, RATE_LIMITED: 2, OUT_OF_QUOTA: 3, NEEDS_KEY: 4, OFFLINE: 5 };
  const stat = r => rank[r[2].replace(/\x1b\[[0-9;]*m/g, '')] ?? 4;
  /* worked out once per row: the comparator runs n log n times, and stat() strips colours with a regex */
  const stats = new Map(rows.map(r => [r, stat(r)]));
  const rates = new Map(rows.map(r => [r, rate(r[0]) ?? -1]));
  rows.sort((a, b) => stats.get(a) - stats.get(b) || rates.get(b) - rates.get(a) || b[b.length - 1] - a[a.length - 1] || a[0].localeCompare(b[0]));
  for(const r of rows) r.pop();

  const header = ['Model', 'Rate', 'Status', 'Context', 'Tokens/month', 'Quota / Reset', 'Providers', ...(exploration ? ['Probe', 'Says'] : [])];
  return { rows, header };
}
