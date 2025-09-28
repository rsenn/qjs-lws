import { parseUri, toString, toPointer, toArrayBuffer, LWSContext, LWSSocket, WSI_TOKEN_HTTP_ALLOW, WSI_TOKEN_HTTP_ACCEPT, WSI_TOKEN_HTTP_COOKIE, WSI_TOKEN_HTTP_USER_AGENT, LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT, LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX, LWS_SERVER_OPTION_IGNORE_MISSING_CERT, LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED, LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT, LWS_PRE, LWSSPA, getCallbackName, getCallbackNumber, log, LWSMPRO_HTTP, LWSMPRO_HTTPS, LWSMPRO_FILE, LWSMPRO_CGI, LWSMPRO_REDIR_HTTP, LWSMPRO_REDIR_HTTPS, LWSMPRO_CALLBACK, LWSMPRO_NO_MOUNT, } from 'lws';
import { interactive, verbose, debug, weakMapper } from './lib/lws/util.js';

const C = console.config({ compact: true, maxStringLength: +(process.env.COLUMNS ?? 120) - 92, maxArrayLength: 8 });

const wsi2obj = weakMapper(() => ({}));

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
        wsi.addHeader(WSI_TOKEN_HTTP_ALLOW, 'GET, POST, HEAD', data, len);
        wsi.addHeader(WSI_TOKEN_HTTP_ACCEPT, '*/*', data, len);
        wsi.addHeader(WSI_TOKEN_HTTP_COOKIE, 'test=1234;', data, len);
        wsi.addHeader(WSI_TOKEN_HTTP_USER_AGENT, 'QuickJS', data, len);

        verbose('onClientAppendHandshakeHeader', { data: toString(data, 0, len[0]), len: len[0] });
      },
      onClientHttpWriteable(wsi) {
        verbose('onClientHttpWriteable', wsi);
      },
      onCompletedClientHttp(wsi) {
        verbose('onCompletedClientHttp', wsi);
      },
      onClosedClientHttp(wsi) {
        verbose('onClosedClientHttp', wsi.context);
        ctx.cancelService();
      },
      onReceiveClientHttpRead(wsi, data, len) {
        const obj = wsi2obj(wsi);
        const str = toString(data, 0, len);

        verbose('onReceiveClientHttpRead', { len, str });

        //obj.offset += len;
      },
      onReceiveClientHttp(wsi, ...rest) {
        const obj = wsi2obj(wsi);

        obj.offset ??= 0;

        const ab = (obj.buffer ??= new ArrayBuffer(0xff0 * 16));

        let ret;

        try {
          ret = wsi.httpClientRead(ab, obj.offset);
        } catch(e) {
          console.log('exception', e);
        }

        //verbose('onReceiveClientHttp(1)', { ptr: toPointer(ab), offset: obj.offset, ret });

        if(ret) this.onReceiveClientHttpRead(wsi, ab);
      },
      onClientConnectionError(wsi, msg) {
        verbose('onClientConnectionError', { msg });
      },
      onClientHttpDropProtocol(wsi) {
        verbose('onClientHttpDropProtocol', wsi);
        ctx.cancelService();
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

interactive();

function interactive() {
  os.kill(os.getpid(), os.SIGUSR1);
}
