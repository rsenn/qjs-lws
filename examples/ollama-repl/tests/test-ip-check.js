/* test-ip-check.js: reading an external address out of a "what is my IP" reply */
import { parseIp, isPublicIp } from '../lib/gateway/ip-check.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-ip-check: ${what}`);
};

check('plain', parseIp('185.220.101.4\n') === '185.220.101.4');
check('a page', parseIp('<html><body>Current IP Address: 203.0.113.7</body></html>') === '203.0.113.7');
check('private and loopback lines are skipped', parseIp('your lan: 192.168.1.20\nlo 127.0.0.1\nrouter 10.0.0.1\nlink 169.254.3.4\nvpn 172.20.0.9\nyou: 198.51.100.23') === '198.51.100.23');
check('octets over 255 are no address', parseIp('999.1.1.1 and 1.2.3.456') === null);
check('a version number is not an address', parseIp('app 1.2.3.4.5 build') === null);
check('nothing', parseIp('') === null && parseIp(null) === null && parseIp('no ip here') === null);
check('public', isPublicIp('8.8.8.8') && !isPublicIp('0.1.2.3') && !isPublicIp('172.31.1.1') && isPublicIp('172.32.1.1') && !isPublicIp('224.0.0.1'));
