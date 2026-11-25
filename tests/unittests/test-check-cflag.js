/**
 * cmake/Checks.cmake check_cflag() must give every flag its own probe
 * result: with one shared result variable every probe after the first
 * returned the first answer without running, so a rejected first flag made
 * -O0 and -g look unsupported.
 *
 * Also guards cmake/BuildLibwebsockets.cmake: each -D option put into
 * LIBWEBSOCKETS_ARGS needs a type (-DNAME:TYPE=value), an untyped one such
 * as -DTERMUX=TRUE is ignored by ExternalProject ("does not match regex").
 */
import { popen, loadFile } from 'std';
import * as os from 'os';
import { tests, assert, eq, skip } from './tinytest.js';

const root = import.meta.url.replace(/^file:\/\//, '').replace(/tests\/unittests\/[^\/]*$/, '');

function configure() {
  const bdir = `/tmp/qjs-lws-check-cflag-${os.getpid ? os.getpid() : 0}`;
  const cmd = `cmake -S '${root}tests/unittests/fixtures/check-cflag' -B '${bdir}' -DCHECKS_DIR='${root}cmake' 2>&1; rm -rf '${bdir}'`;
  const f = popen(cmd, 'r');
  const out = f.readAsString();
  f.close();
  const probes = {};
  for(const m of out.matchAll(/PROBE (\S+) ?(\S*)/g)) probes[m[1]] = m[2];
  if(!Object.keys(probes).length) skip('cmake is not usable: ' + out.trim().slice(0, 200));
  return probes;
}

tests({
  'every flag is probed on its own'() {
    const p = configure();
    eq('', p['-fnonexistent-flag-for-test'], 'a flag the compiler rejects');
    assert(p['-O0'], '-O0 after a rejected flag');
    assert(p['-g'], '-g after a rejected flag');
  },

  'libwebsockets -D options are typed'() {
    const text = loadFile(`${root}cmake/BuildLibwebsockets.cmake`);
    const untyped = [];
    for(const m of text.matchAll(/"\$\{LIBWEBSOCKETS_ARGS\}([^"]*)"/g))
      for(const o of m[1].matchAll(/-D([A-Za-z0-9_]+)(:[A-Z]+)?=/g)) if(!o[2]) untyped.push(o[1]);
    assert(untyped.length == 0, `untyped options: ${untyped}`);
  },
});
