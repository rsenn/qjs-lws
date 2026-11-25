/**
 * A kept-alive connection that the server closes just as the next request
 * goes out on it fails that request with "dropped" before any response byte;
 * fetch() must retry it once on a fresh connection, like it does for
 * "closed before responding".
 */
import { exit } from 'std';
import * as os from 'os';
import { tests, assertEquals, skip } from './tinytest.js';
import { fetch } from '../../lib/fetch.js';
import { freePort } from './subprocess-utils.js';

const dir = import.meta.url.replace(/^file:\/\//, '').replace(/[^\/]*$/, '');
const port = freePort();
const pid = os.exec(['python3', `${dir}fixtures/drop-second-request-server.py`, String(port)], { block: false });

try {
  await tests({
    async 'request dropped on a reused connection is retried'() {
      if(pid < 0) skip('python3 is not available');
      await new Promise(r => os.setTimeout(r, 500));

      const url = `http://127.0.0.1:${port}/`;
      for(let i = 0; i < 3; i++) {
        const res = await fetch(url, { method: 'POST', body: 'x', h2: false });
        assertEquals('ok', await res.text(), `request ${i}`);
      }
    },
  });
} finally {
  if(pid > 0) {
    os.kill(pid, os.SIGTERM);
    os.waitpid(pid, 0);
  }
}

exit(0);
