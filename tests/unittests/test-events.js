import { tests, eq, assert, assertStrictEquals, fail } from './tinytest.js';
import { EventTarget, EventTargetProperties, once, waitOne } from '../../lib/lws/events.js';

await tests({
  'addEventListener / dispatchEvent invokes the listener'() {
    const t = new EventTarget();
    let received;
    t.addEventListener('ping', e => (received = e));
    t.dispatchEvent({ type: 'ping', detail: 42 });
    assert(received, 'listener was never called');
    eq(42, received.detail);
  },

  'dispatchEvent sets event.target'() {
    const t = new EventTarget();
    let target;
    t.addEventListener('ping', e => (target = e.target));
    t.dispatchEvent({ type: 'ping', detail: 1 });
    assertStrictEquals(t, target);
  },

  'removeEventListener stops future delivery'() {
    const t = new EventTarget();
    let count = 0;
    const fn = () => count++;
    t.addEventListener('ping', fn);
    t.dispatchEvent({ type: 'ping' });
    t.removeEventListener('ping', fn);
    t.dispatchEvent({ type: 'ping' });
    eq(1, count);
  },

  'multiple listeners for the same type all fire, in order'() {
    const t = new EventTarget();
    const order = [];
    t.addEventListener('ping', () => order.push('a'));
    t.addEventListener('ping', () => order.push('b'));
    t.dispatchEvent({ type: 'ping' });
    eq('a,b', order.join(','));
  },

  'dispatchEvent with no listeners is a no-op, does not throw'() {
    const t = new EventTarget();
    t.dispatchEvent({ type: 'nope' });
  },

  'addEventListener rejects a non-function listener'() {
    const t = new EventTarget();
    try {
      t.addEventListener('ping', 'not a function');
      fail('expected a throw for a non-function listener');
    } catch(e) {
      assert(e instanceof TypeError, 'expected TypeError, got ' + e);
    }
  },

  'EventTargetProperties: on<type> setter registers, getter reads back'() {
    const Klass = EventTargetProperties(['open']);
    const t = new Klass();
    let fired = false;
    t.onopen = () => (fired = true);
    assert(typeof t.onopen === 'function', 'expected onopen getter to read back the handler');
    t.dispatchEvent({ type: 'open' });
    assertStrictEquals(true, fired);
  },

  'EventTargetProperties: reassigning on<type> replaces the old handler'() {
    const Klass = EventTargetProperties(['open']);
    const t = new Klass();
    let calls = 0;
    t.onopen = () => calls++;
    t.onopen = () => (calls += 10);
    t.dispatchEvent({ type: 'open' });
    eq(10, calls);
  },
 
  async 'once(emitter, type) resolves with the next matching event'() {
    const t = new EventTarget();
    const p = once(t, 'ping');
    t.dispatchEvent({ type: 'ping', detail: 7 });
    const ev = await p;
    eq(7, ev.detail);
  },

  async 'waitOne resolves with whichever of several types fires first'() {
    const t = new EventTarget();
    const p = waitOne(t, ['a', 'b']);
    t.dispatchEvent({ type: 'b', detail: 'won' });
    const ev = await p;
    eq('b', ev.type);
    eq('won', ev.detail);
  },
});
