/**
 * shared-spinner: one spinner for all requests that run at the same time. Each request used to start its own
 * spinner timer, and the timers took turns writing the one status line (two quips, two elapsed times: 26s, 0s, 26s,
 * ...), which is a flicker. Now the first request starts the spinner, later ones only count themselves in, and the
 * line is cleared when the last one stops.
 *
 * ```js
 * const startSpinner = shareSpinner(label => makeSpinner(label));   // makeSpinner returns its stop function
 * const stopA = startSpinner();
 * const stopB = startSpinner();    // no second spinner
 * stopA();                         // still running
 * stopB();                         // stopped now
 * ```
 *
 * A stop function is safe to call more than once.
 */
export function shareSpinner(create) {
  let shared = null;

  return label => {
    if(!shared) shared = { stop: create(label), users: 0 };

    const mine = shared;
    mine.users++;
    let done = false;

    return () => {
      if(done) return;
      done = true;
      if(--mine.users > 0) return;

      mine.stop();
      if(shared === mine) shared = null;
    };
  };
}
