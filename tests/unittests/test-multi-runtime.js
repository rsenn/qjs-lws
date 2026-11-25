/**
 * lws.so keeps no per-runtime state in statics: a second JSRuntime (an
 * os.Worker) loading it used to overwrite the socket prototype of the first,
 * and every new connection of the main thread then failed (wsi.addHeader
 * missing, the request dropped).
 */
import * as os from 'os';
import { exit, getenv } from 'std';
import { tests, assertEquals } from './tinytest.js';
import { createServer, LWSContext, LWS_WRITE_HTTP_FINAL, LWSMPRO_CALLBACK } from 'lws.so';
import { freePort } from './subprocess-utils.js';

const lwsSo = getenv('QUICKJS_MODULE_PATH').split(/[;:]/).map(d => d + '/lws.so').find(f => os.stat(f)[1] === 0);
const worker = import.meta.url.replace(/^file:\/\//, '').replace(/[^/]*$/, 'fixtures/lws-worker.js');

function request(port) {
  return new Promise(resolve => {
    let ctx, status;

    ctx = new LWSContext({
      protocols: [
        {
          name: 'http',
          onEstablishedClientHttp(wsi, s) {
            status = s; /* returning nonzero would hang up */
          },
          onReceiveClientHttp(wsi) {
            const buf = new ArrayBuffer(4096);

            if(wsi.httpClientRead(buf)) this.onReceiveClientHttpRead(wsi, buf);
          },
          onReceiveClientHttpRead() {
            ctx.cancelService();
            resolve(status);
          },
          onClientConnectionError(wsi, msg) {
            console.log('connection error:', msg);
            ctx.cancelService();
            resolve(0);
          },
        },
      ],
    });
    ctx.clientConnect({ address: 'localhost', port, path: '/', host: 'localhost', method: 'GET', protocol: 'http' });
    os.setTimeout(() => resolve(-1), 3000);
  });
}

await tests({
  async 'a request on the main thread works after a worker loaded lws.so'() {
    const port = freePort();
    const server = createServer({
      port,
      vhostName: 'localhost',
      mounts: [{ mountpoint: '/', protocol: 'http', originProtocol: LWSMPRO_CALLBACK }],
      protocols: [
        {
          name: 'http',
          onHttp(wsi) {
            wsi.respond(200, 2, {});
            wsi.write('ok', LWS_WRITE_HTTP_FINAL);
          },
        },
      ],
    });

    assertEquals(200, await request(port));

    const w = new os.Worker(worker);

    const reply = await new Promise(resolve => {
      w.onmessage = e => e.data.done && resolve(e.data);
      w.postMessage({ lws: lwsSo });
      os.setTimeout(() => resolve({ error: 'worker timeout' }), 5000);
    });

    assertEquals(undefined, reply.error);

    assertEquals(200, await request(port));
    server.destroy();
  },
});

exit(0);
