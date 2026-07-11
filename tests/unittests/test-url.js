import { tests, eq, assert, assertStrictEquals, fail } from './tinytest.js';
import { URL, URLSearchParams } from '../../lib/lws/url.js';

await tests({
  'full URL parses into every component'() {
    const u = new URL('https://user:pass@example.com:8080/path/to/page?query=1&foo=bar#hash');
    eq('https://user:pass@example.com:8080/path/to/page?query=1&foo=bar#hash', u.href);
    eq('https:', u.protocol);
    eq('user', u.username);
    eq('pass', u.password);
    eq('example.com:8080', u.host);
    eq('example.com', u.hostname);
    eq('8080', u.port);
    eq('/path/to/page', u.pathname);
    eq('?query=1&foo=bar', u.search);
    eq('#hash', u.hash);
    eq('https://example.com:8080', u.origin);
    eq('1', u.searchParams.get('query'));
    eq('bar', u.searchParams.get('foo'));
  },

  'default port is omitted from href and port getter'() {
    const u = new URL('http://example.com/');
    eq('http://example.com/', u.href);
    eq('', u.port);
  },

  'relative resolution against a base'() {
    const u = new URL('../b/c?x=1', 'http://example.com/a/d/e');
    eq('http://example.com/a/b/c?x=1', u.href);
  },

  'setters: pathname/search/hash/port/hostname/protocol'() {
    const u = new URL('http://example.com/');
    u.pathname = '/foo/bar';
    eq('http://example.com/foo/bar', u.href);
    u.search = 'a=1&b=2';
    eq('http://example.com/foo/bar?a=1&b=2', u.href);
    u.hash = 'top';
    eq('http://example.com/foo/bar?a=1&b=2#top', u.href);
    u.port = '9999';
    eq('http://example.com:9999/foo/bar?a=1&b=2#top', u.href);
    u.hostname = 'other.com';
    eq('http://other.com:9999/foo/bar?a=1&b=2#top', u.href);
    u.protocol = 'https';
    eq('https://other.com:9999/foo/bar?a=1&b=2#top', u.href);
  },

  'searchParams mutation writes back through to href'() {
    const u = new URL('http://example.com/?a=1');
    u.searchParams.append('b', '2');
    eq('http://example.com/?a=1&b=2', u.href);
    u.searchParams.set('a', '9');
    eq('http://example.com/?a=9&b=2', u.href);
    u.searchParams.delete('a');
    eq('http://example.com/?b=2', u.href);
  },

  'IPv6 host'() {
    const u = new URL('http://[::1]:8080/');
    eq('[::1]', u.hostname);
    eq('[::1]:8080', u.host);
  },

  'IPv4 host'() {
    const u = new URL('http://192.168.1.1/');
    eq('192.168.1.1', u.hostname);
  },

  'file: URL has empty host'() {
    const u = new URL('file:///etc/passwd');
    eq('/etc/passwd', u.pathname);
    eq('', u.host);
  },

  'opaque-path scheme (mailto:)'() {
    const u = new URL('mailto:foo@example.com');
    eq('foo@example.com', u.pathname);
    eq('', u.host);
  },

  'invalid URL throws TypeError'() {
    try {
      new URL('not a url');
      fail('expected a throw for an invalid URL');
    } catch(e) {
      assert(e instanceof TypeError, 'expected TypeError, got ' + e);
    }
  },

  'invalid base URL throws TypeError'() {
    try {
      new URL('/x', 'not a url');
      fail('expected a throw for an invalid base URL');
    } catch(e) {
      assert(e instanceof TypeError, 'expected TypeError, got ' + e);
    }
  },

  'URL.canParse() / URL.parse() static helpers'() {
    assertStrictEquals(true, URL.canParse('http://example.com/'));
    assertStrictEquals(false, URL.canParse('not a url'));
    assertStrictEquals(null, URL.parse('not a url'));
    assert(URL.parse('http://example.com/') instanceof URL, 'expected a URL instance');
  },

  'toString()/toJSON() both return href'() {
    const u = new URL('http://example.com/x');
    eq(u.href, String(u));
    eq(u.href, u.toJSON());
    eq(u.href, JSON.stringify(u).slice(1, -1));
  },

  'URLSearchParams: construct from string, getAll, sort'() {
    const sp = new URLSearchParams('a=1&b=2&a=3');
    eq('a=1&b=2&a=3', sp.toString());
    eq('1,3', sp.getAll('a').join(','));
    sp.sort();
    eq('a=1&a=3&b=2', sp.toString());
  },

  'URLSearchParams: construct from array of pairs'() {
    const sp = new URLSearchParams([
      ['a', '1'],
      ['b', '2'],
    ]);
    eq('1', sp.get('a'));
    eq('2', sp.get('b'));
  },

  'URLSearchParams: construct from plain object'() {
    const sp = new URLSearchParams({ a: '1', b: '2' });
    eq('a=1&b=2', sp.toString());
  },

  'URLSearchParams: has()/delete() with a value argument'() {
    const sp = new URLSearchParams('a=1&a=2');
    assertStrictEquals(true, sp.has('a', '1'));
    assertStrictEquals(false, sp.has('a', '9'));
    sp.delete('a', '1');
    eq('a=2', sp.toString());
  },

  'URLSearchParams: space is encoded as + on serialization'() {
    const sp = new URLSearchParams();
    sp.set('q', 'hello world');
    eq('q=hello+world', sp.toString());
  },

  'URLSearchParams: percent-decodes on parse'() {
    const sp = new URLSearchParams('q=a%20b%26c');
    eq('a b&c', sp.get('q'));
  },

  'URLSearchParams: size reflects entry count'() {
    const sp = new URLSearchParams('a=1&b=2');
    eq(2, sp.size);
    sp.append('c', '3');
    eq(3, sp.size);
  },

  'URLSearchParams: standalone (no URL) does not throw on mutation'() {
    const sp = new URLSearchParams();
    sp.set('a', '1');
    eq('a=1', sp.toString());
  },
});
