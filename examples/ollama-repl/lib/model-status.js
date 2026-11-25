/**
 * model-status.js: gather per-model health data from availability and routing state.
 *
 * Returns an array of { id, name, status, quota, reset, latency, providers }
 * where status is one of: 'ready', 'rate_limited', 'out_of_quota', 'offline'
 */
import { loadAvailability } from './availability.js';

/**
 * Map a model's block status to a health label and color.
 * @param {object} entry - The model entry from availability.byModel
 * @param {number} now - Current timestamp
 * @returns {{label: string, color: string, resetIn?: string, detail: string}}
 */
function healthStatus(entry, now) {
  if (!entry.blocked) {
    return {
      label: 'READY',
      color: '\x1b[32m',  // green
      detail: 'Model is available'
    };
  }

  if (entry.kinds.includes('ip')) {
    return {
      label: 'RATE_LIMITED',
      color: '\x1b[33m',  // yellow/amber
      detail: entry.blocks[0]?.detail ?? 'Rate limited by IP/region',
      resetIn: entry.until != null ? `${Math.max(0, Math.ceil((entry.until - now) / 60000))}m` : undefined
    };
  }

  if (entry.kinds.includes('cap') || entry.kinds.includes('credit')) {
    return {
      label: 'OUT_OF_QUOTA',
      color: '\x1b[31m',  // red
      detail: entry.blocks[0]?.detail ?? 'Out of quota/credits',
      resetIn: entry.until != null ? `${Math.max(0, Math.ceil((entry.until - now) / 60000))}m` : undefined
    };
  }

  if (entry.permanent) {
    return {
      label: 'OFFLINE',
      color: '\x1b[2m',  // dim/grey
      detail: 'Model permanently unavailable',
      resetIn: undefined
    };
  }

  return {
    label: 'RATE_LIMITED',
    color: '\x1b[33m',
    detail: entry.blocks[0]?.detail ?? 'Rate limited',
    resetIn: entry.until != null ? `${Math.max(0, Math.ceil((entry.until - now) / 60000))}m` : undefined
  };
}

/**
 * Format model status into a table row.
 * @param {string} id - Model id
 * @param {{label: string, color: string, ...}} statusInfo - Health status info
 * @param {number} now - Current timestamp
 * @returns {Array<string>} Table row cells
 */
function formatModelRow(id, statusInfo, now) {
  const quotaCell = statusInfo.resetIn
    ? statusInfo.resetIn
    : statusInfo.label === 'READY'
    ? 'unlimited'
    : '-';

  return [
    id,
    statusInfo.color + statusInfo.label + '\x1b[0m',
    quotaCell,
    statusInfo.resetIn || '-'
  ];
}

/**
 * Gather health data for all models and return table-ready rows.
 * @param {{at: number, byModel: Map}} av - Availability data from loadAvailability()
 * @returns {{rows: Array<Array<string>>, header: string}} Table data ready for formatTable
 */
export function modelStatusTable(av) {
  const now = av?.at ?? Date.now();
  const rows = [];

  for (const [modelId, entry] of av.byModel) {
    const status = healthStatus(entry, now);
    const row = formatModelRow(modelId, status, now);
    rows.push(row);
  }

  // Sort: ready first, then by reset time (earliest first for limited)
  rows.sort((a, b) => {
    const aReady = a[1].includes('READY');
    const bReady = b[1].includes('READY');
    if (aReady && !bReady) return -1;
    if (!aReady && bReady) return 1;
    // Both same readiness, sort by reset time (earliest first for limited)
    const aReset = a[3];
    const bReset = b[3];
    if (aReset === '-' && bReset !== '-') return 1;
    if (aReset !== '-' && bReset === '-') return -1;
    if (aReset === '-' && bReset === '-') return 0;
    return aReset.localeCompare(bReset);
  });

  const header = ['Model', 'Status', 'Quota / Reset'].map(h =>
    h.replace('/', '\u200b/')  // zero-width space to prevent line wrapping
  );

  return { rows, header };
}