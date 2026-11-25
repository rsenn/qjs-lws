/**
 * tinytest's tests() must make the process exit 1 when a case fails (ctest
 * judges a test by its exit status), and 0 when all pass.
 */
import { exec, remove } from 'os';
import { open } from 'std';
import * as os from 'os';
import { tests, assert, eq } from './tinytest.js';

const dir = import.meta.url.replace(/^file:\/\//, '').replace(/[^\/]*$/, '');
let n = 0;
const [self] = os.readlink('/proc/self/exe'); /* the interpreter running this test */

function run(body) {
  const file = `${dir}fixtures/tinytest-exit-${os.getpid ? os.getpid() : 0}-${n++}.js`;
  const f = open(file, 'w');
  f.puts(`import { tests, assert } from '../tinytest.js';\ntests({ 'case'() { ${body} } });\n`);
  f.close();
  try {
    return exec([self || 'qjsm', file], { block: true, stdout: os.open('/dev/null', os.O_WRONLY), stderr: os.open('/dev/null', os.O_WRONLY) });
  } finally {
    remove(file);
  }
}

tests({
  'exits 1 when a case fails'() {
    eq(1, run('assert(false, "boom");'));
  },

  'exits 0 when all cases pass'() {
    eq(0, run('assert(true, "fine");'));
  },
});
