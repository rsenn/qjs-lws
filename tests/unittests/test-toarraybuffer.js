import { tests, eq } from './tinytest.js';
import { toArrayBuffer } from 'lws.so';

await tests({
  'toArrayBuffer(view) without offset covers the whole view'() {
    eq(3, toArrayBuffer(new Uint8Array([1, 2, 3])).byteLength);
  },

  'toArrayBuffer(view, offset) and (view, offset, length)'() {
    const u = new Uint8Array([1, 2, 3, 4]);

    eq(3, toArrayBuffer(u, 1).byteLength);
    eq(2, toArrayBuffer(u, 1, 2).byteLength);
  },

  'toArrayBuffer(subarray) honours the view offset'() {
    const u = new Uint8Array([1, 2, 3, 4]);

    eq(3, toArrayBuffer(u.subarray(1)).byteLength);
  },
});
