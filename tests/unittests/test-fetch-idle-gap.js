/**
 * Regression test for BUGS h1-late-queued-pipeline-never-promoted: a request
 * made on an HTTP/1.1 keep-alive connection after the first one finished and
 * the connection went idle must be sent (on the same connection while it is
 * kept warm, 5 s by default, else on a new one), never lost.
 */
import { exit } from 'std';
import * as os from 'os';
import { tests, assert, assertEquals, skip } from './tinytest.js';
import { fetch } from '../../lib/fetch.js';
import { freePort } from './subprocess-utils.js';

const dir = import.meta.url.replace(/^file:\/\//, '').replace(/[^\/]*$/, '');
const port = freePort();
const pid = os.exec(['python3', `${dir}fixtures/keepalive-server.py`, String(port)], { block: false });
const sleep = ms => new Promise(r => os.setTimeout(r, ms));
const url = `http://127.0.0.1:${port}/`;

async function post() {
  const res = await fetch(url, { method: 'POST', body: 'x', h2: false });

  return res.text();
}

try {
  await tests({
    async 'a request on an idle kept-alive connection is sent'() {
      if(pid < 0) skip('python3 is not available');
      await sleep(500);

      const first = await post();

      await sleep(300);
      assertEquals(first, await post(), 'the warm connection is reused');
      await sleep(6000);
      assert((await post()).length > 0, 'a request after the keep-warm time got no answer');
    },
  });
} finally {
  if(pid > 0) {
    os.kill(pid, os.SIGTERM);
    os.waitpid(pid, 0);
  }
}

exit(0);
