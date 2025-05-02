import { LWSContext, LWSSocket, LWSSPA, getCallbackName, getCallbackNumber, log, LWSMPRO_HTTP, LWSMPRO_HTTPS, LWSMPRO_FILE, LWSMPRO_CGI, LWSMPRO_REDIR_HTTP, LWSMPRO_REDIR_HTTPS, LWSMPRO_CALLBACK, LWSMPRO_NO_MOUNT, } from 'lws';

const C = console.config({ compact: true, maxArrayLength: 8 });

let ctx = (globalThis.ctx = new LWSContext({
  protocols: [
    {
      name: 'raw',
      onConnecting(wsi) {
        console.log('onConnecting', C, wsi);
      },
      onRawRx(wsi, data) {
        data= [...new Uint8Array(data)].reduce((s,n) =>s+ String.fromCodePoint(n), '');

        console.log('onRawRx', C, wsi, data);
      },
      onRawClose(wsi) {
        console.log('onRawClose', C, wsi);
      },
      callback(wsi, reason, ...args) {
        globalThis.wsi = wsi;
        console.log('raw', C, wsi, reason, getCallbackName(reason).padEnd(29, ' '), args);
        return 0;
      },
    },
  ],
}));

ctx.clientConnect({ address: 'localhost', port: 22, local_protocol_name: 'raw', method: 'RAW' });
