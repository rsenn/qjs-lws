import AbortSignal, { abortSignal, createAbortSignal } from './abort-signal.js';

/**
 * The AbortController.
 * @see https://dom.spec.whatwg.org/#abortcontroller
 */
export default class AbortController {
  /**
   * Initialize this controller.
   */
  constructor() {
    signals.set(this, createAbortSignal());
  }

  /**
   * Returns the `AbortSignal` object associated with this object.
   */
  get signal() {
    return getSignal(this);
  }

  /**
   * Abort and signal to any observers that the associated activity is to be aborted.
   */
  abort() {
    abortSignal(getSignal(this));
  }
}

AbortController.prototype[Symbol.toStringTag] = 'AbortController';

/**
 * Associated signals.
 */
const signals = new WeakMap();

/**
 * Get the associated signal of a given controller.
 */
function getSignal(controller) {
  const signal = signals.get(controller);

  if(signal == null) throw new TypeError(`Expected 'this' to be an 'AbortController' object, but got ${controller === null ? 'null' : typeof controller}`);

  return signal;
}

export { AbortController, AbortSignal };
