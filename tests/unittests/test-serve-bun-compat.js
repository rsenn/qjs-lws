/**
 * Bun parity for serve(): Response over a Blob, req.signal, req.clone()
 * with a streamed body, the status line's reason phrase. Expected values
 * are what Bun 1.4 answers.
 */
import { tests, assert, assertEquals, needs } from './tinytest.js';
import { serve, Response } from '../../lib/serve.js';
import { Request } from '../../lib/lws/request.js';
import { fetch } from '../../lib/fetch.js';
import { ReadableStream } from '../../lib/lws/streams.js';
import { TextEncoder } from '../utf8.js';
import { URL } from '../../lib/lws/url.js';
import * as os from 'os';
import { setTimeout } from 'os';
import * as std from 'std';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const { Blob } = await import('blob').catch(() => ({}));

/* first line of curl's answer, run without blocking the in-process server */
async function statusLine(url) {
  const file = '/tmp/qjs-lws-status-line.txt';
  const out = std.open(file, 'w');
  const pid = os.exec(['curl', '-s', '-i', '-m', '5', url], { block: false, stdout: out.fileno() });

  out.close();
  while(os.waitpid(pid, os.WNOHANG)[0] == 0) await sleep(20);

  const text = std.loadFile(file) ?? '';
  os.remove(file);
  return text.split('\r\n')[0];
}

await tests({
  async 'Response(Blob): body, text and content-type'() {
    await needs('blob');
    const r = new Response(new Blob(['xyz'], { type: 'text/plain' }));
    assertEquals(await r.text(), 'xyz');
    assertEquals(await new Response(new Blob(['a', 'bc'])).text(), 'abc');
    assertEquals(new Response(new Blob([])).body != null, true);
  },

  async 'Response(Blob).clone() reads twice'() {
    await needs('blob');
    const r = new Response(new Blob(['xyz']));
    const c = r.clone();
    assertEquals(await r.text(), 'xyz');
    assertEquals(await c.text(), 'xyz');
  },

  async 'Request(Blob body) reads'() {
    await needs('blob');
    const r = new Request('http://x/', { method: 'POST', body: new Blob(['q=1']) });
    assertEquals(await r.text(), 'q=1');
  },

  async 'Request.clone() of a streamed body: both read the same text'() {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('he'));
        c.enqueue(new TextEncoder().encode('llo'));
        c.close();
      },
    });
    const r = new Request('http://x/', { method: 'POST', body: stream });
    const c = r.clone();
    assertEquals(await r.text(), 'hello');
    assertEquals(await c.text(), 'hello');
  },

  async 'Request has a signal'() {
    const r = new Request('http://x/');
    assertEquals(r.signal.aborted, false);
    assertEquals(typeof r.signal.addEventListener, 'function');
  },

  async 'server: Blob, requestIP, signal, clone, reason phrase'() {
    await needs('blob');
    let seen;
    const server = serve({ port: 0, hostname: '127.0.0.1' }, async (req, srv) => {
      const path = new URL(req.url).pathname;
      if(path == '/blob') return new Response(new Blob(['xyz'], { type: 'text/plain' }));
      if(path == '/ip') return Response.json(srv.requestIP(req));
      if(path == '/signal') return Response.json({ aborted: req.signal.aborted, type: typeof req.signal.addEventListener });
      if(path == '/clone') {
        const c = req.clone();
        return Response.json({ a: await req.text(), b: await c.text() });
      }
      if(path == '/created') return new Response('x', { status: 201 });
      if(path == '/redirect') return Response.redirect('/x', 302);
      return new Response('nf', { status: 404 });
    });
    const base = `http://127.0.0.1:${server.port}`;

    const blob = await fetch(`${base}/blob`);
    assertEquals(await blob.text(), 'xyz');
    assertEquals(blob.headers.get('content-length'), '3');
    assert(/^text\/plain/.test(blob.headers.get('content-type')));

    const ip = await (await fetch(`${base}/ip`)).json();
    assertEquals(ip.address, '127.0.0.1');
    assertEquals(ip.family, 'IPv4');
    assert(ip.port > 0);

    assertEquals(JSON.stringify(await (await fetch(`${base}/signal`)).json()), '{"aborted":false,"type":"function"}');
    assertEquals(JSON.stringify(await (await fetch(`${base}/clone`, { method: 'POST', body: 'hello' })).json()), '{"a":"hello","b":"hello"}');

    /* the status line, read raw (fetch() does not surface the phrase) */
    assertEquals(await statusLine(`${base}/created`), 'HTTP/1.1 201 Created');
    assertEquals(await statusLine(`${base}/redirect`), 'HTTP/1.1 302 Found');

    await server.stop();
  },

  async 'server: req.signal aborts when the client hangs up'() {
    let signal;
    const server = serve({ port: 0, hostname: '127.0.0.1' }, async req => {
      signal = req.signal;
      await sleep(600);
      return new Response('late');
    });
    const { AbortController } = await import('../../lib/lws/abort.js');
    const ac = new AbortController();
    const gone = fetch(`http://127.0.0.1:${server.port}/`, { signal: ac.signal }).catch(() => 'aborted');
    await sleep(200);
    assertEquals(signal.aborted, false);
    ac.abort();
    await gone;
    await sleep(200);
    assertEquals(signal.aborted, true);
    await sleep(600);
    await server.stop();
  },
});

std.exit(0);
