//import * as lws from 'lws';
import { LWSSPA, getCallbackName, LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT, LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED, LWS_SERVER_OPTION_IGNORE_MISSING_CERT, LWS_SERVER_OPTION_ALLOW_HTTP_ON_HTTPS_LISTENER, LWS_SERVER_OPTION_REDIRECT_HTTP_TO_HTTPS, LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT, LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG, LWS_WRITE_HTTP_FINAL, LWSMPRO_NO_MOUNT, LWSMPRO_HTTPS, LWSMPRO_HTTP, LWSMPRO_CALLBACK, LWSMPRO_FILE, LWSContext, log, } from 'lws';

const C = console.config({ compact: true, maxArrayLength: 8 });

const spa = (globalThis.spa = new WeakMap());

const protocols = [
  {
    name: 'ws',
    onOpensslPerformServerCertVerification(wsi, ssl, preverify_ok) {
      console.log('onOpensslPerformServerCertVerification', C, wsi, '0x' + ssl.toString(16), preverify_ok);
      return 0;
    },
    onHttpConfirmUpgrade(wsi, type) {
      console.log('onHttpConfirmUpgrade', C, wsi, type, wsi.protocol);
    },
    onReceive(wsi, data, len) {
      wsi.write(data);
    },
    onFilterHttpConnection(wsi, url) {
      const { headers } = wsi;

      globalThis.wsi = wsi;

      console.log('onFilterHttpConnection', C, wsi, url, headers);

      if(/multipart/.test(headers['content-type'])) {
        spa.set(
          wsi,
          new LWSSPA(wsi, {
            onContent(name, filename, buf) {
              console.log('onContent', C, { name, filename, buf });
            },
            onOpen(name, filename) {
              console.log('onOpen', C, { name, filename });
            },
            onClose(name, filename) {
              console.log('onClose', C, { name, filename });
            },
          }),
        );
      }
    },
    callback(wsi, reason, ...args) {
      globalThis.wsi = wsi;
      console.log('ws', C, wsi, reason, getCallbackName(reason).padEnd(29, ' '), args);
      return 0;
    },
  },
  {
    name: 'raw-echo',
    callback(wsi, reason, ...args) {
      globalThis.wsi = wsi;
      console.log('raw-echo', C, wsi, reason, getCallbackName(reason).padEnd(29, ' '), args);
      return 0;
    },
  },
  {
    name: 'http',
    onHttpBody(wsi, buf, len) {
      const s = spa.get(wsi);

      console.log('onHttpBody', C, s, buf);

      s.process(buf, len);
    },
    onHttpBodyCompletion(wsi) {
      const s = spa.get(wsi);

      s.finalize();

      wsi.wantWrite();
    },
    onHttpWriteable(wsi) {
      console.log('onHttpWriteable', C, wsi);
      if(!wsi.responded) {
        wsi.respond(200, 5, { 'content-type': 'text/html' /*, connection: 'close'*/ });
        wsi.wantWrite();
        wsi.responded = 1;
        return 0;
      } else wsi.write('TEST\n', LWS_WRITE_HTTP_FINAL);
      return 1;
    },
    onHttp(wsi, buf, len) {
      console.log('onHttp', C, wsi, buf, len, wsi.write);

      wsi.wantWrite();
      //wsi.wantWrite(wsi => (wsi.write('Output!\n', LWS_WRITE_HTTP_FINAL), 0));
    },
    callback(wsi, reason, ...args) {
      globalThis.wsi = wsi;
      console.log('http', C, wsi, reason, getCallbackName(reason).padEnd(29, ' '), args);
      return 0;
    },
  },
];

globalThis.ctx = new LWSContext({
  port: 8886,
  vhostName: 'localhost.transistorisiert.ch',
  options:
    /*LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG |
    LWS_SERVER_OPTION_REDIRECT_HTTP_TO_HTTPS |*/
    LWS_SERVER_OPTION_IGNORE_MISSING_CERT |
    LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED |
    LWS_SERVER_OPTION_ALLOW_HTTP_ON_HTTPS_LISTENER |
    LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT |
    LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT,
  listenAcceptRole: 'raw-skt',
  listenAcceptProtocol: 'raw-echo',
  protocols,
  sslCaFilepath: 'ca.crt',
  sslCertFilepath: 'localhost.crt',
  sslPrivateKeyFilepath: 'localhost.key',
  /*clientSslCaFilepath: 'ca.crt',
  clientSslCertFilepath: 'localhost.crt',
  clientSslPrivateKeyFilepath: 'localhost.key',*/
  mounts: [
    { mountpoint: '/ws', protocol: 'ws', originProtocol: LWSMPRO_NO_MOUNT },
    { mountpoint: '/test', protocol: 'http', originProtocol: LWSMPRO_CALLBACK },
    //{ mountpoint: '/', origin: '127.0.0.1:8000/warmcat/', def: 'index.html', originProtocol: LWSMPRO_HTTP },
    { mountpoint: '/', origin: 'warmcat.com/', def: 'index.html', originProtocol: LWSMPRO_HTTP },
    //{ mountpoint: '/', origin: '.', def: 'index.html', originProtocol: LWSMPRO_FILE },
  ],
});
