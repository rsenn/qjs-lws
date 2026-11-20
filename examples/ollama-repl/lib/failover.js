/**
 * Client-side failover for a model pinned to one site of a chat-bridge
 * (examples/chat-bridge).
 *
 * The bridge routes by itself for `auto` and `auto:AXIS` (chat-bridge
 * doc/HARNESS.md step 4): it tries the next site and replays the transcript.
 * A pinned site (`--model deepseek`) has no such routing, so when it stops
 * answering (a message limit, a logged-out session) this class picks the next
 * site that is available and the caller hands it a compacted conversation
 * (lib/handoff.js, a local model summarizes the older turns), which the
 * bridge's own replay cannot do. It is only created for a bridge
 * (gateway.isBridge); `auto` models are never picked, and an exhausted `auto`
 * is the harness's /model skip, not a failover.
 */

export class Failover {
  #client;

  /** @param {OpenAIClient} client */
  constructor(client) {
    this.#client = client;
  }

  /** whether `err` is a refusal another model could make up for */
  static applies(err) {
    return !!err && (err.isRateLimit || err.code === 'login_required' || Failover.isUpstreamFailure(err));
  }

  /** an upstream 5xx / timeout / gateway error: the route died, another model might serve it */
  static isUpstreamFailure(err) {
    if(err?.status >= 500) return true;
    if(err?.code === 'upstream_error' || err?.code === 'timeout' || err?.code === 'gateway_error') return true;

    const m = err?.message ?? '';
    return /no response after|timed? out|timeout|502|503|bad gateway|gateway timeou?t|upstream (error|unavailable)/i.test(m);
  }

  /**
   * The next site to try: the first one the endpoint lists as available
   * that this turn has not tried yet (never an auto model). The list is read fresh, because the
   * bridge has just marked the failing model unavailable.
   *
   * @param {Set<string>} tried model names already tried for this turn
   * @returns {Promise<string|null>} null if there is none left
   */
  async next(tried) {
    try {
      return (await this.#client.listModels()).find(m => m.available && !tried.has(m.name) && !/^auto(:|$)/.test(m.name))?.name ?? null;
    } catch(e) {
      return null;
    }
  }
}

/** one line for the user: what happened and where the turn goes now */
export function failoverNote(err, from, to) {
  const why = err.code === 'login_required' ? 'login needed' : Failover.isUpstreamFailure(err) ? 'upstream failure' : 'limit reached';
  const when = err.retryAfter ? `, back in ~${err.retryAfter >= 3600 ? `${Math.round(err.retryAfter / 3600)}h` : `${Math.ceil(err.retryAfter / 60)}min`}` : '';
  return `${from}: ${why}${when} - switching to ${to}`;
}

/** one line for the user: a model was skipped because it failed */
export function skipNote(from, reason) {
  return `${from}: ${reason} - skipped for 10m`;
}
