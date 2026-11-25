/**
 * BuildQuickJS.cmake's quickjs_configure_args() must forward
 * CMAKE_SYSTEM_NAME and CMAKE_SYSROOT to the nested quickjs configure only
 * when the project itself cross compiles: forwarded on a native build (Termux
 * reports the system name Android) they make CMake treat it as a cross
 * build and quickjs then needs a host qjsc on PATH.
 */
import { popen } from 'std';
import { tests, assert, skip } from './tinytest.js';

const root = import.meta.url.replace(/^file:\/\//, '').replace(/tests\/unittests\/[^\/]*$/, '');

function configureArgs(...defs) {
  const cmd = ['cmake', `-DBUILDQUICKJS_CMAKE=${root}cmake/BuildQuickJS.cmake`, ...defs, '-P', `${root}tests/unittests/fixtures/quickjs-configure-args.cmake`].map(a => `'${a}'`).join(' ');
  const f = popen(cmd + ' 2>&1', 'r');
  const out = f.readAsString();
  f.close();
  const m = /ARGS=(.*)/.exec(out);
  if(!m) skip('cmake is not usable: ' + out.trim());
  return m[1].split(';');
}

tests({
  'native build does not forward the system name'() {
    const args = configureArgs('-DCMAKE_SYSTEM_NAME=Android', '-DCMAKE_SYSROOT=/sysroot');
    assert(!args.some(a => /^-DCMAKE_SYSTEM_NAME=/.test(a)), `CMAKE_SYSTEM_NAME forwarded: ${args}`);
    assert(!args.some(a => /^-DCMAKE_SYSROOT=/.test(a)), `CMAKE_SYSROOT forwarded: ${args}`);
  },

  'cross build forwards system name and sysroot'() {
    const args = configureArgs('-DCMAKE_CROSSCOMPILING=TRUE', '-DCMAKE_SYSTEM_NAME=Android', '-DCMAKE_SYSROOT=/sysroot');
    assert(args.includes('-DCMAKE_SYSTEM_NAME=Android'), `CMAKE_SYSTEM_NAME missing: ${args}`);
    assert(args.includes('-DCMAKE_SYSROOT=/sysroot'), `CMAKE_SYSROOT missing: ${args}`);
  },

  'compiler is forwarded either way'() {
    const args = configureArgs('-DCMAKE_C_COMPILER=/usr/bin/cc');
    assert(args.includes('-DCMAKE_C_COMPILER=/usr/bin/cc'), `CMAKE_C_COMPILER missing: ${args}`);
  },
});
