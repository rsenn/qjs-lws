/**
 * Tests LWSSPA (lws-spa.c) via a real HTTP server/POST round trip:
 * numeric-index access (pre-existing), name-based access via
 * `param_names`/`paramNames`, the `.length` and `.paramNames` getters, and
 * that method/prototype access (`process`/`finalize`/`Symbol.toStringTag`)
 * keeps working alongside the string-keyed property lookup.
 *
 * `.length` counts the contiguous run of populated `param_names` slots
 * starting at index 0 (not `count_params`, the allocated capacity) -
 * with explicit `paramNames`, that's always `paramNames.length` (the
 * constructor fills them in order, no gaps); with none given, lws's own
 * "arbitrary POST items" dynamic-discovery mode (backed by the SPA's
 * `lwsac` allocator) fills slots in the order new field names are first
 * seen, so `.length` there reflects however many distinct fields have
 * actually shown up.
 */
import { tests, eq, assert, assertStrictEquals } from './tinytest.js';
import { createServer, LWSSPA, LWSMPRO_CALLBACK, LWS_WRITE_HTTP_FINAL } from 'lws';
import { fetch } from '../../lib/fetch.js';
import { freePort } from './subprocess-utils.js';
import * as std from 'std';

/**
 * Runs one urlencoded POST through a fresh LWSSPA built with `spaOptions`,
 * returning the (now-finalized) instance plus a `destroy()` to tear the
 * server down - callers must read whatever they need from `spa` *before*
 * calling `destroy()`: destroying the server context invalidates the
 * underlying connection (and with it the SPA's parsed-value storage), same
 * as any other per-connection LWSSocket state.
 */
async function parseForm(spaOptions, body) {
  const port = freePort();
  let spa;

  const server = createServer({
    port,
    vhostName: 'localhost',
    mounts: [{ mountpoint: '/', protocol: 'http', originProtocol: LWSMPRO_CALLBACK }],
    protocols: [
      {
        name: 'http',
        onFilterHttpConnection(wsi) {
          spa = new LWSSPA(wsi, spaOptions);
        },
        onHttpBody(wsi, buf) {
          spa.process(buf, 0, buf.byteLength);
        },
        onHttpBodyCompletion(wsi) {
          spa.finalize();

          wsi.wantWrite(() => {
            wsi.respond(200, { 'content-type': 'text/plain', 'content-length': '4' });
            wsi.write('done', LWS_WRITE_HTTP_FINAL);
            return -1;
          });
        },
      },
    ],
  });

  await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    keepAlive: false,
  });

  return { spa, destroy: () => server.destroy() };
}

await tests({
  async 'LWSSPA: numeric-index access retrieves a parsed form value'() {
    const { spa, destroy } = await parseForm({ paramNames: ['foo', 'baz'] }, 'foo=bar&baz=qux');

    eq('bar', spa[0]);
    eq('qux', spa[1]);

    destroy();
  },

  async 'LWSSPA: name-based access (paramNames) retrieves the same values by name'() {
    const { spa, destroy } = await parseForm({ paramNames: ['foo', 'baz'] }, 'foo=bar&baz=qux');

    eq('bar', spa.foo);
    eq('qux', spa.baz);
    assertStrictEquals(undefined, spa.nonexistent);

    destroy();
  },

  async 'LWSSPA: param_names (snake_case) works the same as paramNames'() {
    const { spa, destroy } = await parseForm({ param_names: ['foo'] }, 'foo=bar');

    eq('bar', spa.foo);
    eq('bar', spa[0]);

    destroy();
  },

  async "LWSSPA: length defaults to paramNames.length when count_params isn't given"() {
    const { spa, destroy } = await parseForm({ paramNames: ['a', 'b', 'c'] }, 'a=1');

    eq(3, spa.length);

    destroy();
  },

  async 'LWSSPA: with no paramNames given, fields are discovered dynamically and length reflects how many'() {
    const { spa, destroy } = await parseForm({}, 'a=1&b=2');

    eq(2, spa.length);
    eq('1', spa[0]);
    eq('2', spa[1]);

    destroy();
  },

  async 'LWSSPA: countParams larger than paramNames.length still allows every declared name to be captured'() {
    const { spa, destroy } = await parseForm({ paramNames: ['a', 'b'], countParams: 5 }, 'a=1&b=2');

    eq('1', spa.a);
    eq('2', spa.b);
    eq(2, spa.length); // only 2 of the 5 allocated slots ever got a name

    destroy();
  },

  async 'LWSSPA: paramNames getter returns the declared field names'() {
    const { spa, destroy } = await parseForm({ paramNames: ['a', 'b', 'c'] }, 'a=1');

    const names = spa.paramNames;
    eq(3, names.length);
    eq('a', names[0]);
    eq('b', names[1]);
    eq('c', names[2]);

    destroy();
  },

  async 'LWSSPA: method/prototype access still works alongside the new string-keyed lookup'() {
    const { spa, destroy } = await parseForm({ paramNames: ['foo'] }, 'foo=bar');

    assertStrictEquals('function', typeof spa.process);
    assertStrictEquals('function', typeof spa.finalize);
    eq('[object LWSSPA]', Object.prototype.toString.call(spa));

    destroy();
  },
});

// fetch() (lib/fetch.js) keeps a lazily-created LWSContext singleton alive
// for the life of the process (shared across calls by design) - unlike
// every other suite here, nothing in this file ever destroys it, so the
// event loop would otherwise never drain on its own.
std.exit(0);
