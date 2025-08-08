import { write, toString, toPointer, LWSContext, LWS_WRITE_HTTP_FINAL, LWS_WRITE_HTTP, LCCSCF_USE_SSL, LCCSCF_HTTP_MULTIPART_MIME, LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT, LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX, LWS_SERVER_OPTION_IGNORE_MISSING_CERT, LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED, LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT, LWS_SERVER_OPTION_REDIRECT_HTTP_TO_HTTPS, LWS_SERVER_OPTION_H2_PRIOR_KNOWLEDGE, LWS_PRE, LWSSPA, getCallbackName, } from 'lws';
import { Request } from './fetch/request.js';
import { Response } from './fetch/response.js';
import { Body } from './fetch/body.js';

export function fetch(url, options = {}) {
  const { body, method, headers, cache, credentials, mode, signal, ...rest } = options;
  options = rest;

  let ctx,
    wsi,
    resp = new Response(null, {}),
    req = new Request(url, { body, method, headers, cache, credentials, mode, signal });

  globalThis.req = req;

  return new Promise((resolve, reject) => {
    ctx = new LWSContext({
      asyncDnsServers: ['8.8.8.8', '8.8.4.4', '4.2.2.1'],
      options:
        LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT |
        LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX |
        LWS_SERVER_OPTION_IGNORE_MISSING_CERT |
        LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED |
        LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT |
        LWS_SERVER_OPTION_REDIRECT_HTTP_TO_HTTPS |
        LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT |
        LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX |
        LWS_SERVER_OPTION_H2_PRIOR_KNOWLEDGE,
      clientSslCa: 'ca.crt',
      clientSslCert: 'localhost.crt',
      clientSslPrivateKey: 'localhost.key',
      protocols: [
        {
          name: 'http',
          onEstablishedClientHttp(wsi, status) {
            verbose('onEstablishedClientHttp', { wsi, status });
            resp.status = status;

            if(resp.headers && wsi.headers)
              for(let name in wsi.headers) {
                const value = wsi.headers[name];

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

            verbose('onClientAppendHandshakeHeader', wsi.method, { data: toString(data.slice(0, len)), len });

            if(!wsi.redirectedToGet) if (wsi.method == 'POST') wsi.bodyPending = 1;

            /*   verbose('POST', body.length, wsi);
              wsi.wantWrite(() => {
                wsi.write(body);
              });
            }*/
          },
          onClientHttpRedirect(wsi, buf, status) {
            verbose('onClientHttpRedirect', wsi, buf, status);
            globalThis.redir = buf;
          },
          onClientHttpWriteable(wsi, ...args) {
            verbose('onClientHttpWriteable', wsi, { args });

            const ab = new ArrayBuffer(1024);

            let len = wsi.clientHttpMultipart('test', null, null, ab);
            len += write('TEST\r\n', ab, len);
            len += wsi.clientHttpMultipart('file', 'roman.txt', 'text/plain', ab, len);
            len += write('text file content\r\n\r\n', ab, len);
            len += wsi.clientHttpMultipart(null, null, null, ab, len);

            wsi.write(ab, len, LWS_WRITE_HTTP_FINAL);

            console.log('clientHttpMultipart', { max_len: ab.byteLength, len, buf: toString(ab.slice(0, len)) });

            wsi.bodyPending = 0;
          },
          onReceiveClientHttpRead(wsi, data, len) {
            Body.write(resp, data);

            verbose('onReceiveClientHttpRead', { data, len });
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
          onCompletedClientHttp(wsi) {
            Body.complete(resp);

            verbose('onCompletedClientHttp', wsi);
          },
          onClosedClientHttp(wsi) {
            verbose('onClosedClientHttp', wsi.context);
            ctx.cancelService();
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
            //return 0;
          },
        },
      ],
    });

    rest.local_protocol_name = rest.protocol ??= 'http';
    rest.method ??= req.method ?? 'GET';

    rest.ssl_connection ??= 0;
    rest.ssl_connection |= LCCSCF_HTTP_MULTIPART_MIME;

    wsi = globalThis.wsi = ctx.clientConnect(req.url, rest);

    verbose('rest', rest);
  });
}

function verbose(name, ...args) {
  console.log('\x1b[2K\r' + name.padEnd(32), console.config({ compact: true }), ...args);
}
