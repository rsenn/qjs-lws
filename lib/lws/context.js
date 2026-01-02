import { existsSync, readFileSync } from 'fs';
import { CONTEXT_PORT_NO_LISTEN, getLogLevelColour, getLogLevelName, LLL_ERR, LLL_USER, LLL_WARN, logLevel, LWS_SERVER_OPTION_ADOPT_APPLY_LISTEN_ACCEPT_CONFIG, LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT, LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX, LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT, LWS_SERVER_OPTION_IGNORE_MISSING_CERT, LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED, LWSContext, } from 'lws';

const { DEBUG, HOSTNAME } = process.env;

logLevel((DEBUG ? LLL_USER : 0) | LLL_ERR | LLL_WARN, (level, msg) =>
  console.log('\x1b[2K\r\x1b[0;30m' + getLogLevelColour(level).replace(/\b38\b/g, '48') + centerPad(8, getLogLevelName(level)) + '\x1b[0m ' + msg),
);

const resolvConf = '/etc/resolv.conf';

/**
 * Creates an \class LWSContext.
 *
 * @param  {object} info  struct lws_context_creation_info
 * @return {object}       LWSContext object
 */
export function createContext(info = {}) {
  info.options ??= 0;
  info.port ??= CONTEXT_PORT_NO_LISTEN;
  info.vhostName ??= HOSTNAME ?? readFileSync('/etc/hostname', 'utf-8')?.trimEnd();

  if(empty(info.asyncDnsServers) && existsSync(resolvConf)) info.asyncDnsServers = [...readFileSync(resolvConf, 'utf-8').matchAll(/nameserver\s+([\w\d.]+)/g)].map(m => m[1]);

  if(empty(info.asyncDnsServers)) info.asyncDnsServers = ['8.8.8.8', '8.8.4.4', '4.2.2.1'];

  /** @see: https://bun.com/docs/api/fetch#tls */
  if('tls' in info) {
    const { tls } = info;

    info.options |=
      LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT |
      LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX |
      LWS_SERVER_OPTION_IGNORE_MISSING_CERT |
      LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED |
      LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT |
      ('rejectUnauthorized' in tls && !tls.rejectUnauthorized ? LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED : 0);

    info.sslCa = info.clientSslCa = tls.ca;
    info.sslCert = info.clientSslCert = tls.cert;
    info.sslPrivateKey = info.clientSslPrivateKey = tls.key;
  }

  // info.options |= LWS_SERVER_OPTION_ADOPT_APPLY_LISTEN_ACCEPT_CONFIG;

  //console.log('info', info);

  return new LWSContext(info);
}

/**
 * Is not an array or array is empty.
 *
 * @param  {object} obj  Array object
 * @return {boolean}     false if Array contains elements
 */
function empty(obj) {
  return !Array.isArray(obj) || obj?.length == 0;
}

/**
 * Center a string by padding.
 *
 * @param  {number} len  Resulting string length
 * @param  {string} str  The string
 * @param  {string} ch   The padding character
 * @return {string}      Padded string
 */
function centerPad(len, str, ch = ' ') {
  len = Math.max(0, len - str.length);
  const start = ch.repeat(Math.floor(len / 2));
  return start + str + ch.repeat(len - start.length);
}

export default createContext;
