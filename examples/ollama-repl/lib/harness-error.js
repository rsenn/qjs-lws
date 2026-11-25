/**
 * harness-error: whether a request error comes from this program's own code (a ReferenceError, a TypeError from a
 * missing function, a bad color) and not from the provider or the gateway. Such a failure says nothing about a model:
 * it is not rated against one (repl.js onMeta), and the usage baseline classes it apart (lib/usage-baseline.js).
 *
 * ```js
 * isHarnessError(new ReferenceError("'fg' is not defined"));   // true
 * isHarnessError('All models exhausted: 3 routes checked');    // false
 * ```
 */
const OWN = /is not defined|is not a function|^not a function$|unknown color|undefined is not|cannot read propert|is not iterable/i;

export function isHarnessError(error) {
  if(!error) return false;
  if(error instanceof ReferenceError || error instanceof SyntaxError || error instanceof RangeError) return true;
  const text = String(error.message ?? error).split('\n')[0];
  return OWN.test(text) && !/^(All |Rate limit|Provider error|OpenAI connection)/i.test(text);
}
