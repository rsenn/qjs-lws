/**
 * lws.crypto: digest, hmac and ECDSA (P-256/384/521) primitives.
 */
import { tests, assert, assertEquals } from './tinytest.js';
import { crypto } from 'lws';

const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const enc = s => new TextEncoder().encode(s);

await tests({
  'digest: known vectors'() {
    assertEquals(hex(crypto.digest('SHA-256', enc('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assertEquals(hex(crypto.digest('SHA-1', enc('abc'))), 'a9993e364706816aba3e25717850c26c9cd0d89d');
    assertEquals(crypto.digest('sha384', enc('')).byteLength, 48);
    assertEquals(crypto.digest('SHA-512', new Uint8Array(0)).byteLength, 64);
  },
  'digest: honours the view offset'() {
    const b = new Uint8Array([9, 9, 97, 98, 99, 9]);
    assertEquals(hex(crypto.digest('SHA-1', b.subarray(2, 5))), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  },
  'digest: bad input throws'() {
    let e;
    try { crypto.digest('MD5', enc('x')); } catch(x) { e = x; }
    assert(e instanceof TypeError);
    e = undefined;
    try { crypto.digest('SHA-256', 'str'); } catch(x) { e = x; }
    assert(e instanceof TypeError);
  },
  'hmac: RFC 4231 test case 2'() {
    assertEquals(hex(crypto.hmac('SHA-256', enc('Jefe'), enc('what do ya want for nothing?'))), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  },
  'ec: generate, sign, verify for every curve'() {
    for(const [curve, size] of [['P-256', 32], ['P-384', 48], ['P-521', 66]]) {
      const { d, x, y } = crypto.ecGenerateKey(curve);
      assertEquals([d.byteLength, x.byteLength, y.byteLength].join(), [size, size, size].join());
      assert(crypto.ecValidatePoint(curve, x, y));
      const pub = crypto.ecPublicKey(curve, d);
      assertEquals(hex(pub.x), hex(x));
      assertEquals(hex(pub.y), hex(y));
      const data = enc('hello ' + curve);
      const sig = crypto.ecSign(curve, d, 'SHA-256', data);
      assertEquals(sig.byteLength, 2 * size);
      assert(crypto.ecVerify(curve, x, y, 'SHA-256', sig, data));
      assert(!crypto.ecVerify(curve, x, y, 'SHA-256', sig, enc('tampered')));
      assert(!crypto.ecVerify(curve, x, y, 'SHA-384', sig, data));
      assert(!crypto.ecVerify(curve, x, y, 'SHA-256', sig.slice(1), data));
    }
  },
  'ec: a point off the curve is rejected'() {
    const { x, y } = crypto.ecGenerateKey('P-256');
    const bad = new Uint8Array(y);
    bad[31] ^= 1;
    assert(!crypto.ecValidatePoint('P-256', x, bad));
    assert(!crypto.ecValidatePoint('P-256', x, y.slice(1)));
    assert(!crypto.ecValidatePoint('P-256', new Uint8Array(32), new Uint8Array(32)));
    let e;
    try { crypto.ecVerify('P-256', x, bad, 'SHA-256', new Uint8Array(64), enc('x')); } catch(x) { e = x; }
    assert(e instanceof RangeError);
  },
  'ec: invalid private keys throw'() {
    for(const d of [new Uint8Array(32), new Uint8Array(33).fill(1), new Uint8Array(32).fill(255)]) {
      let e;
      try { crypto.ecPublicKey('P-256', d); } catch(x) { e = x; }
      assert(e instanceof RangeError);
    }
  },
  'ec: known P-256 public key of d=1 is the generator'() {
    const d = new Uint8Array(32); d[31] = 1;
    assertEquals(hex(crypto.ecPublicKey('P-256', d).x), '6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296');
  },
});
