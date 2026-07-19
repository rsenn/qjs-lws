/**
 * A forward proxy: HTTP/1.1 (CONNECT + every other method, plain or TLS) and
 * SOCKS4/4a/5 on the listening side; direct, SOCKS4/5, or
 * upstream-HTTP-CONNECT bridging on the onward side. See PLAN.md and
 * README.md for the full design and its two libwebsockets-imposed
 * limitations (no absolute-URI HTTP requests through lws's own HTTP role,
 * no generic h2 CONNECT tunnel).
 *
 * Run:
 *   qjs server.js [--proxy-port 8123] [--socks-port 1080] [--config path] [-v]
 *   qjs server.js --onward-mode socks5 --onward-host 127.0.0.1 --onward-port 9050
 *   qjs server.js --tls-cert cert.pem --tls-key key.pem
 *
 * Or via a Polipo-style config file (default: ./proxy.conf next to this
 * script) - see README.md for the format.
 */
import {
  createServer,
  LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT,
  LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX,
  LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT,
  LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG,
  LWS_SERVER_OPTION_IGNORE_MISSING_CERT,
  LWS_SERVER_OPTION_ONLY_RAW,
} from 'lws.so';
import * as std from 'std';
import { loadOrCreateCert } from '../../lib/lws/tls.js';
import { loadConfig } from './lib/config.js';
import { createHttpProxyListener } from './lib/http-proxy-listener.js';
import { createSocksListener } from './lib/socks-listener.js';

let config;

try {
  config = loadConfig(scriptArgs.slice(1));
} catch(e) {
  console.error(`proxy: ${e.message}`);
  std.exit(1);
}

function log(msg) {
  if(config.verbose) console.log(`[proxy] ${msg}`);
}

const listenerOpts = { onward: config.onward, log };
let listening = 0;

if(config.proxyPort) {
  /* Plain and TLS clients are accepted on the *same* port -
     LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT, combined with
     LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG, is
     documented (lws-context-vhost.h) as exactly what's needed for a raw-skt
     listener to also terminate TLS - verified empirically: the raw
     callback gets decrypted plaintext either way. No cert given -> a
     self-signed one is generated and persisted under tlsDir so repeat runs
     reuse the same identity instead of minting a new one every time. */
  const { cert, key } = config.tlsCert && config.tlsKey ? { cert: config.tlsCert, key: config.tlsKey } : loadOrCreateCert(config.tlsDir, { commonName: 'localhost' });

  createServer({
    port: config.proxyPort,
    vhostName: 'localhost',
    options:
      LWS_SERVER_OPTION_ONLY_RAW |
      LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG |
      LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT |
      LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT |
      LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX |
      LWS_SERVER_OPTION_IGNORE_MISSING_CERT,
    serverSslCert: cert,
    serverSslPrivateKey: key,
    listenAcceptRole: 'raw-skt',
    listenAcceptProtocol: 'http-proxy',
    protocols: [createHttpProxyListener(listenerOpts)],
  });

  console.log(`HTTP proxy listening on http://localhost:${config.proxyPort}  (CONNECT + plain forwarding, plain or TLS)`);
  listening++;
}

if(config.socksPort) {
  createServer({
    port: config.socksPort,
    options: LWS_SERVER_OPTION_ONLY_RAW | LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG,
    listenAcceptRole: 'raw-skt',
    listenAcceptProtocol: 'socks',
    protocols: [createSocksListener(listenerOpts)],
  });

  console.log(`SOCKS4/5 listening on socks://localhost:${config.socksPort}`);
  listening++;
}

if(!listening) {
  console.error('proxy: nothing to do - both proxyPort and socksPort are 0/disabled.');
  std.exit(1);
}

console.log(`onward mode: ${config.onward.mode}` + (config.onward.host ? ` -> ${config.onward.host}:${config.onward.port}` : ''));
