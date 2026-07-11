import { tests, eq, assert, assertStrictEquals, fail } from './tinytest.js';
import { Request } from '../../lib/lws/request.js';

await tests({
  'default method is GET'() {
    const r = new Request('http://example.com/');
    eq('GET', r.method);
  },

  'method is uppercased for the six standard verbs'() {
    for(const m of ['get', 'head', 'post', 'put', 'delete', 'options']) {
      const r = new Request('http://example.com/', { method: m });
      eq(m.toUpperCase(), r.method);
    }
  },

  'url is stored as given'() {
    const r = new Request('http://example.com/path?q=1');
    eq('http://example.com/path?q=1', r.url);
  },

  'headers option becomes a Headers instance'() {
    const r = new Request('http://example.com/', { headers: { 'x-a': '1' } });
    eq('1', r.headers.get('x-a'));
  },

  'GET with a body throws'() {
    try {
      new Request('http://example.com/', { method: 'GET', body: 'nope' });
      fail('expected a throw for GET + body');
    } catch(e) {
      assert(e instanceof TypeError, 'expected TypeError, got ' + e);
    }
  },

  async 'POST with a body is readable via text()'() {
    const r = new Request('http://example.com/', { method: 'POST', body: 'hello' });
    eq('hello', await r.text());
  },

  'clone() copies method/url/headers independently'() {
    const r = new Request('http://example.com/', { headers: { 'x-a': '1' } });
    const c = r.clone();
    eq(r.method, c.method);
    eq(r.url, c.url);
    c.headers.set('x-a', '2');
    eq('1', r.headers.get('x-a'), 'clone must not share the Headers instance');
  },

  'constructing from another Request copies method/url/headers'() {
    const a = new Request('http://example.com/', { method: 'POST', headers: { 'x-a': '1' } });
    const b = new Request(a);
    eq('POST', b.method);
    eq('http://example.com/', b.url);
    eq('1', b.headers.get('x-a'));
  },

  'cookies getter parses the Cookie header'() {
    const r = new Request('http://example.com/', { headers: { cookie: 'a=1; b=2' } });
    eq('1', r.cookies.a);
    eq('2', r.cookies.b);
  },

  'cookies getter is empty object with no Cookie header'() {
    const r = new Request('http://example.com/');
    eq(0, Object.keys(r.cookies).length);
  },
});
