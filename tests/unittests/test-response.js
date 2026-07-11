import { tests, eq, assert, assertStrictEquals, fail } from './tinytest.js';
import { Response } from '../../lib/lws/response.js';

await tests({
  'default status is 200, ok is true'() {
    const r = new Response('body');
    eq(200, r.status);
    assertStrictEquals(true, r.ok);
  },

  'ok is false outside 200-299'() {
    const r = new Response('nope', { status: 404 });
    assertStrictEquals(false, r.ok);
  },

  'status out of [200,599] throws'() {
    try {
      new Response(null, { status: 100 });
      fail('expected a throw for status 100');
    } catch(e) {
      assert(e instanceof RangeError, 'expected RangeError, got ' + e);
    }
  },

  'new Response(null) does not throw (standard no-body idiom)'() {
    const r = new Response(null, { status: 204 });
    eq(204, r.status);
    eq(null, r.body);
  },

  'redirected defaults to false and clone() preserves it'() {
    const r = new Response('x');
    assertStrictEquals(false, r.redirected);
    const r2 = new Response('x', { redirected: true });
    assertStrictEquals(true, r2.redirected);
    const c = r2.clone();
    assertStrictEquals(true, c.redirected);
  },

  'Response.error() returns a network-error response'() {
    const r = Response.error();
    eq(0, r.status);
    eq('error', r.type);
    assertStrictEquals(false, r.ok);
  },

  'Response.redirect() defaults to status 302'() {
    const r = Response.redirect('http://example.com/');
    eq(302, r.status);
    eq('http://example.com/', r.headers.get('location'));
  },

  'Response.redirect() accepts an explicit valid status'() {
    const r = Response.redirect('http://example.com/', 307);
    eq(307, r.status);
  },

  'Response.redirect() rejects a non-redirect status'() {
    try {
      Response.redirect('http://example.com/', 200);
      fail('expected a throw for status 200');
    } catch(e) {
      assert(e instanceof RangeError, 'expected RangeError, got ' + e);
    }
  },

  async 'Response.json() sets content-type and serializes the body'() {
    const r = Response.json({ a: 1 });
    eq('application/json; charset=utf-8', r.headers.get('content-type'));
    const body = await r.text();
    eq(1, JSON.parse(body).a);
  },

  'cookie() appends a Set-Cookie header'() {
    const r = new Response('x');
    r.cookie('a', '1', { httpOnly: true, path: '/' });
    const sc = r.headers.get('set-cookie');
    assert(sc.startsWith('a=1'), 'expected cookie value, got ' + sc);
    assert(sc.includes('HttpOnly'), 'expected HttpOnly flag, got ' + sc);
    assert(sc.includes('Path=/'), 'expected Path attribute, got ' + sc);
  },

  'clearCookie() expires the cookie immediately'() {
    const r = new Response('x');
    r.clearCookie('a');
    const sc = r.headers.get('set-cookie');
    assert(sc.includes('Max-Age=0'), 'expected Max-Age=0, got ' + sc);
  },

  'clone() copies status/statusText/headers/url independently'() {
    const r = new Response('x', { status: 201, statusText: 'Created', headers: { 'x-a': '1' }, url: 'http://example.com/' });
    const c = r.clone();
    eq(201, c.status);
    eq('Created', c.statusText);
    eq('http://example.com/', c.url);
    c.headers.set('x-a', '2');
    eq('1', r.headers.get('x-a'), 'clone must not share the Headers instance');
  },
});
