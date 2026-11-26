/* test-proxy-probe.js: where Tor's control port is, from the proxy URL or TORHOST */
import { setenv } from 'std';
import { torHost, newnym, torCookie, exitAfterNewnym } from '../lib/gateway/proxy-probe.js';
import { writeConfigFile } from '../lib/config.js';

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

/* NEWNYM waits out what Tor says it still throttles */
{
  const sent = [];
  const slept = [];
  const tor = wait => async line => (sent.push(line), line.startsWith('GETINFO') ? { lines: [`newnym-wait=${wait}`] } : { lines: [] });
  const w = await newnym(tor(6), async ms => slept.push(ms));
  check('waits for the reported seconds, then signals', w === 6200 && slept[0] === 6200 && sent.join() === 'GETINFO newnym-wait,SIGNAL NEWNYM');
  sent.length = 0;
  slept.length = 0;
  check('no wait when none is due', (await newnym(tor(0), async ms => slept.push(ms))) === 0 && !slept.length && sent.length === 2);
  check('the wait is capped', (await newnym(tor(60), async ms => slept.push(ms), 12000)) === 12000);
  const noInfo = async line => { if(line.startsWith('GETINFO')) throw new Error('510 unrecognized'); return {}; };
  check('a Tor without the key is signalled at once', (await newnym(noInfo, async () => {})) === 0);
}

/* the exit address after NEWNYM: asked again until it changes */
{
  const answers = ['1.1.1.1', '1.1.1.1', '2.2.2.2'];
  const slept = [];
  const probe = async () => answers.shift();
  check('stops at the new address', (await exitAfterNewnym(probe, '1.1.1.1', { sleep: async ms => slept.push(ms) })) === '2.2.2.2' && slept.join() === '3000,4000,4000');
  check('the last answer when it never changes', (await exitAfterNewnym(async () => '1.1.1.1', '1.1.1.1', { tries: 3, sleep: async () => {} })) === '1.1.1.1');
  check('null when the proxy never answers', (await exitAfterNewnym(async () => null, '1.1.1.1', { tries: 2, sleep: async () => {} })) === null);
}

/* the control cookie of a local Tor */
{
  const dir = `/tmp/ollama-repl-test-cookie-${Date.now()}`;
  const hex = '1a2b3c4d5e6f7011'.repeat(4); /* bytes below 0x80: writeConfigFile writes text */
  const bytes = hex.match(/../g).map(h => String.fromCharCode(parseInt(h, 16))).join('');
  writeConfigFile(`${dir}/cookie`, bytes);
  check('no file, no cookie', (await torCookie([`${dir}/missing`])) === null);
  check('a 32 byte cookie as hex', (await torCookie([`${dir}/missing`, `${dir}/cookie`])) === hex);
}

console.log('test-proxy-probe: ok');
