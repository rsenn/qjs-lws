/**
 * A response whose header block is bigger than lws's default 4096 byte
 * header buffer must still be parsed (fetch() asks for 16 KB).
 */
import { exit } from 'std';
import { assertEquals } from './tinytest.js';
import { serve, Response } from '../../lib/serve.js';
import { fetch } from '../../lib/fetch.js';

const server = serve({ port: 0, hostname: '127.0.0.1' }, () => new Response('ok', { headers: Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`x-header-${i}`, 'v'.repeat(100)])) }));
const res = await fetch(`http://127.0.0.1:${server.port}/`, { h2: false, keepAlive: false });

assertEquals('ok', await res.text(), 'body');
assertEquals(100, res.headers.get('x-header-69').length, 'last of 70 headers');
console.log('1 tests succeeded.');
server.stop();
exit(0);
