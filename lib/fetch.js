import { write, toString, toPointer, LWSContext, LWS_WRITE_HTTP_FINAL, LWS_WRITE_HTTP, LCCSCF_USE_SSL, LCCSCF_ALLOW_SELFSIGNED, LCCSCF_SKIP_SERVER_CERT_HOSTNAME_CHECK, LCCSCF_ALLOW_EXPIRED, LCCSCF_ALLOW_INSECURE, LCCSCF_HTTP_MULTIPART_MIME, LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT, LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX, LWS_SERVER_OPTION_IGNORE_MISSING_CERT, LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED, LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT, LWS_SERVER_OPTION_REDIRECT_HTTP_TO_HTTPS, LWS_SERVER_OPTION_H2_PRIOR_KNOWLEDGE, LWS_PRE, LWSSPA, getCallbackName, } from 'lws';
import { ReadableStream } from './lws/streams.js';
import { Headers } from './lws/headers.js';
import { Request } from './lws/request.js';
import { Response } from './lws/response.js';
import { Body } from './lws/body.js';
import { ConnectionError, debug, verbose } from './lws/util.js';
import createContext from './lws/context.js';

export function fetch(url, options = {}) {
  const { body, method, headers, cache, credentials, mode, signal, tls, ...rest } = options;

  let ctx,
    wsi,
    req = new Request(url, { body, method, headers, cache, credentials, mode, signal }),
    resp;

  globalThis.req = req;

  /** @see: https://bun.com/docs/api/fetch#tls */
  const { ca: clientSslCa, cert: clientSslCert, key: clientSslPrivateKey } = tls ?? {};

  const controller = {};

  resp = new Response(
    new ReadableStream({
      start(c) {
        controller.readable = c;
      },
    }),
    {},
  );

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
          onServerNewClientInstantiated(wsi) {
            if(options.pwsi) options.pwsi(wsi);
          },
          onEstablishedClientHttp(wsi, status) {
            const { h2, headers, uri: url } = wsi;

            verbose('onEstablishedClientHttp', { wsi, status, h2, headers });

            resp.status = status;
            resp.headers = new Headers(headers);

            resolve(resp);
            //Body.begin(resp, resolve);
          },
          onClientAppendHandshakeHeader(wsi, data, len) {
            verbose('onClientAppendHandshakeHeader(1)', wsi, { data, len });

            for(let [name, value] of req.headers) {
              verbose('onClientAppendHandshakeHeader(2)', { name, value });
              wsi.addHeader(name, value, data, len);
            }

            verbose('onClientAppendHandshakeHeader(3)', wsi.method, { data: toString(data.slice(0, len[0])), len });

            if(!wsi.redirectedToGet && wsi.method == 'POST') {
              wsi.bodyPending = 1;
            }
          },
          onClientHttpRedirect(wsi, url, status) {
            verbose('onClientHttpRedirect', wsi, url, status);
            //globalThis.redir = url;
            //controller.readable.enqueue(url);

            const { headers } = wsi;

            resp.status = status;
            resp.headers = new Headers(headers);
          },
          onClientHttpWriteable(wsi, ...args) {
            verbose('onClientHttpWriteable', wsi, { args });

            const ab = new ArrayBuffer(1024);

            let len = wsi.clientHttpMultipart('test', null, null, ab);

            if(len !== undefined) {
              len += write('TEST\r\n', ab, len);
              len += wsi.clientHttpMultipart('file', 'roman.txt', 'text/plain', ab, len);
              len += write('text file content\r\n\r\n', ab, len);
              len += wsi.clientHttpMultipart(null, null, null, ab, len);

              wsi.write(ab, len, LWS_WRITE_HTTP_FINAL);

              wsi.bodyPending = 0;

              console.log('clientHttpMultipart', { max_len: ab.byteLength, len, buf: toString(ab.slice(0, len ?? 0)) });
            }
          },
          onReceiveClientHttpRead(wsi, data) {
            verbose('onReceiveClientHttpRead', wsi, data.byteLength);
            controller.readable.enqueue(new Uint8Array(data));
          },
          onReceiveClientHttp(wsi, buf, len) {
            verbose('onReceiveClientHttp', wsi, buf, len);
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
            verbose('onCompletedClientHttp', wsi);
            controller.readable.close();
          },
          onClosedClientHttp(wsi) {
            verbose('onClosedClientHttp', wsi);
            // ctx.cancelService();
          },
          onClientConnectionError(wsi, msg, errno) {
            verbose('onClientConnectionError', { msg, errno });

            //reject(new ConnectionError(msg));
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

    /*rest.ssl_connection ??= 0;

    if(tls) rest.ssl_connection |= LCCSCF_USE_SSL | LCCSCF_ALLOW_EXPIRED /* | LCCSCF_ALLOW_SELFSIGNED | LCCSCF_SKIP_SERVER_CERT_HOSTNAME_CHECK | LCCSCF_ALLOW_INSECURE*/ if (rest.h2 === true)
      rest.ssl_connection |= LCCSCF_H2_PRIOR_KNOWLEDGE;

    rest.alpn ??= rest.h2 === false ? 'http/1.1' : /*rest.h2 === true ? 'h2' : */ 'h2,http/1.1';

    if(method == 'POST') rest.ssl_connection |= LCCSCF_HTTP_MULTIPART_MIME;

    wsi = ctx.clientConnect(req.url, rest);

    verbose('rest', rest);
  });
}
