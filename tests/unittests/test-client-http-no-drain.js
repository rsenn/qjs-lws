/**
 * An http client protocol without a handler for the response body must not
 * keep the process busy. lws parks the body and waits to be told to drain
 * it; a protocol that only has onEstablishedClientHttp never did, and the
 * event loop ran lws over and over for as long as the connection lived
 * (full cpu, with the timers still firing, so nothing looked wrong).
 */
import { setTimeout } from 'os';
import { exit, open } from 'std';
import { tests, assert, assertEquals } from './tinytest.js';
import { createServer, LWSContext, LWS_WRITE_HTTP_FINAL, LWSMPRO_CALLBACK } from 'lws.so';
import { freePort } from './subprocess-utils.js';

/* user + system cpu time of this process in clock ticks, or -1 without /proc */
function cpuTicks() {
  /* not loadFile(): a proc file claims a size of 0 */
  const file = open('/proc/self/stat', 'r');

  if(!file) return -1;

  const stat = file.readAsString();

  file.close();

  const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');

  return +f[11] + +f[12]; /* utime, stime */
}

await tests({
  async 'a client that never reads the body leaves the cpu idle'() {
    const port = freePort();
    const server = createServer({
      port,
      vhostName: 'localhost',
      mounts: [{ mountpoint: '/', protocol: 'http', originProtocol: LWSMPRO_CALLBACK }],
      protocols: [
        {
          name: 'http',
          onHttp(wsi) {
            wsi.respond(200, 4, {});
            wsi.write('body', LWS_WRITE_HTTP_FINAL);
          },
        },
      ],
    });
    let established = 0;
    const ctx = new LWSContext({ protocols: [{ name: 'http', onEstablishedClientHttp: () => established++ }] });

    ctx.clientConnect({ address: 'localhost', port, path: '/', host: 'localhost', method: 'GET', protocol: 'http' });

    await new Promise(resolve => setTimeout(resolve, 200)); /* let the response arrive */
    assertEquals(1, established);

    const before = cpuTicks();

    await new Promise(resolve => setTimeout(resolve, 1000));

    const used = cpuTicks() - before;

    ctx.destroy();
    server.destroy();

    if(before >= 0) assert(used < 30, `a second of waiting used ${used} clock ticks of cpu (100 = a full cpu)`);
  },
});

exit(0);
