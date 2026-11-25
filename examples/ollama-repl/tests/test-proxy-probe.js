/* test-proxy-probe.js: where Tor's control port is, from the proxy URL or TORHOST */
import { setenv } from 'std';
import { torHost } from '../lib/proxy-probe.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-proxy-probe: ${what}`);
};

setenv('TORHOST', '');
check('the host of the socks URL', torHost('socks5://192.168.178.52:9050') === '192.168.178.52');
check('socks5h with a name and credentials', torHost('socks5h://user:pw@tor.lan:9050') === 'tor.lan');
check('an IPv6 host without its brackets', torHost('socks5h://[::1]:9050') === '::1');
check('no port', torHost('socks5://proxy.example') === 'proxy.example');
check('no URL: the local machine', torHost('') === '127.0.0.1' && torHost(undefined) === '127.0.0.1' && torHost('not a url') === '127.0.0.1');
setenv('TORHOST', '10.0.0.7');
check('TORHOST wins', torHost('socks5://192.168.178.52:9050') === '10.0.0.7');
setenv('TORHOST', '');

console.log('test-proxy-probe: ok');
