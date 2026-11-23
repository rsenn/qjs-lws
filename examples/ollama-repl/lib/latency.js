/**
 * Latency tracking for provider models.
 * Tracks Time-To-First-Token per model using a rolling window of samples.
 * Models with average latency exceeding 10 seconds are marked as degraded.
 */

const WINDOW_SIZE = 10;
const DEGRADED_THRESHOLD_MS = 10_000;

/** @type {Map<string, number[]>} */
const samples = new Map();

/**
 * Record a latency sample for a given model id.
 * @param {string} modelId
 * @param {number} latencyMs - Round-trip time in milliseconds (used as proxy for TTFT)
 */
export function recordLatency(modelId, latencyMs) {
  if (!modelId || typeof modelId !== 'string') return;
  if (typeof latencyMs !== 'number' || latencyMs < 0) return;

  const arr = samples.get(modelId) ?? [];
  arr.push(latencyMs);
  if (arr.length > WINDOW_SIZE) arr.shift();
  samples.set(modelId, arr);
}

/**
 * Calculate the average latency for a model.
 * @param {string} modelId
 * @returns {number|null} Average latency in milliseconds, or null if no samples
 */
export function getAverageLatency(modelId) {
  const arr = samples.get(modelId);
  if (!arr || arr.length === 0) return null;
  const sum = arr.reduce((a, b) => a + b, 0);
  return sum / arr.length;
}

/**
 * Check if a model is degraded (average latency exceeds 10 seconds).
 * @param {string} modelId
 * @returns {boolean}
 */
export function isDegraded(modelId) {
  const avg = getAverageLatency(modelId);
  return avg !== null && avg > DEGRADED_THRESHOLD_MS;
}

/**
 * Generate a text report of all tracked latencies.
 * @returns {string}
 */
export function latencyReport() {
  if (samples.size === 0) return '(no latency samples recorded)';

  const lines = [];
  lines.push(`Latency report (last ${WINDOW_SIZE} samples per model, degraded > ${DEGRADED_THRESHOLD_MS / 1000}s):`);
  lines.push('');

  for (const [modelId, arr] of samples) {
    const avg = getAverageLatency(modelId);
    const degraded = isDegraded(modelId) ? ' [DEGRADED]' : '';
    const samplesStr = arr.map(ms => `${Math.round(ms)}ms`).join(', ');
    lines.push(`  ${modelId}: avg ${Math.round(avg)}ms (${arr.length} samples)${degraded}`);
    lines.push(`    samples: [${samplesStr}]`);
  }

  return lines.join('\n');
}