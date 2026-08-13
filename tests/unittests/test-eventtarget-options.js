import { tests, eq, assert } from './tinytest.js';
import { EventTarget } from '../../lib/lws/events.js';
import { AbortController } from '../../lib/lws/abort.js';

function createEvent(type) {
  return { type };
}

await tests({
  'addEventListener with once option fires listener only once'() {
    const target = new EventTarget();
    let count = 0;
    
    target.addEventListener('test', () => count++, { once: true });
    
    target.dispatchEvent(createEvent('test'));
    eq(1, count, 'listener should fire once');
    
    target.dispatchEvent(createEvent('test'));
    eq(1, count, 'listener should not fire again');
  },

  'addEventListener with once option auto-removes listener'() {
    const target = new EventTarget();
    const listener = () => {};
    
    target.addEventListener('test', listener, { once: true });
    target.dispatchEvent(createEvent('test'));
    
    // Try to remove - should be safe even though already removed
    target.removeEventListener('test', listener);
  },

  'addEventListener with signal option removes listener on abort'() {
    const target = new EventTarget();
    const controller = new AbortController();
    let count = 0;
    
    target.addEventListener('test', () => count++, { signal: controller.signal });
    
    target.dispatchEvent(createEvent('test'));
    eq(1, count, 'listener should fire before abort');
    
    controller.abort();
    
    target.dispatchEvent(createEvent('test'));
    eq(1, count, 'listener should not fire after abort');
  },

  'addEventListener with already aborted signal does not add listener'() {
    const target = new EventTarget();
    const controller = new AbortController();
    controller.abort();
    
    let count = 0;
    target.addEventListener('test', () => count++, { signal: controller.signal });
    
    target.dispatchEvent(createEvent('test'));
    eq(0, count, 'listener should not be added when signal already aborted');
  },

  'removeEventListener works with wrapped listeners'() {
    const target = new EventTarget();
    const controller = new AbortController();
    const listener = () => {};
    
    target.addEventListener('test', listener, { signal: controller.signal });
    target.removeEventListener('test', listener);
    
    // Listener should be removed
    controller.abort(); // Should not error even though listener is gone
  },

  'multiple listeners with once option'() {
    const target = new EventTarget();
    let count1 = 0, count2 = 0;
    
    target.addEventListener('test', () => count1++, { once: true });
    target.addEventListener('test', () => count2++);
    
    target.dispatchEvent(createEvent('test'));
    eq(1, count1, 'once listener should fire');
    eq(1, count2, 'regular listener should fire');
    
    target.dispatchEvent(createEvent('test'));
    eq(1, count1, 'once listener should not fire again');
    eq(2, count2, 'regular listener should fire again');
  },

  'same listener with different options'() {
    const target = new EventTarget();
    const listener = () => {};
    const controller1 = new AbortController();
    const controller2 = new AbortController();
    
    target.addEventListener('test', listener, { signal: controller1.signal });
    target.addEventListener('test', listener, { signal: controller2.signal });
    
    controller1.abort();
    controller2.abort();
    
    // Both should be removed without error
  },

  'removeEventListener without options still works'() {
    const target = new EventTarget();
    let count = 0;
    const listener = () => count++;
    
    target.addEventListener('test', listener);
    target.dispatchEvent(createEvent('test'));
    eq(1, count);
    
    target.removeEventListener('test', listener);
    target.dispatchEvent(createEvent('test'));
    eq(1, count, 'listener should be removed');
  },
});
