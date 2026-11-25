/**
 * cmake/BuildLibwebsockets.cmake: ExternalProject_Add() of the nested
 * libwebsockets build must set CMAKE_INSTALL_PREFIX itself.  Left out, CMake
 * 4.5 warns on every configure about policy CMP0225 and its new behaviour
 * would change the prefix of the nested build.
 */
import { loadFile } from 'std';
import { tests, assert } from './tinytest.js';

const root = import.meta.url.replace(/^file:\/\//, '').replace(/tests\/unittests\/[^\/]*$/, '');

tests({
  'every ExternalProject_Add of libwebsockets sets CMAKE_INSTALL_PREFIX'() {
    const text = loadFile(`${root}cmake/BuildLibwebsockets.cmake`);
    const calls = text.split(/ExternalProject_Add\(/).slice(1);

    assert(calls.length > 0, 'no ExternalProject_Add call found');
    for(const call of calls) {
      const body = call.slice(0, call.search(/\n  \)\n/));

      assert(/-DCMAKE_INSTALL_PREFIX:PATH=/.test(body), 'an ExternalProject_Add call has no -DCMAKE_INSTALL_PREFIX');
    }
  },
});
