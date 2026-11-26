/**
 * press-counter: counts presses of one key inside a time window - Esc three times within 2 seconds stops a whole turn
 * (doc/ARCHITECTURE.md, "Interrupting").
 *
 * ```js
 * const esc = new PressCounter(3, 2000);
 * esc.press();   // false
 * esc.press();   // false
 * esc.press();   // true: the third press within 2 s; the count starts again
 * ```
 */
export class PressCounter {
  #times = [];

  /** @param {number} [count]  presses that make a hit  @param {number} [windowMs]  how recent they must be */
  constructor(count = 3, windowMs = 2000) {
    this.count = count;
    this.windowMs = windowMs;
  }

  /** @returns {boolean} true when this press is the `count`-th inside the window (the counter then starts over) */
  press(now = Date.now()) {
    this.#times = this.#times.filter(t => now - t < this.windowMs);
    this.#times.push(now);
    if(this.#times.length < this.count) return false;

    this.#times = [];
    return true;
  }

  reset() {
    this.#times = [];
  }
}
