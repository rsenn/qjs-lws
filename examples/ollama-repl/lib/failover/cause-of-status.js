/**
 * What the status and the error code of an HTTP answer say about a failure, without reading its text.
 * The gateway (freellmapi) and OpenAI-compatible endpoints give both: `status` 429/5xx/401, `error.code`
 * `rate_limit_exceeded`, `upstream_error`, `model_not_found`, ...
 *
 *   causeOfStatus(429)                       // 'rate-limited'
 *   causeOfStatus(502, 'upstream_error')     // 'upstream'
 *   causeOfStatus(undefined, undefined)      // undefined: nothing to go by, read the text
 *
 * @param {number} [status]
 * @param {string} [code]
 * @returns {'auth'|'rate-limited'|'upstream'|'timeout'|'model-gone'|'refused'|undefined} the cause of diagnose(), undefined when unknown
 */
const BY_CODE = {
  invalid_api_key: 'auth',
  login_required: 'auth',
  rate_limit_exceeded: 'rate-limited',
  insufficient_quota: 'rate-limited',
  rate_limited: 'rate-limited',
  daily_quota_exhausted: 'rate-limited',
  upstream_error: 'upstream',
  gateway_error: 'upstream',
  overloaded: 'upstream',
  timeout: 'timeout',
  model_not_found: 'model-gone',
};

export function causeOfStatus(status, code) {
  if(code && BY_CODE[code]) return BY_CODE[code];
  if(status === 401 || status === 403) return 'auth';
  if(status === 402 || status === 429) return 'rate-limited';
  if(status === 408) return 'timeout';
  if(status === 400 || status === 404 || status === 413 || status === 422) return 'refused'; /* the request itself is wrong: no retry helps */
  if(status >= 500 && status < 600) return 'upstream';
  return undefined;
}

/** the failure is the provider's or the route's, not the model's: another try or another route may work */
export const isTransientCause = cause => cause === 'rate-limited' || cause === 'upstream' || cause === 'timeout';
