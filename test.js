//import * as lws from 'lws';
import { LWSSPA, getCallbackName, LWS_SERVER_OPTION_ALLOW_HTTP_ON_HTTPS_LISTENER, LWS_SERVER_OPTION_REDIRECT_HTTP_TO_HTTPS, LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT, LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG, LWS_WRITE_HTTP_FINAL, LWSMPRO_NO_MOUNT, LWSMPRO_CALLBACK, LWSMPRO_FILE, LWSContext, log, } from 'lws';

const C = console.config({ compact: true, maxArrayLength: 8 });

const spa = (globalThis.spa = new WeakMap());

const protocols = [
  {
    name: 'raw-echo',
    callback(wsi, reason, ...args) {
      globalThis.wsi = wsi;
      console.log('raw-echo', C, wsi, reason, getCallbackName(reason).padEnd(29, ' '), args);
      return 0;
    },
  },
  {
    name: 'ws',
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
      globalThis.wsi = wsi;
      console.log('ws', C, wsi, reason, getCallbackName(reason).padEnd(29, ' '), args);
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
      wsi.respond(200, { 'content-type': 'text/html', connection: 'close' });
      wsi.write('TEST\n', LWS_WRITE_HTTP_FINAL);
      return 1;
    },
    onHttp(wsi, buf, len) {
      console.log('onHttp', C, wsi, buf, len);
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
  options:
    LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG | LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT | LWS_SERVER_OPTION_REDIRECT_HTTP_TO_HTTPS | LWS_SERVER_OPTION_ALLOW_HTTP_ON_HTTPS_LISTENER,
  listenAcceptRole: 'raw-skt',
  listenAcceptProtocol: 'raw-echo',
  /*httpProxyAddress: '127.0.0.1', httpProxyPort: 8123,
  socksProxyAddress: '127.0.0.1', socksProxyPort: 9050,*/
  protocols,
  mounts: [
    { mountpoint: '/ws', protocol: 'ws', originProtocol: LWSMPRO_NO_MOUNT },
    { mountpoint: '/test', protocol: 'http', originProtocol: LWSMPRO_CALLBACK },
    { mountpoint: '/', origin: '.', def: 'index.html', originProtocol: LWSMPRO_FILE },
  ],
});
