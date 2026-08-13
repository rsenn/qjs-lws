import { tests, eq, assert, assertStrictEquals, fail } from './tinytest.js';
import { Body } from '../../lib/lws/body.js';
import { TextEncoder } from 'textcode';

await tests({
  'null/undefined body means no body'() {
    const a = new Body(undefined);
    const b = new Body(null);
    eq(null, a.body);
    eq(null, b.body);
    assertStrictEquals(false, a.bodyUsed);
  },

  async 'text()/arrayBuffer()/blob() resolve to empty for a null/undefined body, matching WHATWG Request/Response'() {
    for(const init of [null, undefined]) {
      eq('', await new Body(init).text());
      eq(0, (await new Body(init).arrayBuffer()).byteLength);
      eq(0, (await new Body(init).blob()).size);
    }
  },

  async 'json() throws a SyntaxError (not a TypeError) for a null/undefined body'() {
    try {
      await new Body(null).json();
      fail('expected a throw for an empty (null-body) JSON parse');
    } catch(e) {
      assert(e instanceof SyntaxError, 'expected SyntaxError, got ' + e);
    }
  },

  async 'string body round-trips through text()'() {
    const b = new Body('hello world');
    eq('hello world', await b.text());
  },

  async 'ArrayBuffer body round-trips through text() (UTF-8)'() {
    const bytes = new TextEncoder().encode('binary café').buffer;
    const b = new Body(bytes);
    eq('binary café', await b.text());
  },

  async 'Uint8Array (view) body round-trips through arrayBuffer()'() {
    const view = new TextEncoder().encode('view body');
    const b = new Body(view);
    const ab = await b.arrayBuffer();
    eq(view.byteLength, ab.byteLength);
    eq('view body', new Body(ab).text ? await new Body(ab).text() : '');
  },

  async 'json() parses the body as JSON'() {
    const b = new Body(JSON.stringify({ a: 1, b: [2, 3] }));
    const j = await b.json();
    eq(1, j.a);
    eq(2, j.b[0]);
    eq(3, j.b[1]);
  },

  async 'bodyUsed flips true after reading'() {
    const b = new Body('x');
    assertStrictEquals(false, b.bodyUsed);
    await b.text();
    assertStrictEquals(true, b.bodyUsed);
  },

  async 'formData() parses application/x-www-form-urlencoded'() {
    const b = new Body('a=1&b=hello+world&a=2');
    b.headers = { get: () => 'application/x-www-form-urlencoded' };
    const fd = await b.formData();
    eq('hello world', fd.get('b'));
    const aValues = fd.getAll('a');
    assert(Array.isArray(aValues), 'repeated key should collect into an array');
    eq('1', aValues[0]);
    eq('2', aValues[1]);
  },

  'constructing with an unsupported body type throws'() {
    try {
      new Body(42);
      fail('expected a throw for a number body');
    } catch(e) {
      assert(e instanceof TypeError, 'expected TypeError, got ' + e);
    }
  },
});
