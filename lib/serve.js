import { logLevel, LWSSPA, getCallbackName, LLL_ERR, LLL_USER, LWS_SERVER_OPTION_VH_H2_HALF_CLOSED_LONG_POLL, LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT, LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED, LWS_SERVER_OPTION_IGNORE_MISSING_CERT, LWS_SERVER_OPTION_ALLOW_HTTP_ON_HTTPS_LISTENER, LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT, LWS_WRITE_HTTP_FINAL, LWS_WRITE_HTTP, LWSMPRO_NO_MOUNT, LWSMPRO_HTTPS, LWSMPRO_HTTP, LWSMPRO_CALLBACK, LWSMPRO_FILE, LWSContext, toArrayBuffer, toString, } from 'lws';
import { setTimeout } from 'os';
import { Request } from './lws/request.js';
import { Body } from './lws/body.js';
import { waitWrite, writeStream, isPrototypeOf, assign, verbose, debug, weakMapper } from './lws/util.js';
import extraMimetypes from './lws/mimetypes.js';
import createContext from './lws/context.js';
export { Response } from './lws/response.js';

const wsi2spa = weakMapper(
  () =>
    new LWSSPA(wsi, {
      maxStorage: 1 << 17,
      onOpen(name, filename) {
        verbose('spa.onOpen', { [name]: filename });
      },
      onContent(name, filename, buf) {
        verbose('spa.onContent', { [name]: filename, buf });
      },
      onClose(name, filename) {
        verbose('spa.onClose', { [name]: filename });
      },
    }),
);

const wsi2obj = weakMapper(() => ({}));

export function serve(...args) {
  let opts = {},
    handler,
    ret;

  for(let arg of args) {
    if(typeof arg == 'object' && arg !== null) Object.assign(opts, arg);
    else if(typeof arg == 'function') handler = arg;
  }

  if(!handler)
    ret = {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise((resolve, reject) => {
            handler = value => new Promise((r2, e2) => resolve({ value: assign(value, { respond: response => r2(response) }), done: false }));
          }),
      }),
    };

  globalThis.ctx = createContext({
    port: opts.port ?? 8886,
    vhostName: opts.host ?? 'localhost.transistorisiert.ch',
    options:
      LWS_SERVER_OPTION_IGNORE_MISSING_CERT |
      LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED |
      LWS_SERVER_OPTION_ALLOW_HTTP_ON_HTTPS_LISTENER |
      LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT |
      LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT |
      LWS_SERVER_OPTION_VH_H2_HALF_CLOSED_LONG_POLL,
    listenAcceptRole: 'raw-skt',
    listenAcceptProtocol: 'raw-echo',
    serverSslCa: 'ca.crt',
    serverSslCert: 'localhost.crt',
    serverSslPrivateKey: 'localhost.key',
    mounts: [
      { mountpoint: '/ws', protocol: 'ws', originProtocol: LWSMPRO_NO_MOUNT },
      { mountpoint: '/test', protocol: 'http', originProtocol: LWSMPRO_CALLBACK },
      { mountpoint: '/warmcat', origin: 'warmcat.com/', def: 'index.html', originProtocol: LWSMPRO_HTTP },
      //{ mountpoint: '/', origin: 'warmcat.com/', def: 'index.html', originProtocol: LWSMPRO_HTTP },
      {
        mountpoint: '/',
        origin: '.',
        def: 'README.md',
        originProtocol: LWSMPRO_FILE,
        protocol: 'http',
        extraMimetypes,
      },
    ],
    protocols: [
      {
        name: 'ws',
        onOpensslPerformServerCertVerification(wsi, ssl, preverify_ok) {
          verbose('onOpensslPerformServerCertVerification', wsi, '0x' + ssl.toString(16), preverify_ok);
          return 0;
        },
        onHttpConfirmUpgrade(wsi, type) {
          verbose('onHttpConfirmUpgrade', wsi, type, wsi.protocol);
        },
        onEstablished(wsi) {
          verbose('onEstablished', wsi);
        },
        onClosed(wsi) {
          verbose('onClosed', wsi);
        },
        onReceivePong(wsi) {
          verbose('onReceivePong', wsi);
        },
        onWsPeerInitiatedClose(wsi) {
          verbose('onWsPeerInitiatedClose', wsi);
        },
        onReceive(wsi, data) {
          let str = toString(data).replace(/\n/g, '\\n');

          verbose('onReceive', wsi, str);
          wsi.write(data);
        },
        onFilterHttpConnection(wsi, url) {
          const { headers } = wsi;

          verbose('onFilterHttpConnection', wsi, url, headers);

          if(/multipart/.test(headers['content-type'])) wsi2spa(wsi);
        },
        callback(wsi, reason, ...args) {
          verbose('ws ' + getCallbackName(reason), wsi, args);
          return 0;
        },
      },
      {
        name: 'http',
        onHttpBindProtocol(wsi) {
          wsi2obj(wsi, {});
        },
        onHttpBody(wsi, buf) {
          verbose('onHttpBody', wsi, buf.byteLength);

          const obj = wsi2obj(wsi);

          const { req } = obj;

          obj.len = (obj.len ?? 0) + buf.byteLength;

          Body.write(req, buf);
        },
        async onHttpBodyCompletion(wsi) {
          verbose('onHttpBodyCompletion', wsi);

          const { promise, req, len } = wsi2obj(wsi);

          Body.close(req);

          verbose('onHttpBodyCompletion.req', req);

          await waitWrite(wsi);

          wsi.respond(200, { 'content-type': 'text/html' });

          await waitWrite(wsi);

          wsi.write(`Uploaded ${len} bytes\r\n`, LWS_WRITE_HTTP_FINAL);
        },
        onHttpWriteable(wsi) {
          verbose('onHttpWriteable', wsi);
        },
        async onHttp(wsi, buf) {
          const { protocol, method, uri, headers } = wsi;

          verbose('onHttp', { method, uri });

          globalThis.wsi = wsi;
          const obj = wsi2obj(wsi);

          const req = (obj.req = new Request(uri, { method, headers }));
          const promise = (obj.promise = handler.call(wsi, req).then(resp => {
            if(!isPrototypeOf(Response.prototype, resp)) {
              const { body, ...rest } = resp;
              resp = new Response(body, rest);
            }
            verbose('onHttp.response', resp);
            return resp;
          }));

          globalThis.req = req;

          verbose('onHttp.promise', promise);

          if(method == 'POST') {
          } else {
            await waitWrite(wsi);

            wsi.respond(200, { 'content-type': 'text/html' });

            await waitWrite(wsi);

            wsi.write(`TEST\r\n`, LWS_WRITE_HTTP_FINAL);
          }
        },
        onAddHeaders(wsi, buf, len) {
          wsi.addHeader('test', 'blah', buf, len);

          verbose('onAddHeaders', wsi, { buf: toString(buf.slice(0, len)), len });
        },
        onClosedHttp(wsi) {
          verbose('onClosedHttp', wsi);
        },
        callback(wsi, reason, ...args) {
          verbose('http ' + getCallbackName(reason), wsi, args);
        },
      },
    ],
  });

  return ret;
}
