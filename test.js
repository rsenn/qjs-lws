//import * as lws from 'lws';
import { LWSSPA, getCallbackName, LWS_ILLEGAL_HTTP_CONTENT_LEN, LWS_SERVER_OPTION_VH_H2_HALF_CLOSED_LONG_POLL, LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT, LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED, LWS_SERVER_OPTION_IGNORE_MISSING_CERT, LWS_SERVER_OPTION_ALLOW_HTTP_ON_HTTPS_LISTENER, LWS_SERVER_OPTION_REDIRECT_HTTP_TO_HTTPS, LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT, LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG, LWS_WRITE_HTTP_FINAL, LWSMPRO_NO_MOUNT, LWSMPRO_HTTPS, LWSMPRO_HTTP, LWSMPRO_CALLBACK, LWSMPRO_FILE, LWSContext, log, toArrayBuffer, } from 'lws';
import { setTimeout } from 'os';

function verbose(name, ...args) {
  console.log(name.padEnd(32), ...args);
}

function debug(name, ...args) {
  if(process.env.DEBUG) console.log(name.padEnd(32), ...args);
}

function weakMapper(createFn, map = new WeakMap(), hitFn) {
  let self = function(obj, ...args) {
    let ret;

    if(map.has(obj)) {
      ret = map.get(obj);
      if(typeof hitFn == 'function') hitFn(obj, ret);
    } else {
      ret = createFn(obj, ...args);
      map.set(obj, ret);
    }

    return ret;
  };

  self.set = (k, v) => map.set(k, v);
  self.get = k => map.get(k);
  self.map = map;

  return self;
}

const C = console.config({ compact: true, maxArrayLength: 8 });

const spa = (globalThis.spa = weakMapper(
  () =>
    new LWSSPA(wsi, {
    maxStorage: 32 * 1024,
      onOpen(name, filename) {
        verbose('spa.onOpen', C, { name, filename });
      },
      onContent(name, filename, buf) {
        verbose('spa.onContent', C, { name, filename, buf });
      },
      onClose(name, filename) {
        verbose('spa.onClose', C, { name, filename });
      },
    }),
  new WeakMap(),
));

const wsi2obj = (globalThis.wsi2obj = (() => {
  const m = new WeakMap();

  return wsi => {
    let obj;

    if(!(obj = m.get(wsi))) m.set(wsi, (obj = {}));

    return obj;
  };
})());

const protocols = [
  {
    name: 'ws',
    onOpensslPerformServerCertVerification(wsi, ssl, preverify_ok) {
      verbose('onOpensslPerformServerCertVerification', C, wsi, '0x' + ssl.toString(16), preverify_ok);
      return 0;
    },
    onHttpConfirmUpgrade(wsi, type) {
      verbose('onHttpConfirmUpgrade', C, wsi, type, wsi.protocol);
    },
    onReceive(wsi, data, len) {
      wsi.write(data);
    },
    onFilterHttpConnection(wsi, url) {
      const { headers } = wsi;

      verbose('onFilterHttpConnection', C, wsi, url, headers);

      if(/multipart/.test(headers['content-type'])) {
        spa(
          wsi,
          new LWSSPA(wsi, {
            onContent(name, filename, buf) {
              verbose('onContent', C, { name, filename, buf });
            },
            onOpen(name, filename) {
              verbose('onOpen', C, { name, filename });
            },
            onClose(name, filename) {
              verbose('onClose', C, { name, filename });
            },
          }),
        );
      }
    },
    callback(wsi, reason, ...args) {
      verbose('ws ' + getCallbackName(reason), C, wsi, args);
      return 0;
    },
  },
  {
    name: 'raw-echo',
    callback(wsi, reason, ...args) {
      verbose('raw-echo ' + getCallbackName(reason), C, wsi, args);
      return 0;
    },
  },
  {
    name: 'http',
    onHttpBody(wsi, buf, len) {
      const s = spa(wsi);

      debug('onHttpBody', C, s, buf);

      s.process(buf);
    },
    onHttpBodyCompletion(wsi) {
      verbose('onHttpBodyCompletion', C, wsi);
      const s = spa(wsi);

      s.finalize();

      wsi.wantWrite(() => {
        verbose('respond.onHttpBodyCompletion', C, wsi);

        const b = toArrayBuffer('POST completed!\r\n');

        wsi.respond(200, { 'content-type': 'text/html', test: 'blah' }, b.byteLength);
        wsi.write(b, LWS_WRITE_HTTP_FINAL);

        return -1;
      });
    },
    onHttpWriteable(wsi) {
      verbose('onHttpWriteable', C, wsi);
      const obj = wsi2obj(wsi);

      if(!obj.responded) {
        obj.lines = (JSON.stringify({ blah: 1234, test: [1, 2, 3, 4], x: true }, null, 2) + '\n').split('\n');

        wsi.respond(200, LWS_ILLEGAL_HTTP_CONTENT_LEN ?? obj.lines.length, { 'content-type': 'text/html' /*, connection: 'close'*/ });

        obj.index = 0;
        setTimeout(() => wsi.wantWrite(), 0);

        obj.responded = 1;
        return 0;
      }

      wsi.write(obj.lines[obj.index] + '\n', obj.lines[++obj.index] ? LWS_WRITE_HTTP : LWS_WRITE_HTTP_FINAL);

      if(obj.lines[obj.index]) {
        setTimeout(() => wsi.wantWrite(), 100);
        return 0;
      }

      return -1;
    },
    onHttp(wsi, buf) {
      const { protocol, method, uri, headers } = wsi;
      verbose('onHttp', C, wsi, { protocol: protocol.name, method, uri }, console.config({ compact: false }), headers);

      globalThis.wsi = wsi;

      if(method != 'POST') wsi.wantWrite();
    },
    callback(wsi, reason, ...args) {
      verbose('http ' + getCallbackName(reason), C, wsi, args);
      return 0;
    },
  },
];

globalThis.ctx = new LWSContext({
  port: 8886,
  vhostName: 'localhost.transistorisiert.ch',
  options:
    LWS_SERVER_OPTION_IGNORE_MISSING_CERT |
    LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED |
    LWS_SERVER_OPTION_ALLOW_HTTP_ON_HTTPS_LISTENER |
    LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT |
    LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT |
    LWS_SERVER_OPTION_VH_H2_HALF_CLOSED_LONG_POLL,
  listenAcceptRole: 'raw-skt',
  listenAcceptProtocol: 'raw-echo',
  protocols,
  sslCaFilepath: 'ca.crt',
  sslCertFilepath: 'localhost.crt',
  sslPrivateKeyFilepath: 'localhost.key',
  mounts: [
    { mountpoint: '/ws', protocol: 'ws', originProtocol: LWSMPRO_NO_MOUNT },
    { mountpoint: '/test', protocol: 'http', originProtocol: LWSMPRO_CALLBACK },
    //{ mountpoint: '/', origin: '127.0.0.1:8000/warmcat/', def: 'index.html', originProtocol: LWSMPRO_HTTP },
    { mountpoint: '/', origin: 'warmcat.com/', def: 'index.html', originProtocol: LWSMPRO_HTTP },
    //{ mountpoint: '/', origin: '.', def: 'index.html', originProtocol: LWSMPRO_FILE },
  ],
});
