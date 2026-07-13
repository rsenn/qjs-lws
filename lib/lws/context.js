import { CONTEXT_PORT_NO_LISTEN, getLogLevelColour, getLogLevelName, LLL_ERR, LLL_USER, LLL_WARN, logLevel, LWS_SERVER_OPTION_ADOPT_APPLY_LISTEN_ACCEPT_CONFIG, LWSContext, } from 'lws.so';
import { tlsContextOptions } from './tls.js';
import { loadFile } from 'std';
import { stat } from 'os';

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
  info.vhostName ??= HOSTNAME ?? loadFile('/etc/hostname')?.trimEnd();

  if(empty(info.asyncDnsServers) && !stat(resolvConf)[1]) info.asyncDnsServers = [...loadFile(resolvConf).matchAll(/nameserver\s+([\w\d.]+)/g)].map(m => m[1]);

  if(empty(info.asyncDnsServers)) info.asyncDnsServers = ['8.8.8.8', '8.8.4.4', '4.2.2.1'];

  /** @see: https://bun.com/docs/api/fetch#tls */
  if('tls' in info) {
    const { options: tlsOptions = 0, ...rest } = tlsContextOptions(info.tls);

    info.options |= tlsOptions;
    Object.assign(info, rest);
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
