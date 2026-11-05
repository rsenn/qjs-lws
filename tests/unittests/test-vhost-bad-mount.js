/**
 * A callback mount (originProtocol 6, LWSMPRO_CALLBACK) that names a protocol
 * which is not in the protocols list must make the vhost creation fail, not
 * silently create a mount that never answers.
 */
import { exit } from 'std';
import { assert } from './tinytest.js';
import { serve, Response } from '../../lib/serve.js';

let message;

try {
  serve({ port: 0, hostname: '127.0.0.1', mounts: [{ mountpoint: '/x', protocol: 'nope', originProtocol: 6 }], fetch: () => new Response('x') });
} catch(e) {
  message = e.message;
}

assert(message && /protocol 'nope'/.test(message), `expected an error naming the protocol, got: ${message}`);
console.log('1 tests succeeded.');
exit(0);
