/**
 * clientConnect('http://host:port/...') must send "Host: host:port" when the
 * port is not the default one of the scheme. The header used to carry the
 * bare host, so a server that builds urls from it (chromium's devtools
 * webSocketDebuggerUrl) handed out urls without the port, and the websocket
 * connect that followed went to port 80.
 */
import { exit } from 'std';
import * as os from 'os';
import { tests, assertEquals } from './tinytest.js';
import { createServer, LWSContext, LWS_WRITE_HTTP_FINAL, LWSMPRO_CALLBACK, toString } from 'lws.so';
import { freePort } from './subprocess-utils.js';

await tests({
  async 'the Host header of a string-url request carries a non-default port'() {
    const port = freePort();
    const server = createServer({
      port,
      vhostName: 'localhost',
      mounts: [{ mountpoint: '/', protocol: 'http', originProtocol: LWSMPRO_CALLBACK }],
      protocols: [
        {
          name: 'http',
          onHttp(wsi) {
            const host = String(wsi.headers.host);

            wsi.respond(200, host.length, {});
            wsi.write(host, LWS_WRITE_HTTP_FINAL);
          },
        },
      ],
    });
    let ctx;
    const body = await new Promise(resolve => {
      ctx = new LWSContext({
        protocols: [
          {
            name: 'http',
            onReceiveClientHttp(wsi) {
              const buf = new ArrayBuffer(4096);

              if(wsi.httpClientRead(buf)) this.onReceiveClientHttpRead(wsi, buf);
            },
            onReceiveClientHttpRead(wsi, buf, len) {
              ctx.cancelService();
              resolve(toString(buf, 0, len));
            },
            onClientConnectionError(wsi, msg) {
              ctx.cancelService();
              resolve('error: ' + msg);
            },
          },
        ],
      });
      ctx.clientConnect(`http://localhost:${port}/`, { protocol: 'http' });
      os.setTimeout(() => resolve('timeout'), 3000);
    });

    ctx.destroy();
    server.destroy();
    assertEquals(`localhost:${port}`, body);
  },
});

exit(0);
