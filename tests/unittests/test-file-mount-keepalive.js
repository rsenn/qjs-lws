/**
 * Several files served from an LWSMPRO_FILE mount over one kept-alive
 * connection. A protocol without an onHttpFileCompletion handler used to
 * leave the transaction uncompleted, so the second response's headers were
 * counted as its body and the file was never sent (header only, then the
 * connection was closed).
 */
import { exit } from 'std';
import { mkdir } from 'os';
import * as std from 'std';
import { tests, assertEquals } from './tinytest.js';
import createContext from '../../lib/lws/context.js';
import { fetch } from '../../lib/fetch.js';
import { LWSMPRO_FILE } from 'lws.so';
import { freePort } from './subprocess-utils.js';

const port = freePort();

const ROOT = '/tmp/qjs-lws-file-mount-keepalive';
const FILES = { 'a.txt': 'first file, a bit longer than the second', 'b.txt': 'second', 'c.txt': 'third one' };

mkdir(ROOT);
for(const [name, text] of Object.entries(FILES)) {
  const f = std.open(`${ROOT}/${name}`, 'w');

  f.puts(text);
  f.close();
}

const server = createContext({
  port,
  vhostName: 'localhost',
  iface: '127.0.0.1',
  mounts: [{ mountpoint: '/', origin: ROOT, originProtocol: LWSMPRO_FILE }],
  protocols: [{ name: 'http' }],
});

await tests({
  async 'every file arrives complete on a reused connection'() {
    for(const [name, text] of Object.entries(FILES)) {
      const r = await fetch(`http://127.0.0.1:${port}/${name}`, { h2: false });

      assertEquals(200, r.status, name);
      assertEquals(text, await r.text(), name);
    }
  },
});

server.destroy();
exit(0);
