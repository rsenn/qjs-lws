//import * as lws from 'lws';
import { LWSSPA, getCallbackName, LWS_WRITE_HTTP_FINAL, LWSMPRO_NO_MOUNT, LWSMPRO_CALLBACK, LWSMPRO_FILE, LWSContext } from 'lws';

const C = console.config({ compact: true });

const spa = new WeakMap();

const protocols = [
  {
    name: 'ws',
    onFilterHttpConnection(wsi, url) {
      const { headers } = wsi;
      console.log('onFilterHttpConnection', C, wsi, url, headers);
      if(/multipart/.test(headers['content-type'])) {
        spa.set(wsi, new LWSSPA({}));
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

      //console.log('onHttpBody', C, s, buf);

      s.process(buf, len);
    },
    onHttpBodyCompletion(wsi) {
      const s = spa.get(wsi);

      s.finalize();

      wsi.respond(200, { 'content-type': 'text/html' });
      wsi.wantWrite();
    },
    onHttpWriteable(wsi) {
      console.log('onHttpWriteable', C, wsi);
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
  /*httpProxyAddress: '127.0.0.1', httpProxyPort: 8123,
  socksProxyAddress: '127.0.0.1', socksProxyPort: 9050,*/
  protocols,
  mounts: [
    { mountpoint: '/ws', protocol: 'ws', originProtocol: LWSMPRO_NO_MOUNT },
    { mountpoint: '/test', protocol: 'http', originProtocol: LWSMPRO_CALLBACK },
    { mountpoint: '/', origin: '.', def: 'index.html', originProtocol: LWSMPRO_FILE },
  ],
});
