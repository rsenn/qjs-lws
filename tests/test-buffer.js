/**
 * Demo: composing payloads with lws.Buffer, lws.View and lws.write(), and the LWSSocket
 * methods that write into one (addHeader, clientHttpMultipart, respond).
 *
 *   qjsm tests/test-buffer.js
 *
 * A Buffer owns its memory (LWS_PRE + size bytes, the range starts LWS_PRE in), a View is a
 * range over memory somebody else owns. Both are written through their cursor: write() appends,
 * skip() moves on, and the Buffer remembers where its unread bytes start.
 */
import { LWSContext, createServer, Buffer, View, write, toPointer, toString, LWSMPRO_CALLBACK, LWS_WRITE_HTTP_FINAL, LCCSCF_HTTP_MULTIPART_MIME } from 'lws.so';
import { logLevel } from 'lws.so';
import { freePort } from './unittests/subprocess-utils.js';

logLevel(0, () => {});

/* printable form of bytes: text as is, CR LF and non-printables escaped */
const show = s => String(s).replace(/[\r\n\x00-\x1f\x7f-\xff]/g, c => (c == '\r' ? '\\r' : c == '\n' ? '\\n\n          ' : '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0')));
const hex = ab =>
  [...new Uint8Array(ab)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join(' ')
    .replace(/(.{48}) /g, '$1\n          ');

const title = t => console.log(`\n== ${t} ${'='.repeat(Math.max(0, 70 - t.length))}`);

/* 1. a Buffer, lws.write() and the cursor ---------------------------------------------------- */
title('Buffer: write() appends, length / span / reset');
{
  const b = new Buffer(64);

  console.log('new Buffer(64)           length', b.length, 'span', b.span, 'avail', b.avail);
  console.log('write("hello, ")        ->', b.write('hello, '), 'bytes');
  console.log('lws.write("world", b)   ->', write('world', b), 'bytes');
  console.log('lws.write(bytes, b)     ->', write(new Uint8Array([33, 10]).buffer, b), 'bytes');
  console.log('length', b.length, 'avail', b.avail, JSON.stringify(b.toString()));
  console.log('hex     ', hex(b.toArrayBuffer()));

  /* readable / writable are Views over the two halves, sharing the cursor */
  const { readable, writable } = b;

  console.log('readable.avail', readable.avail, 'writable.avail', writable.avail);
  readable.skip(7);
  console.log('after readable.skip(7):', JSON.stringify(b.toString()), 'length', b.length);
  b.reset();
  console.log('after reset(): length', b.length, 'avail', b.avail);
}

/* 2. Views over memory you already have ------------------------------------------------------ */
title('View: over an ArrayBuffer, a typed array, raw addresses');
{
  const ab = new ArrayBuffer(16);
  const clear = () => new Uint8Array(ab).fill(46);
  const dump = (what, n, v) => console.log(what.padEnd(36), `wrote ${n}, avail ${v.avail}`.padEnd(20), '|' + show(String.fromCharCode(...new Uint8Array(ab))) + '|');

  clear();
  let v = new View(ab, 4, 8);
  dump('View(ab, 4, 8).write("ABCDEFGHIJ")', write('ABCDEFGHIJ', v), v);

  clear();
  v = new View(new Uint8Array(ab, 10), 1);
  dump('View(Uint8Array(ab, 10), 1)  "xy"', write('xy', v), v);

  clear();
  const p = toPointer(ab);
  v = new View(p + 2, p + 6, ab);
  dump('View(p + 2, p + 6, ab)  "RAW!!"', write('RAW!!', v), v);
  console.log('  .parent is the ArrayBuffer:', v.parent === ab, '- pointer moved by', Number(v.pointer) - (Number(p) + 2), 'bytes');
}

/* 3. an exchange: addHeader / clientHttpMultipart on the client, respond on the server ------- */
title('LWSSocket: composing a request and a response');

const port = freePort();
let ctx;
let done;
const finished = new Promise(resolve => (done = resolve));
let chunks = [];

const server = createServer({
  port,
  vhostName: 'localhost',
  mounts: [{ mountpoint: '/', protocol: 'http', originProtocol: LWSMPRO_CALLBACK }],
  protocols: [
    {
      name: 'http',
      onHttp(wsi) {
        chunks = [];
      },
      onHttpBody(wsi, data) {
        chunks.push(new Uint8Array(data).slice());
      },
      onHttpBodyCompletion(wsi) {
        const body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let off = 0;
        for(const c of chunks) {
          body.set(c, off);
          off += c.length;
        }

        console.log('\n[server] got headers :', show(JSON.stringify({ 'x-demo': wsi.headers['x-demo'], 'x-more': wsi.headers['x-more'] })));
        console.log('[server] got body    :', body.length, 'bytes\n         ', show(toString(body.buffer, 0, body.length)));

        /* compose the response head and body into a Buffer first, to show it */
        const out = new Buffer(1024);
        const text = `received ${body.length} bytes\n`;
        const n = wsi.respond(200, text, { 'content-type': 'text/plain', 'x-demo': 'composed', 'set-cookie': ['a=1', 'b=2'] }, out);

        console.log(`\n[server] respond() composed ${n} bytes into a Buffer:\n         `, show(out.toString()));

        /* and answer for real */
        wsi.respond(200, text, { 'content-type': 'text/plain', 'x-demo': 'sent' });
        wsi.wantWrite(() => {
          wsi.write(text, LWS_WRITE_HTTP_FINAL);
          return -1;
        });
      },
    },
  ],
});

ctx = new LWSContext({
  protocols: [
    {
      name: 'http',
      onClientAppendHandshakeHeader(wsi, view) {
        /* the callback hands us a View over the room lws left for extra request headers */
        const a = wsi.addHeader('x-demo', 'composed with addHeader', view);
        const b = wsi.addHeader('x-more', 'one more', view);

        /* the same header composed into a Buffer of our own, to show what is on the wire */
        const mine = new Buffer(128);
        const n = wsi.addHeader('x-demo', 'composed with addHeader', mine);

        console.log(`[client] addHeader() wrote ${a} + ${b} bytes into the handshake View, and ${n} into a Buffer:\n         `, show(mine.toString()));
        wsi.bodyPending = 1;
      },
      onClientHttpWriteable(wsi) {
        /* a multipart body: part headers from clientHttpMultipart(), part data from write() */
        const body = new Buffer(1024);

        const a = wsi.clientHttpMultipart('greeting', null, null, body);
        write('hello from Buffer\r\n', body);
        const b = wsi.clientHttpMultipart('attachment', 'a.txt', 'text/plain', body);
        write('line 1\nline 2\r\n', body);
        const c = wsi.clientHttpMultipart(null, null, null, body);

        console.log(`[client] clientHttpMultipart() wrote ${a} + ${b} + ${c} bytes, body is ${body.length} bytes:\n         `, show(body.toString()));

        wsi.write(body.toArrayBuffer(), LWS_WRITE_HTTP_FINAL);
        wsi.bodyPending = 0;
      },
      onEstablishedClientHttp(wsi, status) {
        this.status = status;
      },
      onReceiveClientHttp(wsi) {
        const buf = new ArrayBuffer(4096);
        if(wsi.httpClientRead(buf)) this.onReceiveClientHttpRead(wsi, buf);
      },
      onReceiveClientHttpRead(wsi, buf, len) {
        console.log(`\n[client] response ${this.status}:`, show(toString(buf, 0, len)));
        done();
      },
      onClientConnectionError(wsi, msg) {
        console.log('connection error', msg);
        done();
      },
    },
  ],
});

ctx.clientConnect({ address: 'localhost', port, path: '/upload', host: 'localhost', method: 'POST', protocol: 'http', sslConnection: LCCSCF_HTTP_MULTIPART_MIME });

await finished;
ctx.cancelService();
ctx.destroy();
server.destroy();
