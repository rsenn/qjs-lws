import { tests, eq, assert, assertStrictEquals, fail } from './tinytest.js';
import { SimpleQueue } from '../../lib/lws/simple-queue.js';

await tests({
  'starts empty'() {
    const q = new SimpleQueue();
    eq(0, q.length);
  },

  'push/shift is FIFO'() {
    const q = new SimpleQueue();
    q.push('a');
    q.push('b');
    q.push('c');
    eq(3, q.length);
    eq('a', q.shift());
    eq('b', q.shift());
    eq(1, q.length);
    eq('c', q.shift());
    eq(0, q.length);
  },

  'peek does not remove'() {
    const q = new SimpleQueue();
    q.push('x');
    eq('x', q.peek());
    eq(1, q.length);
    eq('x', q.shift());
  },

  'forEach visits every element in order'() {
    const q = new SimpleQueue();
    for(const x of [1, 2, 3]) q.push(x);
    const seen = [];
    q.forEach(v => seen.push(v));
    eq('1,2,3', seen.join(','));
  },

  'is iterable and draining it empties the queue'() {
    const q = new SimpleQueue();
    for(const x of ['a', 'b', 'c']) q.push(x);
    const out = [...q];
    eq('a,b,c', out.join(','));
    eq(0, q.length);
  },

  'handles more than one internal array-node worth of elements'() {
    const q = new SimpleQueue();
    const n = 16384 + 5; // QUEUE_MAX_ARRAY_SIZE + a few, forces a node split
    for(let i = 0; i < n; i++) q.push(i);
    eq(n, q.length);
    for(let i = 0; i < n; i++) eq(i, q.shift());
    eq(0, q.length);
  },
});
