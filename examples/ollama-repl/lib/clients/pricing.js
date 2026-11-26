/**
 * pricing: cost estimates for endpoints that report no cost. See
 * doc/ARCHITECTURE.md, "Cost estimate".
 *
 * ```js
 * estimateCost('cerebras', 'gpt-oss-120b', { prompt: 2762, completion: 32 })   // 0.00099 (USD)
 * ```
 */

/* USD per million tokens, [input, output]. Cerebras: api.cerebras.ai/public/v1/models, 2026-11-26 */
export const PRICES = {
  cerebras: {
    'gpt-oss-120b': [0.35, 0.75],
    'qwen-3.8-27b': [0.99, 1.49]
  }
};

/** [input, output] USD per million tokens of provider/model, or undefined */
export function priceOf(provider, model) {
  const t = PRICES[provider];
  return t && Object.hasOwn(t, model) ? t[model] : undefined;
}

/** USD for one request's usage ({prompt, completion}), undefined when the model has no price or usage is missing */
export function estimateCost(provider, model, usage) {
  const p = priceOf(provider, model);
  if(!p || !usage || (usage.prompt == null && usage.completion == null)) return undefined;
  return ((usage.prompt ?? 0) * p[0] + (usage.completion ?? 0) * p[1]) / 1e6;
}

/** "$0.0010", "$1.23"; small amounts keep two significant digits */
export function fmtUsd(v) {
  if(!Number.isFinite(v)) return '-';
  if(v === 0) return '$0';
  return `$${v >= 0.01 ? v.toFixed(2) : v.toFixed(Math.min(20, 1 - Math.floor(Math.log10(v))))}`;
}
