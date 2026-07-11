import { tests, eq, assert, assertStrictEquals, fail } from './tinytest.js';
import { AbortController, AbortSignal } from '../../lib/lws/abort.js';

await tests({
  'signal.aborted starts false'() {
    const c = new AbortController();
    assertStrictEquals(false, c.signal.aborted);
  },

  'abort() flips aborted and sets reason'() {
    const c = new AbortController();
    c.abort('because');
    assertStrictEquals(true, c.signal.aborted);
    eq('because', c.signal.reason);
  },

  'abort() with no reason gets a default AbortError'() {
    const c = new AbortController();
    c.abort();
    assertStrictEquals(true, c.signal.aborted);
    assert(c.signal.reason != null, 'expected a default reason to be set');
  },

  'abort event fires on listeners'() {
    const c = new AbortController();
    let fired = false;
    c.signal.addEventListener('abort', () => (fired = true));
    c.abort();
    assertStrictEquals(true, fired);
  },

  'onabort property-style handler fires'() {
    const c = new AbortController();
    let fired = false;
    c.signal.onabort = () => (fired = true);
    c.abort();
    assertStrictEquals(true, fired);
  },

  'throwIfAborted() throws the reason once aborted, no-ops before'() {
    const c = new AbortController();
    c.signal.throwIfAborted(); // must not throw yet

    c.abort('boom');
    try {
      c.signal.throwIfAborted();
      fail('expected throwIfAborted() to throw after abort()');
    } catch(e) {
      eq('boom', e);
    }
  },

  'AbortSignal.abort(reason) returns an already-aborted signal'() {
    const s = AbortSignal.abort('preaborted');
    assertStrictEquals(true, s.aborted);
    eq('preaborted', s.reason);
  },

  'AbortSignal.any() aborts when any input signal aborts'() {
    const a = new AbortController();
    const b = new AbortController();
    const combined = AbortSignal.any([a.signal, b.signal]);
    assertStrictEquals(false, combined.aborted);
    b.abort('from b');
    assertStrictEquals(true, combined.aborted);
    eq('from b', combined.reason);
  },

  'AbortSignal.any() is immediately aborted if an input already is'() {
    const a = new AbortController();
    a.abort('early');
    const combined = AbortSignal.any([a.signal]);
    assertStrictEquals(true, combined.aborted);
    eq('early', combined.reason);
  },
});
