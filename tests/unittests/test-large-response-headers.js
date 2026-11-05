/**
 * A response whose header block is bigger than lws's default 4096 byte
 * header buffer must still be parsed (fetch() asks for 16 KB).
 */
import { exit } from 'std';
import { assertEquals } from './tinytest.js';
import { serve, Response } from '../../lib/serve.js';
import { fetch } from '../../lib/fetch.js';

const server = serve({ port: 0, hostname: '127.0.0.1' }, () => new Response('ok', { headers: { 'x-big-1': 'a'.repeat(3000), 'x-big-2': 'b'.repeat(3000), 'x-big-3': 'c'.repeat(2000) } }));
const res = await fetch(`http://127.0.0.1:${server.port}/`, { h2: false, keepAlive: false });

assertEquals('ok', await res.text(), 'body');
assertEquals(2000, res.headers.get('x-big-3').length, 'last big header');
console.log('1 tests succeeded.');
server.stop();
exit(0);
