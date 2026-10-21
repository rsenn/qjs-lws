/**
 * Output into a caller range: lws.View() and every LWSSocket method that
 * writes into a buffer. Each test runs both destination forms:
 *   (ArrayBuffer, offset | [offset])   offset in, [0] updated
 *   (wrapped struct lwsjs_view)        cursor advanced in place
 */
import { tests, eq, assert, fail } from './tinytest.js';
import { logLevel, LWSContext, createServer, View, Buffer, write, toString, toArrayBuffer, toPointer, LWSMPRO_CALLBACK, LWS_WRITE_HTTP_FINAL, WSI_TOKEN_HTTP_CONTENT_TYPE, LCCSCF_HTTP_MULTIPART_MIME } from 'lws.so';
import * as std from 'std';
import { freePort } from './subprocess-utils.js';

logLevel(0, () => {});

const gcAndCheck = () => std.gc();
const bytes = b => [...new Uint8Array(b)].join(',');
const text = (b, n) => toString(b, 0, n);

function throws(fn, name) {
  try {
    fn();
  } catch(e) {
    if(name) eq(name, e.name);
    return;
  }
  fail(`expected ${name ?? 'an exception'}`);
}

/* runs fn(wsi, view) in the client handshake of a GET against an in-process server and
   resolves with what the server saw of the x-view-* request headers */
async function handshake(fn) {
  const port = freePort();
  let ctx, extra, resolve, reject;
  const done = new Promise((res, rej) => ((resolve = res), (reject = rej)));

  const server = createServer({
    port,
    vhostName: 'localhost',
    mounts: [{ mountpoint: '/', protocol: 'http', originProtocol: LWSMPRO_CALLBACK }],
    protocols: [
      {
        name: 'http',
        onHttp(wsi) {
          resolve({ ...wsi.headers });
        },
      },
    ],
  });

  ctx = new LWSContext({
    protocols: [
      {
        name: 'http',
        onClientAppendHandshakeHeader(wsi, view) {
          try {
            extra = fn(wsi, view);
          } catch(e) {
            reject(e);
          }
        },
        onClientConnectionError(wsi, msg) {
          reject(new Error(msg));
        },
      },
    ],
  });
  ctx.clientConnect({ address: 'localhost', port, path: '/', host: 'localhost', method: 'GET', protocol: 'http' });

  let seen;
  try {
    seen = await done;
  } finally {
    ctx.cancelService();
    ctx.destroy();
    server.destroy();
  }

  return { seen, extra };
}

await tests({
  'View: new and plain call alike, 16 byte ArrayBuffer with the range methods'() {
    const b = new ArrayBuffer(8);
    for(const v of [new View(b), View(b)]) {
      assert(v instanceof View);
      assert(!(v instanceof ArrayBuffer));
      eq(View.prototype, Object.getPrototypeOf(v));
      eq(8, v.avail);
      assert(!('written' in v));
      assert(!('reset' in v));
    }
  },

  'Buffer: new and plain call alike, a View that also knows where it started'() {
    const b = new ArrayBuffer(8);
    for(const v of [new Buffer(b, 2), Buffer(b, 2)]) {
      assert(v instanceof Buffer);
      assert(v instanceof View);
      assert(!(v instanceof ArrayBuffer));
      eq(Buffer.prototype, Object.getPrototypeOf(v));
      eq(View.prototype, Object.getPrototypeOf(Buffer.prototype));
      eq(6, v.avail);
      eq(6, v.capacity);
      eq(0, v.written);
    }
  },

  'View: (buffer, offset, length) defaults and sources'() {
    const b = new ArrayBuffer(8);
    eq(6, new View(b, 2).avail);
    eq(3, new View(b, 2, 3).avail);
    eq(0, new View(b, 8).avail);
    eq(0, new View(b, 8, 0).avail);
    eq(4, new View(new Uint8Array(b, 4)).avail);
    eq(4, new View(new DataView(b, 4)).avail);
    eq(2, new View(new Uint8Array(b, 4), 1, 2).avail);
    eq(2, new View(b, undefined, 2).avail);
  },

  'Buffer: skip(), reset(), pointer'() {
    const b = new ArrayBuffer(8),
      v = new Buffer(b, 2, 4);

    eq(v, v.write('ab') && v.skip(1));
    eq(3, v.written);
    eq(1, v.avail);
    eq(0, v.skip(99).avail);
    eq(v, v.reset());
    eq(0, v.written);
    eq(4, v.avail);
    v.write('hi');
    eq(toPointer(b) + 4, Number(v.pointer));
    eq(toPointer(b) + 2, Number(v.reset().pointer));
  },

  'Buffer: toString() and toArrayBuffer() return the bytes written so far'() {
    const v = new Buffer(new ArrayBuffer(8), 2, 4);

    eq('', v.toString());
    eq(0, v.toArrayBuffer().byteLength);
    v.write('hi');
    eq('hi', v.toString());
    eq('104,105', bytes(v.toArrayBuffer()));
    v.write('xyz');
    eq('hixy', v.toString());
    eq('', v.reset().toString());

    const o = new Buffer();
    o.write('héllo');
    eq('héllo', o.toString());
    eq(6, o.toArrayBuffer().byteLength);
    eq(o.toArrayBuffer().byteLength, o.written);
  },

  'Buffer: Buffer(size) and Buffer() own LWS_PRE + size, writable and detachable'() {
    const d = new Buffer(),
      v = new Buffer(4096);

    assert(v instanceof Buffer);
    eq(4096, v.avail);
    eq(4096, v.capacity);
    eq(0, v.written);
    assert(d.avail >= 256 && d.avail < 4096, d.avail);
    eq(5, write('hello', v));
    eq(5, v.written);
    eq(4091, v.avail);
    eq(d.avail, new Buffer(undefined).avail);
    eq(0, new Buffer(0).avail);
    eq(0, write('x', new Buffer(0)));
    v.detach();
    throws(() => v.avail, 'TypeError');
    new Buffer(8).detach();
    gcAndCheck();
  },

  'View: needs a buffer, no size'() {
    throws(() => new View(), 'TypeError');
    throws(() => new View(4), 'TypeError');
    throws(() => new View('string'), 'TypeError');
  },

  'View: bad arguments'() {
    throws(() => new Buffer(-1), 'RangeError');
    throws(() => new Buffer(2 ** 40), 'RangeError');
    const b = new ArrayBuffer(8);
    throws(() => new View('string'), 'TypeError');
    throws(() => new View({}), 'TypeError');
    throws(() => new View(b, 9), 'RangeError');
    throws(() => new View(b, -1), 'RangeError');
    throws(() => new View(b, 2, 7), 'RangeError');
    throws(() => new View(b, 0, -1), 'RangeError');
  },

  'Buffer: write(), avail, written, capacity, detach'() {
    const b = new ArrayBuffer(8);
    const v = new Buffer(b, 2, 4);

    eq(2, v.write('ab'));
    eq(2, v.written);
    eq(4, v.capacity);
    eq(2, v.avail);
    eq(3, v.write(new Uint8Array([99, 100, 101]).buffer) + 1 /* clamped to 2 */);
    eq(0, v.avail);
    eq(0, v.write('more'));
    eq('0,0,97,98,99,100,0,0', bytes(b));

    v.detach();
    throws(() => v.avail, 'TypeError');
  },

  'View: keeps the buffer alive'() {
    let v = new View(new ArrayBuffer(4));
    std.gc();
    eq(2, write('ab', v));
    eq(2, v.avail);
    v = null;
    std.gc();
  },

  'lws.write(): buffer form, number offset'() {
    const b = new ArrayBuffer(8);
    eq(3, write('abc', b, 2));
    eq('0,0,97,98,99,0,0,0', bytes(b));
    eq(1, write('xy', b, 7));
    eq('0,0,97,98,99,0,0,120', bytes(b));
    eq(0, write('q', b, 8));
  },

  'lws.write(): buffer form, [offset] updated'() {
    const b = new ArrayBuffer(8),
      o = [2];
    eq(3, write('abc', b, o));
    eq(5, o[0]);
    eq(2, write(new Uint8Array([1, 2]).buffer, b, o));
    eq(7, o[0]);
    eq(1, write('zzz', b, o));
    eq(8, o[0]);
    eq('0,0,97,98,99,1,2,122', bytes(b));
  },

  'lws.write(): view form'() {
    const b = new ArrayBuffer(8);
    const v = new View(b, 2, 4);
    eq(3, write('abc', v));
    eq(1, write('xyz', v));
    eq(0, write('!', v));
    eq('0,0,97,98,99,120,0,0', bytes(b));
  },

  'lws.write(): same bytes through both forms, string and ArrayBuffer sources'() {
    for(const src of ['héllo', toArrayBuffer('héllo')]) {
      const a = new ArrayBuffer(10),
        c = new ArrayBuffer(10),
        o = [3];
      const n1 = write(src, a, o);
      const n2 = write(src, new View(c, 3));
      eq(n1, n2);
      eq(bytes(a), bytes(c));
      eq(3 + n1, o[0]);
    }
  },

  'lws.write(): bad destination'() {
    throws(() => write('x'), 'TypeError');
    throws(() => write('x', 'str'), 'TypeError');
    throws(() => write('x', new ArrayBuffer(8)), 'InternalError');
    throws(() => write('x', {}, 0), 'TypeError');
  },

  async 'addHeader(): both forms write identical bytes'() {
    const r = await handshake((wsi, view) => {
      const a = new ArrayBuffer(64),
        o = [0];
      const c = new ArrayBuffer(64),
        v = new Buffer(c);
      const n1 = wsi.addHeader('x-view-a', 'one', a, o);
      const n2 = wsi.addHeader('x-view-a', 'one', v);
      const n3 = wsi.addHeader('x-view-b', 'two', a, o);
      const n4 = wsi.addHeader('x-view-b', 'two', v);

      /* the real handshake buffer, through the view lws handed us */
      wsi.addHeader('x-view-c', 'three', view);
      return { n1, n2, n3, n4, o: o[0], written: v.written, a: text(a, o[0]), c: text(c, v.written) };
    });

    eq(r.extra.n1, r.extra.n2);
    eq(r.extra.n3, r.extra.n4);
    eq(r.extra.o, r.extra.written);
    eq(r.extra.o, r.extra.n1 + r.extra.n3);
    eq(r.extra.a, r.extra.c);
    assert(r.extra.a.startsWith('x-view-a:'), r.extra.a);
    assert(r.extra.a.includes('one'));
    assert(r.extra.a.includes('x-view-b:'));
    eq('three', r.seen['x-view-c']);
  },

  async 'addHeader(): offset in, [offset] updated, number offset allowed'() {
    const r = await handshake(wsi => {
      const a = new ArrayBuffer(64);
      const o = [5];
      const n = wsi.addHeader('x-view-d', 'v', a, o);
      const m = wsi.addHeader('x-view-e', 'w', a, 40);
      return { n, o: o[0], m, head: bytes(a).slice(0, 9), tail: text(a.slice(40), m) };
    });

    eq(5 + r.extra.n, r.extra.o);
    eq('0,0,0,0,0', r.extra.head.slice(0, 9));
    assert(r.extra.tail.startsWith('x-view-e:'), r.extra.tail);
  },

  async 'addHeader(): range too small throws, view and offset left alone'() {
    const r = await handshake(wsi => {
      const small = new ArrayBuffer(4),
        o = [0];
      const v = new Buffer(new ArrayBuffer(4));
      let e1, e2;
      try {
        wsi.addHeader('x-view-f', 'too long for four bytes', small, o);
      } catch(e) {
        e1 = e.name;
      }
      try {
        wsi.addHeader('x-view-f', 'too long for four bytes', v);
      } catch(e) {
        e2 = e.name;
      }
      return { e1, e2, o: o[0], written: v.written };
    });

    eq('InternalError', r.extra.e1);
    eq('InternalError', r.extra.e2);
    eq(0, r.extra.o);
    eq(0, r.extra.written);
  },

  async 'addHeader(): token form, both forms'() {
    const r = await handshake(wsi => {
      const a = new ArrayBuffer(64),
        o = [0],
        c = new ArrayBuffer(64),
        v = new Buffer(c);
      wsi.addHeader(WSI_TOKEN_HTTP_CONTENT_TYPE, 'text/plain', a, o);
      wsi.addHeader(WSI_TOKEN_HTTP_CONTENT_TYPE, 'text/plain', v);
      return { a: text(a, o[0]), c: text(c, v.written) };
    });

    eq(r.extra.a, r.extra.c);
    assert(/^content-type:/i.test(r.extra.a), r.extra.a);
  },

  async 'addHeader(): bad arguments'() {
    const r = await handshake(wsi => {
      const res = [];
      for(const args of [['x'], ['x', 'y'], ['x', 'y', {}], ['x', 'y', 'str'], ['x', 'y', new ArrayBuffer(8)]]) {
        try {
          wsi.addHeader(...args);
          res.push('no error');
        } catch(e) {
          res.push(e.name);
        }
      }
      return res;
    });

    eq('TypeError,TypeError,TypeError,TypeError,InternalError', r.extra.join());
  },

  async 'clientHttpMultipart(): both forms, or a no-op outside multipart'() {
    const r = await handshake(wsi => {
      const a = new ArrayBuffer(512),
        o = [0],
        c = new ArrayBuffer(512),
        v = new Buffer(c);
      const n1 = wsi.clientHttpMultipart('field', 'file.txt', 'text/plain', a, o);
      const n2 = wsi.clientHttpMultipart('field', 'file.txt', 'text/plain', v);
      return { n1, n2, o: o[0], written: v.written, a: text(a, o[0]), c: text(c, v.written) };
    });

    /* not a multipart request: lws-socket.c returns undefined before touching the buffer */
    eq(undefined, r.extra.n1);
    eq(undefined, r.extra.n2);
    eq(0, r.extra.o);
    eq(0, r.extra.written);
  },

  async 'clientHttpMultipart(): real multipart POST, both forms write identical part headers'() {
    const port = freePort();
    let ctx, resolve, reject;
    const done = new Promise((res, rej) => ((resolve = res), (reject = rej)));

    const server = createServer({
      port,
      vhostName: 'localhost',
      mounts: [{ mountpoint: '/', protocol: 'http', originProtocol: LWSMPRO_CALLBACK }],
      protocols: [{ name: 'http', onHttp() {}, onHttpBody() {}, onHttpBodyCompletion() {} }],
    });

    ctx = new LWSContext({
      protocols: [
        {
          name: 'http',
          onClientAppendHandshakeHeader(wsi) {
            wsi.bodyPending = 1;
          },
          onClientHttpWriteable(wsi) {
            try {
              const a = new ArrayBuffer(512),
                o = [0],
                c = new ArrayBuffer(512),
                v = new Buffer(c);
              const r = { n: [], m: [] };

              r.n.push(wsi.clientHttpMultipart('field', null, null, a, o));
              r.m.push(wsi.clientHttpMultipart('field', null, null, v));
              r.n.push(wsi.clientHttpMultipart('file', 'a.txt', 'text/plain', a, o));
              r.m.push(wsi.clientHttpMultipart('file', 'a.txt', 'text/plain', v));
              r.n.push(wsi.clientHttpMultipart(null, null, null, a, o));
              r.m.push(wsi.clientHttpMultipart(null, null, null, v));

              /* number offset form, nothing to write back */
              const d = new ArrayBuffer(512);
              r.number = wsi.clientHttpMultipart('field', null, null, d, 0);
              r.d = text(d, r.number);

              r.o = o[0];
              r.written = v.written;
              r.a = text(a, o[0]);
              r.c = text(c, v.written);
              resolve(r);
            } catch(e) {
              reject(e);
            }
            wsi.bodyPending = 0;
            return -1;
          },
          onClientConnectionError(wsi, msg) {
            reject(new Error(msg));
          },
        },
      ],
    });
    ctx.clientConnect({ address: 'localhost', port, path: '/', host: 'localhost', method: 'POST', protocol: 'http', sslConnection: LCCSCF_HTTP_MULTIPART_MIME });

    let r;
    try {
      r = await done;
    } finally {
      ctx.cancelService();
      ctx.destroy();
      server.destroy();
    }

    /* lws keeps "a part was already started" per wsi: every part after the very first one
       (the buffer form's) starts with CRLF, 2 bytes more, so the first view-form part is 2 longer */
    eq(r.n[0] + 2, r.m[0]);
    eq(r.n.slice(1).join(), r.m.slice(1).join());
    eq(r.o, r.n.reduce((x, y) => x + y, 0));
    eq(r.o + 2, r.written);
    eq(r.a, r.c.slice(2));
    eq(r.m[0], r.number);
    eq(r.c.slice(0, r.number), r.d);
    assert(r.a.includes('name="field"'), r.a);
    assert(r.a.includes('filename="a.txt"'), r.a);
    assert(r.a.includes('text/plain'), r.a);
  },
});
