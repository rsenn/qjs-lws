/* TextDecoder/TextEncoder stand-ins for the tests, built on the lws.so
   toString()/toArrayBuffer() helpers so tests/ needs no module outside
   std, os and lws.so (no textcode) */
import { toString, toArrayBuffer } from 'lws.so';

export class TextDecoder {
  decode(value) {
    return value === undefined ? '' : toString(value);
  }
}

export class TextEncoder {
  encode(text) {
    return new Uint8Array(toArrayBuffer(text));
  }
}
