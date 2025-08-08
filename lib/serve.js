import { logLevel, LWSSPA, getCallbackName, LLL_ERR, LLL_WARN, LLL_INFO, LLL_NOTICE, LLL_USER, LLL_CLIENT, LWS_ILLEGAL_HTTP_CONTENT_LEN, LWS_SERVER_OPTION_VH_H2_HALF_CLOSED_LONG_POLL, LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT, LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED, LWS_SERVER_OPTION_IGNORE_MISSING_CERT, LWS_SERVER_OPTION_ALLOW_HTTP_ON_HTTPS_LISTENER, LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT, LWS_WRITE_HTTP_FINAL, LWS_WRITE_HTTP, LWSMPRO_NO_MOUNT, LWSMPRO_HTTPS, LWSMPRO_HTTP, LWSMPRO_CALLBACK, LWSMPRO_FILE, LWSContext, toArrayBuffer, toString, } from 'lws';
import { setTimeout } from 'os';
import { Request } from './lws/request.js';
import { Body } from './lws/body.js';
export { Response } from './lws/response.js';

logLevel(LLL_ERR | LLL_USER);

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
    handler;

  for(let arg of args) {
    if(typeof arg == 'object' && arg !== null) Object.assign(opts, arg);
    else if(typeof arg == 'function') handler = arg;
  }

  globalThis.ctx = new LWSContext({
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
        onReceive(wsi, data, len) {
          data = data.toString().replace(/\n/g, '\\n');

          verbose('onReceive', wsi, data, len);
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

          Body.write(req, buf);
        },
        async onHttpBodyCompletion(wsi) {
          verbose('onHttpBodyCompletion', wsi);

          const { promise, req } = wsi2obj(wsi);

          Body.complete(req);

          const response = await promise;

          await waitWrite(wsi);

          wsi.respond(response.status, Object.fromEntries(response.headers), await response.arrayBuffer());
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
          const promise = (obj.promise = handler.call(wsi, req));

          globalThis.req = req;

          verbose('onHttp', { obj });

          if(method == 'POST') {
          } else {
            const response = await promise;

            await waitWrite(wsi);

            wsi.respond(response.status, Object.fromEntries(response.headers));

            const stream = response.body;
            const rd = stream.getReader();
            let result;

            while((result = await rd.read())) {
              const { value, done } = result;

              await waitWrite(wsi);
              let r = wsi.write(done ? '\n' : value, done ? 1 : value.byteLength, done ? LWS_WRITE_HTTP_FINAL : LWS_WRITE_HTTP);
              if(done) break;
            }

            rd.releaseLock();
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
        extraMimetypes: [
          ['.diff', 'text/x-diff'],
          ['.patch', 'text/x-diff  '],
          ['.c', 'text/x-c'],
          ['.h', 'text/x-c'],
          ['.md', 'text/markdown'],
          ['.crt', 'text/plain'],
          ['.key', 'text/plain'],
          ['.sublime-project', 'text/plain'],
          ['.sublime-workspace', 'text/plain'],
          ['.js', 'application/javascript'],
        ],
      },
    ],
  });
}
function waitWrite(wsi) {
  return new Promise((resolve, reject) => wsi.wantWrite(resolve));
}

function verbose(name, ...args) {
  console.log((name + '').padEnd(32), console.config({ compact: true }), ...args);
}

function debug(name, ...args) {
  if(process.env.DEBUG) verbose(name, ...args);
}

function weakMapper(create, target = new WeakMap()) {
  return (key, ret) => {
    if(ret) target.set(key, ret);
    else if(!(ret = target.get(key))) target.set(key, (ret = create(key)));
    return ret;
  };
}
