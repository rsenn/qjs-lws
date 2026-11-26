/**
 * A reply that was cut off mid-stream continues instead of starting over (doc/ARCHITECTURE.md "Mid-stream failure").
 *
 *   withContinuation(messages, 'The answer is')   // messages + assistant partial + CONTINUE_PROMPT, for one request
 *   isCutConnection(err)                          // "dropped after 18000 ms, 347000 bytes received"
 *   shouldAskAgain(err, { asked, spent, budget }) // one more try on the same route after a cut connection
 */

/** sent after the partial answer */
export const CONTINUE_PROMPT = 'Your previous reply was cut off by an error. Continue exactly where it stopped, without repeating anything and without any introduction.';

/**
 * The conversation for the request that continues `partial`: a copy, `messages` itself is not changed
 * (the two added messages are never part of the history).
 *
 * @param {object[]} messages
 * @param {string} [partial] the answer text already shown, none: the messages as they are
 */
export const withContinuation = (messages, partial) => (partial ? [...messages, { role: 'assistant', content: partial }, { role: 'user', content: CONTINUE_PROMPT }] : messages);

/** the connection died in the middle of the body (lib/lws/protocols.js onClientHttpDropProtocol) */
export const isCutConnection = err => /^dropped after \d+ ms/.test(String(err?.message ?? ''));

/**
 * A cut connection is asked once more on the same route, not past the token budget.
 *
 * @param {{asked: boolean, spent: number, budget: number}} s  asked: this round already did; budget 0 = none
 */
export const shouldAskAgain = (err, { asked, spent, budget }) => !asked && isCutConnection(err) && !(budget > 0 && spent >= budget);
