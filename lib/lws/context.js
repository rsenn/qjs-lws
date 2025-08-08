import { LWSContext } from 'lws';
import { existsSync, readFileSync } from 'lws';

const resolvConf = '/etc/resolv.conf';

export function createContext(info = {}) {
  info.port ??= 8000;
  info.vhostName ??= process.env['HOSTNAME'] ?? readFileSync('/etc/hostname', 'utf-8').trimEnd();

  if(empty(info.asyncDnsServers) && existsSync(resolvConf)) {
    info.asyncDnsServers = [...readFileSync(resolvConf, 'utf-8').matchAll(/nameserver\s+([\w\d.]+)/g)].map(m => m[1]);

    if(empty(info.asyncDnsServers)) info.asyncDnsServers = ['8.8.8.8', '8.8.4.4', '4.2.2.1'];
  }

  return new LWSContext(info);
}

function empty(obj) {
  return !Array.isArray(obj) || obj?.length == 0;
}

export default createContext;
