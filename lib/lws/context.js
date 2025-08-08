import { LLL_USER, LWSContext, logLevel, getLogLevelName, getLogLevelColour } from 'lws';
import { existsSync, readFileSync } from 'fs';

const { DEBUG, HOSTNAME } = process.env;

logLevel(DEBUG ? LLL_USER : 0, (level, msg) => console.log('\x1b[0;30m' + getLogLevelColour(level).replace(/\b38\b/g, '48') + centerPad(8, getLogLevelName(level)) + '\x1b[0m ' + msg));

const resolvConf = '/etc/resolv.conf';

/**
 * Creates an \class LWSContext.
 * 
 * @param  {object} info  struct lws_context_creation_info
 * @return {object}       LWSContext object
 */
export function createContext(info = {}) {
  info.port ??= 8000;
  info.vhostName ??= HOSTNAME ?? readFileSync('/etc/hostname', 'utf-8').trimEnd();

  if(empty(info.asyncDnsServers) && existsSync(resolvConf)) {
    info.asyncDnsServers = [...readFileSync(resolvConf, 'utf-8').matchAll(/nameserver\s+([\w\d.]+)/g)].map(m => m[1]);

    if(empty(info.asyncDnsServers)) info.asyncDnsServers = ['8.8.8.8', '8.8.4.4', '4.2.2.1'];
  }

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
