import { parseUri, toString, toArrayBuffer, LWSContext, LWSSocket, LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT, LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX, LWS_SERVER_OPTION_IGNORE_MISSING_CERT, LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED, LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT, LWS_PRE, LWSSPA, getCallbackName, getCallbackNumber, log, LWSMPRO_HTTP, LWSMPRO_HTTPS, LWSMPRO_FILE, LWSMPRO_CGI, LWSMPRO_REDIR_HTTP, LWSMPRO_REDIR_HTTPS, LWSMPRO_CALLBACK, LWSMPRO_NO_MOUNT, } from 'lws';

const C = console.config({ compact: true, maxStringLength: +(process.env.COLUMNS ?? 120) - 92, maxArrayLength: 8 });

function verbose(name, ...args) {
  console.log('\r' + name.padEnd(32), C, ...args);
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
  clientSslCaFilepath: 'ca.crt',
  clientSslCertFilepath: 'localhost.crt',
  clientSslPrivateKeyFilepath: 'localhost.key',
  protocols: [
    {
      name: 'raw',
      onConnecting(wsi) {
        verbose('onConnecting', wsi);
      },
      onRawConnected(wsi) {
        verbose('onRawConnected', wsi);
      },
      onRawWriteable(wsi) {
        wsi.write(toArrayBuffer('GET / HTTP/1.0\r\n\r\n'));
      },
      onRawRx(wsi, data) {
        data = toString(data);

        verbose('onRawRx', wsi, data.trimEnd());
      },
      onRawClose(wsi) {
        verbose('onRawClose', wsi);
      },
      callback(wsi, reason, ...args) {
        globalThis.wsi = wsi;
        verbose('raw ' + getCallbackName(reason), wsi, args);
        return 0;
      },
    },
    {
      name: 'http',
      onEstablishedClientHttp(wsi, data) {
        verbose('onEstablishedClientHttp', data);
      },
      onClientAppendHandshakeHeader(wsi, data, len) {
        wsi.addHeader('cookie', 'test', data, len);

        verbose('onClientAppendHandshakeHeader', { data: toString(data, 0, len[0]), len: len[0] });
      },
      onClientHttpWriteable(wsi) {
        verbose('onClientHttpWriteable', wsi);
      },
      onCompletedClientHttp(wsi) {
        verbose('onCompletedClientHttp', wsi);
        //wsi.context.cancelService();
      },
      onClosedClientHttp(wsi) {
        verbose('onClosedClientHttp', wsi.context);
        ctx.cancelService();
      },
      onReceiveClientHttpRead(wsi, data, len) {
        data = toString(data);
        verbose('onReceiveClientHttpRead', { data, len });
      },
      onReceiveClientHttp(wsi, ...rest) {
        //verbose('onReceiveClientHttp(1)', { wsi, rest });

        let ret,
          ab = new ArrayBuffer(2048);

        try {
          ret = wsi.httpClientRead(ab);
        } catch(e) {
          console.log('exception', e);
        }

        if(ret) this.onReceiveClientHttpRead(wsi, ab, len); //verbose('onReceiveClientHttp(2)', ret, ab);
      },
      onClientConnectionError(wsi, msg, ...args) {
        verbose('onClientConnectionError', toString(msg), args);
      },
      callback(wsi, reason, ...args) {
        globalThis.wsi = wsi;
        verbose('http ' + getCallbackName(reason), wsi, args);
        return 0;
      },
    },
  ],
}));

//ctx.clientConnect({ address: 'localhost', port: 22, local_protocol_name: 'raw', method: 'RAW' });

globalThis.client = ctx.clientConnect('https://blog.fefe.de/');

os.kill(os.getpid(), os.SIGUSR1);
