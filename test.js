import * as lws from 'lws';
const cbnames = Object.getOwnPropertyNames(lws)
  .filter(n => /LWS_CALLB/.test(n))
  .reduce((a, n) => {
    a[lws[n]] = n;
    return a;
  }, []);
let ctx = new lws.LWSContext({
  port: 8885,
  http_proxy_address: '127.0.0.1',
  http_proxy_port: 8123,
  socks_proxy_address: '127.0.0.1',
  socks_proxy_port: 9050,
  protocols: [{ name: 'http', callback: (wsi, reason, ...args) => ((globalThis.wsi = wsi), console.log(cbnames[reason].padEnd(42, ' ').slice(13), console.config({ compact: true }), args), 0) }],
  mounts: [{ mountpoint: '/test', origin: '.', def: 'index.html', origin_protocol: lws.LWSMPRO_FILE }]
});
