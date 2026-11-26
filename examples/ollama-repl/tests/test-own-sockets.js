/* test-own-sockets.js: joinLws() matches ss entries to lws sockets by local+peer */
import { joinLws } from '../lib/project/resources.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-own-sockets: ${what}`);
};

const lws = [
  { id: 1, protocol: 'http', buffered: 7, local: '127.0.0.1:40000', peer: '127.0.0.1:11434' },
  { id: 2, protocol: 'raw', buffered: 0, local: '10.0.0.2:50000', peer: '1.2.3.4:443' },
];

const entries = [
  { kind: 'tcp', state: 'ESTAB', local: '127.0.0.1:40000', peer: '127.0.0.1:11434', sent: 5, received: 9 },
  { kind: 'tcp', state: 'ESTAB', local: '[::ffff:10.0.0.2]:50000', peer: '[::ffff:1.2.3.4]:443', sent: 1, received: 2 },
  { kind: 'unix', state: 'ESTAB', local: 'x', peer: 'y' },
];

joinLws(entries, lws);
check('ss entry gains its lws socket', entries[0].lws.id === 1 && entries[0].lws.buffered === 7 && entries[0].sent === 5);
check('v4-mapped IPv6 column matches the plain IPv4 address', entries[1].lws.id === 2);
check('unix entries are left alone', !('lws' in entries[2]) && entries.length === 3);

const extra = joinLws([], lws);
check('lws sockets ss did not list are added as ESTAB with zero counters', extra.length === 2 && extra[0].state === 'ESTAB' && extra[0].sent === 0 && extra[0].lws.id === 1);
console.log('test-own-sockets: ok');
