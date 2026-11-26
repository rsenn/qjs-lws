/**
 * lag - finds out where the single-threaded event loop stalls.
 *
 *   startLagWatch({ describe: () => 'waiting for the model' });   // once, in main()
 *   const x = timed('getFilteredModels', () => compute());         // a sync section that may be heavy
 *
 * The watch is a 100 ms timer; one that fires 150 ms or more late means the loop was
 * blocked (a long callback, or a blocking syscall) for that long. Each such stall is an
 * event of kind `lag`, one line of lag.jsonl in the cache directory, and carries the
 * slow `timed` sections that ended inside it. A section of 100 ms or more is reported
 * on its own. Both say "where" only for wrapped code: a stall with no section was
 * spent elsewhere (wrap it) or blocked in a syscall (strace).
 */
import { open as fopen } from 'std';
import { setTimeout, clearTimeout } from 'os';
import { emit } from './events.js';
import { cacheDir } from './session/session-cache.js';

export const TICK_MS = 100;
export const STALL_MS = 150;
export const SLOW_MS = 100;

const slow = []; /* { at: end time, name, ms } of the last slow sections */

const fmt = ms => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);

function log(row) {
  try {
    const f = fopen(`${cacheDir()}/lag.jsonl`, 'a');
    if(!f) return;
    f.puts(`${JSON.stringify(row)}\n`);
    f.close();
  } catch(e) {}
}

/** the functions that called timed(), nearest first ("a < b < c"): where a slow section was asked for */
function callers() {
  try {
    return (new Error().stack ?? '').split('\n').slice(2, 7).map(l => /at (\S+)/.exec(l)?.[1] ?? l.trim()).join(' < ');
  } catch(e) {
    return '';
  }
}

/**
 * A long loop that must not block the event loop: `const turn = slicer(); for(...) { await turn(); work(); }`.
 * turn() returns at once until `ms` have gone by since the last time the loop had a turn, then waits one timer tick.
 */
export function slicer(ms = 20) {
  let t0 = Date.now();

  return async () => {
    if(Date.now() - t0 < ms) return;
    await new Promise(resolve => setTimeout(resolve, 0));
    t0 = Date.now();
  };
}

/** runs fn (synchronous) and reports it when it took SLOW_MS or more; returns its result */
export function timed(name, fn) {
  const t0 = Date.now();

  try {
    return fn();
  } finally {
    const ms = Date.now() - t0;

    if(ms >= SLOW_MS) {
      const at = Date.now();
      slow.push({ at, name, ms });
      if(slow.length > 50) slow.shift();
      emit('lag', `${name} ran for ${fmt(ms)}`, 'warn');
      log({ at, kind: 'slow', name, ms, where: callers() });
    }
  }
}

/** @returns {() => void} stop; describe() names what the harness is doing, for the report */
export function startLagWatch({ describe } = {}) {
  let timer = null;
  let expected = Date.now() + TICK_MS;

  const tick = () => {
    const now = Date.now();
    const lag = now - expected;

    if(lag >= STALL_MS) {
      const inside = slow.filter(s => s.at >= expected && s.at <= now);
      let phase;

      try {
        phase = describe?.();
      } catch(e) {}

      const where = inside.length ? `, in ${inside.map(s => `${s.name} ${fmt(s.ms)}`).join(', ')}` : ', in no timed section';
      emit('lag', `the loop was blocked for ${fmt(lag)}${phase ? ` (${phase})` : ''}${where}`, lag >= 1000 ? 'bad' : 'warn');
      log({ at: now, kind: 'stall', lagMs: lag, phase: phase ?? null, sections: inside.map(s => [s.name, s.ms]) });
    }

    expected = Date.now() + TICK_MS;
    timer = setTimeout(tick, TICK_MS);
  };

  timer = setTimeout(tick, TICK_MS);
  return () => clearTimeout(timer);
}

export const recentSlow = () => slow.slice();
