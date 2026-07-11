import { tests, eq, assert, assertStrictEquals, fail } from './tinytest.js';
import { LinkedList } from '../../lib/lws/list.js';

await tests({
  'empty list'() {
    const l = new LinkedList();
    assertStrictEquals(true, l.empty);
  },

  'construct from an iterable'() {
    const l = new LinkedList([1, 2, 3]);
    assertStrictEquals(false, l.empty);
    eq(1, l.front);
    eq(3, l.back);
  },

  'pushBack / front / back'() {
    const l = new LinkedList();
    l.pushBack('a');
    l.pushBack('b');
    eq('a', l.front);
    eq('b', l.back);
  },

  'pushFront'() {
    const l = new LinkedList();
    l.pushBack('a');
    l.pushFront('z');
    eq('z', l.front);
    eq('a', l.back);
  },

  'popFront / popBack return and remove'() {
    const l = new LinkedList([1, 2, 3]);
    eq(1, l.popFront());
    eq(3, l.popBack());
    eq(2, l.front);
    eq(2, l.back);
  },

  'popFront on empty list throws'() {
    const l = new LinkedList();
    let threw = false;
    try {
      l.popFront();
    } catch(e) {
      threw = true;
    }
    assertStrictEquals(true, threw, 'expected popFront() on an empty list to throw');
  },

  'appendRange / prependRange'() {
    const l = new LinkedList([2, 3]);
    l.appendRange([4, 5]);
    l.prependRange([0, 1]);

    const out = [];
    while(!l.empty) out.push(l.popFront());
    eq('0,1,2,3,4,5', out.join(','));
  },

  'FIFO order via repeated pushBack/popFront'() {
    const l = new LinkedList();
    for(const x of [1, 2, 3, 4]) l.pushBack(x);
    const out = [];
    while(!l.empty) out.push(l.popFront());
    eq('1,2,3,4', out.join(','));
  },
});
