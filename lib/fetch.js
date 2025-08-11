import { write, toString, toPointer, LWSContext, LWS_WRITE_HTTP_FINAL, LWS_WRITE_HTTP, LCCSCF_USE_SSL, LCCSCF_HTTP_MULTIPART_MIME, LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT, LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX, LWS_SERVER_OPTION_IGNORE_MISSING_CERT, LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED, LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT, LWS_SERVER_OPTION_REDIRECT_HTTP_TO_HTTPS, LWS_SERVER_OPTION_H2_PRIOR_KNOWLEDGE, LWS_PRE, LWSSPA, getCallbackName, } from 'lws';
import { Request } from './lws/request.js';
import { Response } from './lws/response.js';
import { Body } from './lws/body.js';
import createContext from './lws/context.js';

export class ConnectionError extends Error {
  constructor(message) {
    super('ConnectionError: ' + message.replace(/.*fail:\s*/g, ''));
  }
}

export function fetch(url, options = {}) {
  const { body, method, headers, cache, credentials, mode, signal, tls, ...rest } = options;

  let ctx,
    wsi,
    req = new Request(url, { body, method, headers, cache, credentials, mode, signal }),
    resp;

  globalThis.req = req;

  /** @see: https://bun.com/docs/api/fetch#tls */
  const { ca: clientSslCa, cert: clientSslCert, key: clientSslPrivateKey } = tls ?? {};

  return new Promise((resolve, reject) => {
    ctx = createContext({
      options: tls
        ? LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT |
          LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX |
          LWS_SERVER_OPTION_IGNORE_MISSING_CERT |
          LWS_SERVER_OPTION_H2_PRIOR_KNOWLEDGE |
          ('rejectUnauthorized' in tls && !tls.rejectUnauthorized
            ? LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED | LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT | LWS_SERVER_OPTION_REDIRECT_HTTP_TO_HTTPS
            : 0)
        : 0,
      /**/
      clientSslCa,
      clientSslCert,
      clientSslPrivateKey,
      protocols: [
        {
          name: 'http',
          onEstablishedClientHttp(wsi, status) {
            verbose('onEstablishedClientHttp', { wsi, status });

            const { headers, uri: url } = wsi;

            resp = new Response(null, { url, status, headers });

            resolve(resp);
          },
          onClientAppendHandshakeHeader(wsi, data, len) {
            for(let [name, value] of req.headers) wsi.addHeader(name, value, data, len);

            verbose('onClientAppendHandshakeHeader', wsi.method, { data: toString(data.slice(0, len)), len });

            if(!wsi.redirectedToGet && wsi.method == 'POST') {
              wsi.bodyPending = 1;
            }
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
          onReceiveClientHttpRead(wsi, data) {
            Body.write(resp, data);
          },
          onReceiveClientHttp(wsi, buf, len) {
            const ab = new ArrayBuffer(0xff0 * 16);
            let ret;

            try {
              ret = wsi.httpClientRead(ab);
            } catch(e) {
              console.log('exception', e);
            }

            if(ret) this.onReceiveClientHttpRead(wsi, ab);
          },
          onCompletedClientHttp(wsi) {
            Body.close(resp);
          },
          onClosedClientHttp(wsi) {
            verbose('onClosedClientHttp', wsi.context);
            ctx.cancelService();
          },
          onClientConnectionError(wsi, msg) {
            reject(new ConnectionError(msg));
          },
          onClientHttpDropProtocol(wsi) {
            verbose('onClientHttpDropProtocol', wsi);
            ctx.cancelService();
          },
          callback(wsi, reason, ...args) {
            verbose('\x1b[1;35mhttp\x1b[0m ' + getCallbackName(reason), wsi, args);
          },
        },
      ],
    });

    if(signal) {
      console.log('ABORT signal:', signal);

      signal.onabort = () => {
        ctx.cancelService();

        console.log('ABORTED');
      };
    }

    rest.local_protocol_name = rest.protocol ??= 'http';
    rest.method ??= req.method ?? 'GET';

    rest.ssl_connection ??= 0;
    rest.ssl_connection |= LCCSCF_HTTP_MULTIPART_MIME;

    wsi = ctx.clientConnect(req.url, rest);

    verbose('rest', rest);
  });
}

function verbose(name, ...args) {
  console.log('\x1b[2K\r' + name.padEnd(32), console.config({ compact: true }), ...args);
}
