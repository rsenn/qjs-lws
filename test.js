import { logLevel, LWSSPA, getCallbackName, LLL_ERR, LLL_WARN, LLL_INFO, LLL_NOTICE, LLL_USER, LLL_CLIENT, LWS_ILLEGAL_HTTP_CONTENT_LEN, LWS_SERVER_OPTION_VH_H2_HALF_CLOSED_LONG_POLL, LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT, LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED, LWS_SERVER_OPTION_IGNORE_MISSING_CERT, LWS_SERVER_OPTION_ALLOW_HTTP_ON_HTTPS_LISTENER, LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT, LWS_WRITE_HTTP_FINAL, LWSMPRO_NO_MOUNT, LWSMPRO_HTTPS, LWSMPRO_HTTP, LWSMPRO_CALLBACK, LWSMPRO_FILE, LWSContext, toArrayBuffer, toString, } from 'lws';
import { setTimeout } from 'os';

logLevel(LLL_ERR | LLL_USER);

const C = console.config({ compact: true, maxArrayLength: 8 });

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

const wsi2obj = weakMapper();

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
        if(!('byteLength' in data)) data = data.toString().replace(/\n/g, '\\n');

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
      onHttpBody(wsi, buf, len) {
        const s = wsi2spa(wsi);

        debug('onHttpBody', s, buf);

        s.process(buf, 0, buf.byteLength);
      },
      onHttpBodyCompletion(wsi) {
        verbose('onHttpBodyCompletion', wsi);
        const s = wsi2spa(wsi);

        s.finalize();

        wsi.wantWrite(() => {
          verbose('respond.onHttpBodyCompletion', wsi);

          const b = toArrayBuffer('POST completed!\r\n');

          wsi.respond(200, { 'content-type': 'text/html', test: 'blah' }, b.byteLength);
          wsi.write(b, LWS_WRITE_HTTP_FINAL);

          return -1;
        });
      },
      onHttpWriteable(wsi) {
        verbose('onHttpWriteable', wsi);
        const obj = wsi2obj(wsi);

        if(!obj.responded) {
          obj.lines = (JSON.stringify({ blah: 1234, test: [1, 2, 3, 4], x: true }, null, 2) + '\n').split('\n');

          wsi.respond(200, LWS_ILLEGAL_HTTP_CONTENT_LEN ?? obj.lines.length, {
            'content-type': 'text/html' /*, connection: 'close'*/,
          });

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
        verbose('onHttp', wsi, { protocol: protocol.name, method, uri }, console.config({ compact: false }), headers);

        globalThis.wsi = wsi;

        if(method != 'POST') wsi.wantWrite();
      },
      onAddHeaders(wsi, buf, len) {
        wsi.addHeader('test', 'blah', buf, len);

        verbose('onAddHeaders', wsi, { buf, len });
      },
      callback(wsi, reason, ...args) {
        verbose('http ' + getCallbackName(reason), wsi, args);
        return 0;
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

function verbose(name, ...args) {
  console.log(name.padEnd(32), C, ...args);
}

function debug(name, ...args) {
  if(process.env.DEBUG) verbose(name, ...args);
}

function weakMapper(create = () => ({}), target = new WeakMap()) {
  return (key, val) => {
    let ret;
    if(target.has(key)) ret = target.get(key);
    else target.set(key, (ret = create(key, val)));
    return ret;
  };
}
