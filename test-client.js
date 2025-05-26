import { toString, toArrayBuffer, LWSContext, LWSSocket, LWSSPA, getCallbackName, getCallbackNumber, log, LWSMPRO_HTTP, LWSMPRO_HTTPS, LWSMPRO_FILE, LWSMPRO_CGI, LWSMPRO_REDIR_HTTP, LWSMPRO_REDIR_HTTPS, LWSMPRO_CALLBACK, LWSMPRO_NO_MOUNT, } from 'lws';

const C = console.config({ compact: true, maxArrayLength: 8 });

let ctx = (globalThis.ctx = new LWSContext({
  ssl_ca_filepath: '/etc/ssl/certs/ca-certificates.crt',
  ssl_cert_filepath: '/home/roman/.acme.sh/transistorisiert.ch_ecc/transistorisiert.ch.cer',
  ssl_private_key_filepath: '/home/roman/.acme.sh/transistorisiert.ch_ecc/transistorisiert.ch.key',
  client_ssl_ca_filepath: '/etc/ssl/certs/ca-certificates.crt',
  client_ssl_cert_filepath: '/home/roman/.acme.sh/transistorisiert.ch_ecc/transistorisiert.ch.cer',
  client_ssl_private_key_filepath: '/home/roman/.acme.sh/transistorisiert.ch_ecc/transistorisiert.ch.key',
  protocols: [
    {
      name: 'raw',
      onConnecting(wsi) {
        console.log('onConnecting', C, wsi);
      },
      onRawConnected(wsi) {
        console.log('onRawConnected', C, wsi);
      },
      onRawWriteable(wsi) {
        wsi.write(toArrayBuffer('GET / HTTP/1.0\r\n\r\n'));
      },
      onRawRx(wsi, data) {
        data = toString(data);

        console.log('onRawRx', C, wsi, data.trimEnd());
      },
      onRawClose(wsi) {
        console.log('onRawClose', C, wsi);
      } /*,
      callback(wsi, reason, ...args) {
        globalThis.wsi = wsi;
        console.log('raw', C, wsi, reason, getCallbackName(reason).padEnd(29, ' '), args);
        return 0;
      },*/,
    },
    {
      name: 'http',
      onEstablishedClientHttp(wsi, data) {
        console.log('onEstablishedClientHttp', C, data);
      },
      onClientAppendHandshakeHeader(wsi, data, len) {
        console.log('onClientAppendHandshakeHeader', C, { data, len });
      },
      onClientHttpWriteable(wsi) {
        console.log('onClientHttpWriteable', C, wsi);
      },
      onReceiveClientHttpRead(wsi, data, len) {
        data = toString(data);
        console.log('onReceiveClientHttpRead', C, { data, len });
      },
      onCompletedClientHttp(wsi) {
        console.log('onCompletedClientHttp', C, wsi);
        wsi.context.cancelService();
      },
      onClosedClientHttp(wsi) {
        console.log('onClosedClientHttp', C, wsi.context);
        wsi.context.cancelService();
      },
      onReceiveClientHttp(wsi) {
        const ab = new ArrayBuffer(2048);
        let ret = wsi.httpClientRead(ab);
        console.log('onReceiveClientHttp', C, ret);
      },
      onClientConnectionError(wsi, msg, ...args) {
        console.log('onClientConnectionError', C, toString(msg), args);
      },
      callback(wsi, reason, ...args) {
        globalThis.wsi = wsi;
        console.log('http', C, wsi, reason, getCallbackName(reason).padEnd(29, ' '), args);
        return 0;
      },
    },
  ],
}));

//ctx.clientConnect({ address: 'localhost', port: 22, local_protocol_name: 'raw', method: 'RAW' });
ctx.clientConnect({ ssl: true, address: 'localhost', host: 'transistorisiert.ch', path: '/directory.js', port: 443, local_protocol_name: 'http', method: 'GET' });
