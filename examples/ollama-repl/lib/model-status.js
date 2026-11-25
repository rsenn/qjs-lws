/**
 * model-status.js: gather per-model health data from availability and routing state.
 */
import { loadAvailability, untilText } from './availability.js';
import { formatTable } from './usage-stats.js';

export function modelStatusTable(av) {
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
      /* keep short details ("rate limited", "out of credits"), abbreviate long ones to just the reset time */
      quotaCell = detail.length > 20 && entry.until != null
        ? `until ${untilText(entry.until, now)}`
        : `${detail}${entry.until != null ? ` (until ${untilText(entry.until, now)})` : ''}`;
    } else if (entry.until != null) {
      statusLabel = 'COOLDOWN';
      statusColor = '\x1b[33m';
      quotaCell = `until ${untilText(entry.until, now)}`;
    }

    const providers = (entry.platforms ?? []).join(', ') || '-';
    rows.push([
      modelId,
      statusColor + statusLabel + '\x1b[0m',
      quotaCell,
      providers,
    ]);
  }

  // Sort: RATE_LIMITED first, then OUT_OF_QUOTA, then OFFLINE, then COOLDOWN
  const rank = { RATE_LIMITED: 0, OUT_OF_QUOTA: 1, OFFLINE: 2, COOLDOWN: 3, READY: 4 };
  rows.sort((a, b) => {
    const ra = rank[a[1].replace(/\x1b\[[0-9;]*m/g, '')] ?? 4;
    const rb = rank[b[1].replace(/\x1b\[[0-9;]*m/g, '')] ?? 4;
    return ra - rb || a[0].localeCompare(b[0]);
  });

  const header = ['Model', 'Status', 'Quota / Reset', 'Providers'];
  return { rows, header };
}
