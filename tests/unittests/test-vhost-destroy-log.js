/**
 * Destroying a vhost that never bound a listener to one interface (no
 * `iface`, the common case) must not log "not on no_listener list": the
 * vhost was never on that list, which is no error.
 */
import { popen } from 'std';
import * as os from 'os';
import { tests, assert } from './tinytest.js';

const dir = import.meta.url.replace(/^file:\/\//, '').replace(/[^\/]*$/, '');
const [self] = os.readlink('/proc/self/exe'); /* the interpreter running this test */

tests({
  'destroying a vhost logs no no_listener error'() {
    const f = popen(`'${self || 'qjsm'}' '${dir}fixtures/vhost-destroy.js' 2>&1`, 'r');
    const out = f.readAsString();

    f.close();
    assert(!/no_listener/.test(out), `unexpected log: ${out.trim().slice(0, 300)}`);
  },
});
