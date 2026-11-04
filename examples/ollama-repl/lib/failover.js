/**
 * Automatic model failover over a chat-bridge (examples/chat-bridge).
 *
 * Only active when the OpenAI-compatible endpoint is a chat-bridge: every
 * model its /models lists is `owned_by: "chat-bridge"`. Such a model can
 * stop answering (a free tier's message limit, a logged-out session); the
 * bridge then reports it as an OpenAI error and marks it unavailable in
 * /models. Plain OpenAI-compatible servers never fail over: there is no
 * other model to prefer and no way to tell.
 *
 * No option is needed: the order comes from the endpoint itself, the models
 * that are available right now in the order it lists them.
 */

export class Failover {
  #client;
  #bridge = false;

  /** @param {OpenAIClient} client */
  constructor(client) {
    this.#client = client;
  }

  /** @returns {Promise<boolean>} whether the endpoint is a chat-bridge */
  async detect() {
    try {
      const models = await this.#client.listModels();
      this.#bridge = models.length > 0 && models.every(m => m.ownedBy === 'chat-bridge');
    } catch(e) {
      this.#bridge = false;
    }

    return this.#bridge;
  }

  get enabled() {
    return this.#bridge;
  }

  /** whether `err` is a refusal another model could make up for */
  static applies(err) {
    return !!err && (err.isRateLimit || err.code === 'login_required');
  }

  /**
   * The next model to try: the first one the endpoint lists as available
   * that this turn has not tried yet. The list is read fresh, because the
   * bridge has just marked the failing model unavailable.
   *
   * @param {Set<string>} tried model names already tried for this turn
   * @returns {Promise<string|null>} null if there is none left
   */
  async next(tried) {
    try {
      return (await this.#client.listModels()).find(m => m.available && !tried.has(m.name))?.name ?? null;
    } catch(e) {
      return null;
    }
  }
}

/** one line for the user: what happened and where the turn goes now */
export function failoverNote(err, from, to) {
  const why = err.code === 'login_required' ? 'login needed' : 'limit reached';
  const when = err.retryAfter ? `, back in ~${err.retryAfter >= 3600 ? `${Math.round(err.retryAfter / 3600)}h` : `${Math.ceil(err.retryAfter / 60)}min`}` : '';
  return `(${from}: ${why}${when} - switching to ${to})`;
}
