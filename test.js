//import * as lws from 'lws';
import { getCallbackName, LWSMPRO_NO_MOUNT, LWSMPRO_CALLBACK, LWSMPRO_FILE, LWSContext } from 'lws';

const C = console.config({ compact: true });

const protocols = [
  {
    name: 'ws',
    callback(wsi, reason, ...args) {
      globalThis.wsi = wsi;
      console.log('ws', getCallbackName(reason).padEnd(29, ' '), C, args);
      return 0;
    },
  },
  {
    name: 'http',
    callback(wsi, reason, ...args) {
      globalThis.wsi = wsi;
      console.log('ws', getCallbackName(reason).padEnd(29, ' '), C, args);
      return 0;
    },
  },
];

globalThis.ctx = new LWSContext({
  port: 8886,
  /*http_proxy_address: '127.0.0.1', http_proxy_port: 8123,
  socks_proxy_address: '127.0.0.1', socks_proxy_port: 9050,*/
  protocols,
  mounts: [
    { mountpoint: '/ws', protocol: 'ws', origin_protocol: LWSMPRO_NO_MOUNT },
    { mountpoint: '/test', protocol: 'http', origin_protocol: LWSMPRO_CALLBACK },
    { mountpoint: '/', origin: '.', def: 'index.html', origin_protocol: LWSMPRO_FILE },
  ],
});
