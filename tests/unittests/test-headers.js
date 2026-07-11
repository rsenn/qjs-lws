import { tests, eq, assert, assertStrictEquals, fail } from './tinytest.js';
import { Headers } from '../../lib/lws/headers.js';

await tests({
  'construct empty'() {
    const h = new Headers();
    eq(null, h.get('x-nope'));
    assertStrictEquals(false, h.has('x-nope'));
  },

  'construct from array of pairs'() {
    const h = new Headers([
      ['Content-Type', 'text/plain'],
      ['X-Foo', 'bar'],
    ]);
    eq('text/plain', h.get('content-type'));
    eq('bar', h.get('x-foo'));
  },

  'construct from plain object'() {
    const h = new Headers({ 'X-A': '1', 'X-B': '2' });
    eq('1', h.get('x-a'));
    eq('2', h.get('x-b'));
  },

  'construct from another Headers'() {
    const a = new Headers({ 'X-A': '1' });
    const b = new Headers(a);
    eq('1', b.get('x-a'));
    b.set('x-a', '2');
    eq('1', a.get('x-a'), 'copy must be independent of the original');
  },

  'names are case-insensitive'() {
    const h = new Headers();
    h.set('Content-Type', 'text/html');
    assertStrictEquals(true, h.has('content-type'));
    assertStrictEquals(true, h.has('CONTENT-TYPE'));
    eq('text/html', h.get('cOnTeNt-TyPe'));
  },

  'append joins repeated values with ", "'() {
    const h = new Headers();
    h.append('x-multi', 'a');
    h.append('x-multi', 'b');
    eq('a, b', h.get('x-multi'));
  },

  'set replaces rather than joins'() {
    const h = new Headers();
    h.append('x-a', 'first');
    h.set('x-a', 'second');
    eq('second', h.get('x-a'));
  },

  'delete removes the header'() {
    const h = new Headers({ 'x-a': '1' });
    h.delete('x-a');
    assertStrictEquals(false, h.has('x-a'));
  },

  'set-cookie: append never comma-joins, get() joins, getSetCookie() lists'() {
    const h = new Headers();
    h.append('set-cookie', 'a=1');
    h.append('set-cookie', 'b=2');
    eq('a=1, b=2', h.get('set-cookie'));
    const all = h.getSetCookie();
    eq(2, all.length);
    eq('a=1', all[0]);
    eq('b=2', all[1]);
  },

  'set-cookie: getSetCookie() is empty array, not null, when unset'() {
    const h = new Headers();
    eq(0, h.getSetCookie().length);
  },

  'forEach visits set-cookie once per stored value'() {
    const h = new Headers();
    h.append('set-cookie', 'a=1');
    h.append('set-cookie', 'b=2');
    h.set('x-other', 'v');
    const seen = [];
    h.forEach((value, name) => seen.push([name, value]));
    eq(3, seen.length);
  },

  'iterator / entries()'() {
    const h = new Headers({ 'x-a': '1', 'x-b': '2' });
    const pairs = [...h].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    eq(2, pairs.length);
    eq('x-a', pairs[0][0]);
    eq('1', pairs[0][1]);
  },

  'keys() / values()'() {
    const h = new Headers({ 'x-a': '1' });
    eq('x-a', [...h.keys()][0]);
    eq('1', [...h.values()][0]);
  },

  'invalid header name throws'() {
    const h = new Headers();
    try {
      h.set('bad name with spaces', 'v');
      fail('expected a throw for an invalid header name');
    } catch(e) {
      assert(e instanceof TypeError, 'expected TypeError, got ' + e);
    }
  },

  'value with embedded CR/LF throws (header-injection guard)'() {
    const h = new Headers();
    try {
      h.set('x-evil', 'good\r\nX-Injected: evil');
      fail('expected a throw for a value containing CRLF');
    } catch(e) {
      assert(e instanceof TypeError, 'expected TypeError, got ' + e);
    }
  },

  'value with embedded NUL throws'() {
    const h = new Headers();
    try {
      h.set('x-evil', 'bad\x00value');
      fail('expected a throw for a value containing NUL');
    } catch(e) {
      assert(e instanceof TypeError, 'expected TypeError, got ' + e);
    }
  },

  'value leading/trailing HTTP whitespace is trimmed'() {
    const h = new Headers();
    h.set('x-a', '  padded  ');
    eq('padded', h.get('x-a'));
  },

  'toObject() keeps set-cookie as an array'() {
    const h = new Headers();
    h.append('set-cookie', 'a=1');
    h.append('set-cookie', 'b=2');
    h.set('x-a', '1');
    const obj = h.toObject();
    assert(Array.isArray(obj['set-cookie']), 'expected set-cookie to be an array');
    eq(2, obj['set-cookie'].length);
    eq('1', obj['x-a']);
  },
});
