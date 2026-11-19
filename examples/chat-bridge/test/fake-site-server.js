/* Serves test/fake-site.html. Usage: qjsm fake-site-server.js PORT DIR */
import { createServer, LWSMPRO_FILE } from 'lws.so';

const [port, dir] = [+scriptArgs[1], scriptArgs[2]];

createServer({
  port,
  mounts: [{ mountpoint: '/', origin: dir, def: 'fake-site.html', originProtocol: LWSMPRO_FILE, protocol: 'http' }],
  protocols: [{ name: 'http' }],
});

console.log(`fake-site: http://localhost:${port}/`);
