import { tests, eq, assert, assertStrictEquals, fail } from './tinytest.js';
import { LWSSockAddr46 } from 'lws';

const AF_INET = 2;
const AF_INET6 = 10;

await tests({
  'empty construction'() {
    const a = new LWSSockAddr46();
    assert(a instanceof ArrayBuffer, 'expected LWSSockAddr46 to be an ArrayBuffer');
  },

  'construct from an IPv4 numeric string'() {
    const a = new LWSSockAddr46('127.0.0.1');
    eq(AF_INET, a.family);
    eq('127.0.0.1', a.host);
  },

  'construct from an IPv6 numeric string + port'() {
    const a = new LWSSockAddr46('::1', 8080);
    eq(AF_INET6, a.family);
    eq(8080, a.port);
  },

  'port is settable'() {
    const a = new LWSSockAddr46('127.0.0.1');
    a.port = 443;
    eq(443, a.port);
  },

  'host is settable and round-trips'() {
    const a = new LWSSockAddr46();
    a.host = '10.0.0.5';
    eq('10.0.0.5', a.host);
    eq(AF_INET, a.family);
  },

  'toString() formats as address:port'() {
    const a = new LWSSockAddr46('192.168.1.1', 22);
    eq('192.168.1.1:22', a.toString());
  },

  'toString() brackets IPv6 addresses'() {
    const a = new LWSSockAddr46('::1', 22);
    eq('[::1]:22', a.toString());
  },

  'compare(): equal addresses compare equal'() {
    const a = new LWSSockAddr46('127.0.0.1', 80);
    const b = new LWSSockAddr46('127.0.0.1', 80);
    eq(0, a.compare(b));
  },

  'compare(): different addresses do not compare equal'() {
    const a = new LWSSockAddr46('127.0.0.1', 80);
    const b = new LWSSockAddr46('127.0.0.2', 80);
    assert(a.compare(b) !== 0, 'expected different addresses to compare unequal');
  },

  'onNet(): same /24 network'() {
    const a = new LWSSockAddr46('192.168.1.1');
    const b = new LWSSockAddr46('192.168.1.200');
    assertStrictEquals(true, a.onNet(b, 24));
  },

  'onNet(): different /24 network'() {
    const a = new LWSSockAddr46('192.168.1.1');
    const b = new LWSSockAddr46('192.168.2.1');
    assertStrictEquals(false, a.onNet(b, 24));
  },
});
