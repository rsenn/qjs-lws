/**
 * lws.crypto: digest, hmac, ECDSA (P-256/384/521) and KDF primitives.
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
  'pbkdf2: RFC 6070 vectors'() {
    assertEquals(hex(crypto.pbkdf2('SHA-1', enc('password'), enc('salt'), 1, 20)), '0c60c80f961f0e71f3a9b524af6012062fe037a6');
    assertEquals(hex(crypto.pbkdf2('SHA-1', enc('password'), enc('salt'), 4096, 20)), '4b007901b765489abead49d926f721d065a429c1');
    assertEquals(hex(crypto.pbkdf2('SHA-1', enc('passwordPASSWORDpassword'), enc('saltSALTsaltSALTsaltSALTsaltSALTsalt'), 4096, 25)), '3d2eec4fe41c849b80c8d83662c0e44a8b291a964cf2f07038');
  },
  'hkdf: RFC 5869 test case 1'() {
    const ikm = new Uint8Array(22).fill(0x0b);
    const salt = Uint8Array.from({ length: 13 }, (_, i) => i);
    const info = Uint8Array.from({ length: 10 }, (_, i) => 0xf0 + i);
    assertEquals(hex(crypto.hkdf('SHA-256', ikm, salt, info, 42)), '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');
  },
  'scrypt: RFC 7914 vector'() {
    assertEquals(hex(crypto.scrypt(enc(''), enc(''), { N: 16, r: 1, p: 1, length: 64 })), '77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906');
  },
  'argon2id: reference vector (password/somesalt, m=64MiB t=2 p=1)'() {
    assertEquals(hex(crypto.argon2id(enc('password'), enc('somesalt'), { memoryCost: 65536, timeCost: 2, parallelism: 1 })), '09316115d5cf24ed5a15a31a3ba326e5cf32edc24702987c02b6566f61913cf7');
  },
  'argon2id: hashes made by Bun (p=1) and libargon2 (p=4)'() {
    const salt1 = Uint8Array.from(atob('awvqMMOaSUUKHDRYM7dmL2Ka8VafWPKgtkOikgI2NM8='), c => c.charCodeAt(0));
    const h1 = crypto.argon2id(enc('hunter2'), salt1, { memoryCost: 1024, timeCost: 3 });
    assertEquals(btoa(String.fromCharCode(...new Uint8Array(h1))), '1QRSDfjWSEARVfuJdSMN4e0s1vxVorwZAwYjtt4sp+Q=');
    const salt4 = Uint8Array.from(atob('R2EvVFVXcG82UjRIRzJwcg=='), c => c.charCodeAt(0));
    const h4 = crypto.argon2id(enc('pw'), salt4, { memoryCost: 256, timeCost: 3, parallelism: 4 });
    assertEquals(btoa(String.fromCharCode(...new Uint8Array(h4))), 'aWLcnJid+RUFDsnqwV743YuwfpL4dsFsy20TOL1D0k4=');
  },
  'argon2id: long output'() {
    const h = crypto.argon2id(enc('x'), enc('saltsalt'), { memoryCost: 64, hashLength: 100 });
    assertEquals(h.byteLength, 100);
  },
  'argon2id: bad parameters throw RangeError'() {
    for(const o of [{ timeCost: 0 }, { memoryCost: 4 }, { hashLength: 3 }, { parallelism: 0 }]) {
      let e;
      try { crypto.argon2id(enc('x'), enc('saltsalt'), { memoryCost: 64, ...o }); } catch(x) { e = x; }
      assert(e instanceof RangeError);
    }
    let e;
    try { crypto.argon2id(enc('x'), enc('short')); } catch(x) { e = x; }
    assert(e instanceof RangeError);
  },
});
