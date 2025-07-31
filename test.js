//import * as lws from 'lws';
import { LWSSPA, getCallbackName, LWS_ILLEGAL_HTTP_CONTENT_LEN, LWS_SERVER_OPTION_VH_H2_HALF_CLOSED_LONG_POLL, LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT, LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED, LWS_SERVER_OPTION_IGNORE_MISSING_CERT, LWS_SERVER_OPTION_ALLOW_HTTP_ON_HTTPS_LISTENER, LWS_SERVER_OPTION_REDIRECT_HTTP_TO_HTTPS, LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT, LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG, LWS_WRITE_HTTP_FINAL, LWSMPRO_NO_MOUNT, LWSMPRO_HTTPS, LWSMPRO_HTTP, LWSMPRO_CALLBACK, LWSMPRO_FILE, LWSContext, log, } from 'lws';
import { setTimeout } from 'os';

const C = console.config({ compact: true, maxArrayLength: 8 });

const spa = (globalThis.spa = new WeakMap());

const wsi2obj = (globalThis.wsi2obj = (function () {
  const m = new WeakMap();
  return wsi => {
    let obj = m.get(wsi);
    if(!obj) {
      obj = {};
      m.set(wsi, obj);
    }
    return obj;
  };
})());

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
      console.log('ws', C, wsi, reason, getCallbackName(reason).padEnd(29, ' '), args);
      return 0;
    },
  },
  {
    name: 'raw-echo',
    callback(wsi, reason, ...args) {
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
      const obj = wsi2obj(wsi);

      if(!obj.responded) {
        obj.lines = (JSON.stringify({ blah: 1234, test: [1, 2, 3, 4], x: true }, null, 2) + '\n').split('\n');
        wsi.respond(200, LWS_ILLEGAL_HTTP_CONTENT_LEN ?? obj.lines.length, { 'content-type': 'text/html' /*, connection: 'close'*/ });

        obj.index = 0;
        setTimeout(() => wsi.wantWrite(), 0);

        obj.responded = 1;
        return 0;
      }

      wsi.write(obj.lines[obj.index] + '\n', obj.lines[++obj.index] ? LWS_WRITE_HTTP : LWS_WRITE_HTTP_FINAL);

      if(obj.lines[obj.index]) {
        setTimeout(() => wsi.wantWrite(), 100);
        return 0;
      }

      return -1;
    },
    onHttp(wsi, buf, len) {
      console.log('onHttp', C, wsi, buf, len, wsi.write);

      globalThis.wsi = wsi;

      wsi.wantWrite();
      //wsi.wantWrite(wsi => (wsi.write('Output!\n', LWS_WRITE_HTTP_FINAL), 0));
    },
    callback(wsi, reason, ...args) {
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
    LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT |
    LWS_SERVER_OPTION_VH_H2_HALF_CLOSED_LONG_POLL,
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
