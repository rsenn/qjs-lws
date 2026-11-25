/* creates a server on a vhost without `iface` and tears it down */
import { exit } from 'std';
import { setTimeout } from 'os';
import { serve, Response } from '../../../lib/serve.js';

const server = serve({ port: 0, hostname: '127.0.0.1' }, () => new Response('x'));

server.stop();
setTimeout(() => exit(0), 200);
