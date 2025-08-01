import { parseUri, toString, toArrayBuffer, LWSContext, LWSSocket, LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT, LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX, LWS_SERVER_OPTION_IGNORE_MISSING_CERT, LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED, LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT, LWS_PRE, LWSSPA, getCallbackName, getCallbackNumber, log, LWSMPRO_HTTP, LWSMPRO_HTTPS, LWSMPRO_FILE, LWSMPRO_CGI, LWSMPRO_REDIR_HTTP, LWSMPRO_REDIR_HTTPS, LWSMPRO_CALLBACK, LWSMPRO_NO_MOUNT, } from 'lws';

const C = console.config({ compact: true, maxArrayLength: 8 });

function verbose(name, ...args) {
  console.log(name.padEnd(32), ...args);
}

let ctx = (globalThis.ctx = new LWSContext({
  asyncDnsServers: ['8.8.8.8', '8.8.4.4', '4.2.2.1'],
  options:
    LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT |
    LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX |
    LWS_SERVER_OPTION_IGNORE_MISSING_CERT |
    LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED |
    LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT |
    LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT |
    LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX,
  sslCaFilepath: '/etc/ssl/certs/ca-certificates.crt',
  sslCertFilepath: '/home/roman/.acme.sh/transistorisiert.ch_ecc/transistorisiert.ch.cer',
  sslPrivateKeyFilepath: '/home/roman/.acme.sh/transistorisiert.ch_ecc/transistorisiert.ch.key',
  clientSslCaFilepath: '/etc/ssl/certs/ca-certificates.crt',
  clientSslCertFilepath: '/home/roman/.acme.sh/transistorisiert.ch_ecc/transistorisiert.ch.cer',
  clientSslPrivateKeyFilepath: '/home/roman/.acme.sh/transistorisiert.ch_ecc/transistorisiert.ch.key',
  protocols: [
    {
      name: 'raw',
      onConnecting(wsi) {
        verbose('onConnecting', C, wsi);
      },
      onRawConnected(wsi) {
        verbose('onRawConnected', C, wsi);
      },
      onRawWriteable(wsi) {
        wsi.write(toArrayBuffer('GET / HTTP/1.0\r\n\r\n'));
      },
      onRawRx(wsi, data) {
        data = toString(data);

        verbose('onRawRx', C, wsi, data.trimEnd());
      },
      onRawClose(wsi) {
        verbose('onRawClose', C, wsi);
      } /*,
      callback(wsi, reason, ...args) {
        globalThis.wsi = wsi;
        verbose('raw', C, wsi, reason, getCallbackName(reason).padEnd(29, ' '), args);
        return 0;
      },*/,
    },
    {
      name: 'http',
      onEstablishedClientHttp(wsi, data) {
        verbose('onEstablishedClientHttp', C, data);
      },
      onClientAppendHandshakeHeader(wsi, data, len) {
        verbose('onClientAppendHandshakeHeader', C, { data, len });
      },
      onClientHttpWriteable(wsi) {
        verbose('onClientHttpWriteable', C, wsi);
      },
      onCompletedClientHttp(wsi) {
        verbose('onCompletedClientHttp', C, wsi);
        //wsi.context.cancelService();
      },
      onClosedClientHttp(wsi) {
        verbose('onClosedClientHttp', C, wsi.context);
        ctx.cancelService();
      },
      onReceiveClientHttpRead(wsi, data, len) {
        data = toString(data);
        verbose('onReceiveClientHttpRead', C, { data, len });
      },
      onReceiveClientHttp(wsi, ...rest) {
        //verbose('onReceiveClientHttp(1)', C, { wsi, rest });

        let ret,
          ab = new ArrayBuffer(2048);

        try {
          ret = wsi.httpClientRead(ab);
        } catch(e) {
          console.log('exception', e);
        }

        if(ret) this.onReceiveClientHttpRead(wsi, ab, len); //  verbose('onReceiveClientHttp(2)', C, ret, ab);
      },
      onClientConnectionError(wsi, msg, ...args) {
        verbose('onClientConnectionError', C, toString(msg), args);
      },
      callback(wsi, reason, ...args) {
        globalThis.wsi = wsi;
        verbose('http ' + getCallbackName(reason), C, wsi, args);
        return 0;
      },
    },
  ],
}));

//ctx.clientConnect({ address: 'localhost', port: 22, local_protocol_name: 'raw', method: 'RAW' });
globalThis.client = ctx.clientConnect({
  ...parseUri('https://blog.fefe.de/'),
  method: 'GET',
});
