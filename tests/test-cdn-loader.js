/**
 * Demo/matrix script (not a unit test) for lib/cdn-loader.js: installs the
 * CDN moduleLoader() hook, then imports `preact` and
 * `preact-render-to-string` from each of several CDNs, over both http and
 * https where a CDN actually answers on plain http, and renders a small
 * vnode tree to an HTML string with each - printing a PASS/FAIL matrix at
 * the end.
 *
 * Real network access required (each CDN is a real public host); run with:
 *   qjsm tests/test-cdn-loader.js
 */
import installCdnLoader from '../lib/cdn-loader.js';
import { logLevel } from 'lws.so';
import * as std from 'std';

await installCdnLoader();

/* Silences the lws-level ERR chatter each fetchSync() context teardown logs
   (see BUGS: context-destroy-logs-not-on-no-listener-list) so it doesn't
   drown out the matrix below - real failures still show up as [FAIL] rows
   with their error message. */
logLevel(0, () => {});

/* `httpToo: true` means this CDN's http:// origin was confirmed (via `curl -D
   -`) to redirect to https:// rather than refusing the connection outright -
   exercising cdn-loader.js's http -> https redirect handling
   (lib/lws/protocols.js's onClientHttpRedirect), not a plain-http response. */
const CDNS = [
  {
    name: 'unpkg',
    httpToo: true,
    preact: origin => `${origin}/preact?module`,
    renderToString: origin => `${origin}/preact-render-to-string?module`,
  },
  {
    name: 'jsdelivr',
    httpToo: true,
    preact: origin => `${origin}/npm/preact/+esm`,
    renderToString: origin => `${origin}/npm/preact-render-to-string/+esm`,
  },
  {
    name: 'esm.sh',
    httpToo: true,
    preact: origin => `${origin}/preact`,
    renderToString: origin => `${origin}/preact-render-to-string`,
  },
];

const HOSTS = {
  unpkg: 'unpkg.com',
  jsdelivr: 'cdn.jsdelivr.net',
  'esm.sh': 'esm.sh',
};

const EXPECTED = '<div id="x">hello world</div>';

async function renderOnce(cdn, protocol) {
  const origin = `${protocol}://${HOSTS[cdn.name]}`;

  const preact = await import(cdn.preact(origin));
  const { render } = await import(cdn.renderToString(origin));

  const vnode = preact.h('div', { id: 'x' }, 'hello world');
  return render(vnode);
}

const results = [];

for(const cdn of CDNS) {
  const protocols = cdn.httpToo ? ['https', 'http'] : ['https'];

  for(const protocol of protocols) {
    const label = `${cdn.name} (${protocol})`;
    const start = Date.now();

    try {
      const html = await renderOnce(cdn, protocol);
      const ok = html === EXPECTED;

      results.push({ label, ok, ms: Date.now() - start, detail: ok ? html : `got: ${html}` });
    } catch(e) {
      results.push({ label, ok: false, ms: Date.now() - start, detail: e.message });
    }
  }
}

console.log('\nCDN loader matrix (preact + preact-render-to-string):\n');

let failures = 0;

for(const { label, ok, ms, detail } of results) {
  if(!ok) failures++;

  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label.padEnd(16)} ${String(ms).padStart(5)}ms  ${ok ? '' : detail}`);
}

console.log(`\n${results.length - failures}/${results.length} passed`);

if(failures > 0) std.exit(1);
