import { logLevel, getCallbackName, LWS_WRITE_HTTP, LLL_ERR, LLL_WARN, LLL_INFO, LLL_NOTICE, LLL_USER, LLL_CLIENT, LWS_ILLEGAL_HTTP_CONTENT_LEN, LWS_SERVER_OPTION_VH_H2_HALF_CLOSED_LONG_POLL, LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT, LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED, LWS_SERVER_OPTION_IGNORE_MISSING_CERT, LWS_SERVER_OPTION_ALLOW_HTTP_ON_HTTPS_LISTENER, LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT, LWS_WRITE_HTTP_FINAL, LWSMPRO_NO_MOUNT, LWSMPRO_HTTPS, LWSMPRO_HTTP, LWSMPRO_CALLBACK, LWSMPRO_FILE, LWSContext, toArrayBuffer, toString, } from 'lws';
import { setTimeout } from 'os';
import extraMimetypes from '../lib/lws/mimetypes.js';
import { verbose, debug, weakMapper, interactive } from '../lib/lws/util.js';
import { MultipartParser } from '../lib/lws/multipart.js';
import { http } from '../lib/lws/protocols.js';

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
      {
        name: 'http',
        ...MultipartParser.protocol(async parser => {
          console.log('multipart parser', parser);

          for await(const stream of parser) {
            debug(`multipart file [${stream.filename}]`);
            for await(const chunk of stream) debug(`multipart data [${stream.filename}]`, chunk);
            debug(`multipart file [${stream.filename}] \x1b[1;31mdone!\x1b[0m`);
          }

          console.log('multipart done');
        }),

        ...http(
          async (req, resp) => {
            console.log('http', { req, resp });
            //console.log('req.arrayBuffer()', await req.arrayBuffer());
            console.log('req.body', await req.body);

            //  resp.status(200).type('text/plain').end('This is a test');
          },
          {
            post: async (wsi, parser) => {
              for await(let stream of parser) {
                const { name, filename } = stream;
                console.log('POST', { name, filename });
              }
            },
          },
        ),
      },

      {
        name: 'ws',
        onOpensslPerformServerCertVerification(wsi, ssl, preverify_ok) {
          verbose('onOpensslPerformServerCertVerification', wsi, '0x' + ssl.toString(16), preverify_ok);
          return 0;
        },
        onHttpConfirmUpgrade(wsi, type) {
          verbose('onHttpConfirmUpgrade', wsi, type, wsi.protocol);
        },
        onReceive(wsi, data, len) {
          if(!('byteLength' in data)) data = data.toString().replace(/\n/g, '\\n');

          verbose('onReceive', wsi, data, len);
          wsi.write(data);
        },
        onFilterHttpConnection(wsi, url) {
          const { headers } = wsi;

          verbose('onFilterHttpConnection', wsi, url, headers);

          //if(/multipart/.test(headers['content-type'])) wsi2spa(wsi);
        },
        callback(wsi, reason, ...args) {
          verbose('ws ' + getCallbackName(reason), wsi, args);
          return 0;
        },
      },
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
