/**
 * takeover: when does a model found by the async exploration deserve to take
 * over a running task, and what did it answer when it was handed the task.
 *
 * ```js
 * betterReason({ strength: { cand: 2, cur: 5 }, probeMs: 900, currentMs: 6000 });   // 'stronger (tier 2, running tier 5)'
 * stepText(result);                                                                  // 'read_file({"path":"lib/tui.js"})'
 * ```
 *
 * Better is a stronger tier (0 strongest, 9 unknown), or the same tier and at
 * least twice as fast as the running model's last reply, which itself took
 * 4 s or more. A tier of 9 on both sides is no information, only speed counts.
 */

/** @returns {string|null} why the candidate is better, null when it is not */
export function betterReason({ strength: { cand, cur }, probeMs, currentMs }) {
  if(cand < cur) return `stronger (tier ${cand}, running tier ${cur})`;
  if(cand === cur && probeMs > 0 && currentMs >= 4000 && probeMs * 2 <= currentMs)
    return `${(currentMs / probeMs).toFixed(1)}x faster (${(probeMs / 1000).toFixed(1)}s against ${(currentMs / 1000).toFixed(1)}s)`;
  return null;
}

/** what the candidate did with the handed-over task, one line; null when it did nothing usable */
export function stepText(r) {
  const call = r?.toolCalls?.[0];
  if(call) return `${call.name}(${JSON.stringify(call.args ?? {}).slice(0, 80)})`;

  const text = String(r?.content ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length >= 20 ? text.slice(0, 100) : null;
}
