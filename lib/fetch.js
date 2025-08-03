import { parseUri, toString, toPointer, toArrayBuffer, LWSContext, LWSSocket, WSI_TOKEN_HTTP_ALLOW, WSI_TOKEN_HTTP_ACCEPT, WSI_TOKEN_HTTP_COOKIE, WSI_TOKEN_HTTP_USER_AGENT, LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT, LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX, LWS_SERVER_OPTION_IGNORE_MISSING_CERT, LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED, LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT, LWS_PRE, LWSSPA, getCallbackName, getCallbackNumber, log, LWSMPRO_HTTP, LWSMPRO_HTTPS, LWSMPRO_FILE, LWSMPRO_CGI, LWSMPRO_REDIR_HTTP, LWSMPRO_REDIR_HTTPS, LWSMPRO_CALLBACK, LWSMPRO_NO_MOUNT, } from 'lws';
import { Request } from './fetch/request.js';
import { Response } from './fetch/response.js';

// fetch('https://blog.fefe.de/')

export function fetch(url, options = {}) {
  const { body, method, headers, cache, credentials, mode, signal, ...rest } = options;
  options = rest;

  let resp = new Response(null, {}),
    req = new Request(url, { body, method, headers, cache, credentials, mode, signal });

  globalThis.req = req;

  return new Promise((resolve, reject) => {
    const ctx = new LWSContext({
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
          name: 'http',
          onEstablishedClientHttp(wsi, status) {
            resp.status = status;

            if(resp.headers && wsi.headers)
              for(let name in wsi.headers) {
                const value = wsi.headers[name];
                //verbose('append header', { name, value });

                try {
                  resp.headers.append(name, value);
                } catch(e) {}
              }

            resolve(resp);

            const { response, method } = wsi;
            verbose('onEstablishedClientHttp', { response, method });
          },
          onClientAppendHandshakeHeader(wsi, data, len) {
            for(let [name, value] of req.headers) wsi.addHeader(name, value, data, len);

            verbose('onClientAppendHandshakeHeader', { data: toString(data, 0, len[0]), len: len[0] });

            const { client, method } = wsi;
            verbose('onClientAppendHandshakeHeader', { client, method });

            if(method == 'POST') {
              wsi.bodyPending = true;
            }
          },
          onClientHttpWriteable(wsi) {
            verbose('onClientHttpWriteable', wsi);

            wsi.bodyPending = 0;

            wsi.write('POST body\r\n1234\r\n\r\n');
          },
          onCompletedClientHttp(wsi) {
            verbose('onCompletedClientHttp', wsi);
          },
          onClosedClientHttp(wsi) {
            verbose('onClosedClientHttp', wsi.context);
            ctx.cancelService();
          },
          onReceiveClientHttpRead(wsi, data, len) {
            const str = toString(data, 0, len);

            resp._bodyText += str;
            resp._noBody = false;

            verbose('onReceiveClientHttpRead', { len, str });
          },
          onReceiveClientHttp(wsi, ...rest) {
            const ab = new ArrayBuffer(0xff0 * 16);

            let ret;

            try {
              ret = wsi.httpClientRead(ab);
            } catch(e) {
              console.log('exception', e);
            }

            verbose('onReceiveClientHttp(1)', { ptr: toPointer(ab), ret });

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
            verbose('\x1b[1;35mhttp\x1b[0m ' + getCallbackName(reason), wsi, args);
            return 0;
          },
        },
      ],
    });

    rest.local_protocol_name = rest.protocol ??= 'http';
    rest.method ??= req.method ?? 'GET';

    const wsi = ctx.clientConnect(req.url, rest);

    verbose('rest', rest);
  });
}

function verbose(name, ...args) {
  //console.log('\r' + name.padEnd(32), console.config({ compact: true }), ...args);
}
