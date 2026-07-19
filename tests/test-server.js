import { logLevel, getCallbackName, LWS_WRITE_HTTP, LLL_ERR, LLL_WARN, LLL_INFO, LLL_NOTICE, LLL_USER, LLL_CLIENT, LWS_ILLEGAL_HTTP_CONTENT_LEN, LWS_SERVER_OPTION_VH_H2_HALF_CLOSED_LONG_POLL, LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT, LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED, LWS_SERVER_OPTION_IGNORE_MISSING_CERT, LWS_SERVER_OPTION_ALLOW_HTTP_ON_HTTPS_LISTENER, LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT, LWS_WRITE_HTTP_FINAL, LWSMPRO_NO_MOUNT, LWSMPRO_HTTPS, LWSMPRO_HTTP, LWSMPRO_CALLBACK, LWSMPRO_FILE, LWSContext, toArrayBuffer, toString, } from 'lws.so';
import { setTimeout } from 'os';
import extraMimetypes from '../lib/lws/mimetypes.js';
import { verbose, debug, weakMapper, interactive } from '../lib/lws/util.js';
import { http, ws } from '../lib/lws/protocols.js';

logLevel(LLL_ERR | LLL_USER);

const wsi2obj = weakMapper(() => ({}));

function main(...args) {
  globalThis.ctx = new LWSContext({
    port: 8886,
    vhostName: 'localhost.transistorisiert.ch',
    options:
      LWS_SERVER_OPTION_IGNORE_MISSING_CERT |
      LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED |
      LWS_SERVER_OPTION_ALLOW_HTTP_ON_HTTPS_LISTENER |
      LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT |
      LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT |
      LWS_SERVER_OPTION_VH_H2_HALF_CLOSED_LONG_POLL,
    listenAcceptRole: 'raw-skt',
    listenAcceptProtocol: 'raw-echo',
    protocols: [
      ws({
        name: 'ws',
        open(wsi) {
          console.log('WebSocket opened', wsi);
        },
        message(wsi, msg) {
          console.log('WebSocket message:', msg);
        },
        close(wsi) {
          console.log('WebSocket closed');
        },
      }),
      http(
        async (req, resp) => {
          console.log('http', { req, resp });

          console.log('req.formData()', await req.formData());

          resp.status(200).type('text/plain').end('This is a test');
        },
        {
          name: 'http',
          /*post: async (wsi, parser) => {
            for await(let stream of parser) {
              const { name, filename } = stream;
              console.log('POST', { name, filename });
            }
          },*/
        },
      ),
    ],
    serverSslCa: 'ca.crt',
    serverSslCert: 'localhost.crt',
    serverSslPrivateKey: 'localhost.key',
    mounts: [
      { mountpoint: '/ws', protocol: 'ws', originProtocol: LWSMPRO_NO_MOUNT },
      { mountpoint: '/test', protocol: 'http', originProtocol: LWSMPRO_CALLBACK },
      { mountpoint: '/warmcat', origin: 'warmcat.com/', def: 'index.html', originProtocol: LWSMPRO_HTTP },
      //{ mountpoint: '/', origin: 'warmcat.com/', def: 'index.html', originProtocol: LWSMPRO_HTTP },
      {
        mountpoint: '/',
        origin: '.',
        def: 'README.md',
        originProtocol: LWSMPRO_FILE,
        extraMimetypes,
      },
    ],
  });
}

main(...scriptArgs.slice(1));

//interactive();
