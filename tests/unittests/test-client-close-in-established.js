/**
 * Closing an http client wsi from onEstablishedClientHttp (the response body
 * not drained) must not live-lock the process: lws parks the body waiting to
 * be drained and its forced-service loop used to spin in native code
 * forever, so not even a timer fired again.
 */
import * as os from 'os';
import { exit } from 'std';
import { tests, assert, assertEquals } from './tinytest.js';
import { createServer, LWSContext, LWS_WRITE_HTTP_FINAL, LWSMPRO_CALLBACK } from 'lws.so';
import { freePort } from './subprocess-utils.js';

await tests({
  async 'timers keep firing after the client closes from onEstablishedClientHttp'() {
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
    const ctx = new LWSContext({
      protocols: [
        {
          name: 'http',
          onEstablishedClientHttp(wsi) {
            established++;
            wsi.close();
          },
        },
      ],
    });

    ctx.clientConnect({ address: 'localhost', port, path: '/', host: 'localhost', method: 'GET', protocol: 'http' });

    let ticks = 0,
      running = true;
    const tick = () => {
      ticks++;
      if(running) os.setTimeout(tick, 20);
    };

    os.setTimeout(tick, 20);

    await new Promise(resolve => os.setTimeout(resolve, 600));
    running = false;

    ctx.destroy();
    server.destroy();

    assertEquals(1, established);
    assert(ticks >= 10, `only ${ticks} timer ticks in 600 ms`);
  },
});

exit(0);
