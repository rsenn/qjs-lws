/**
 * Exercises fetch() across all 4 combinations of {HTTP/1.1, H2} x {plain,
 * TLS}, each against its own fixture server - one crawl per combination,
 * one server lifecycle per combination (started, used, destroyed, in
 * sequence - never more than one live at a time). TLS combinations use a
 * freshly generated self-signed certificate (lib/lws/tls.js) for both
 * sides: the server presents it, the client trusts that exact cert via
 * `tls.ca` rather than disabling verification - no dependency on
 * checked-in cert files or the system CA bundle.
 *
 * Each combination crawls its own tiny fixture site (LWSMPRO_FILE mount)
 * with a same-host link-following crawler - deterministic, no network
 * access required - and asserts the whole site was actually reached.
 */
import { fetch } from '../lib/fetch.js';
import createContext from '../lib/lws/context.js';
import { generateSelfSignedCert } from '../lib/lws/tls.js';
import { toString, logLevel, LWSMPRO_FILE, LLL_USER, LWS_SERVER_OPTION_H2_PRIOR_KNOWLEDGE } from 'lws';
import { mkdir } from 'os';
import * as std from 'std';

logLevel(LLL_USER);

/*
 * Minimal http(s)-only URL resolution
 * Only what the crawl below actually needs: recognizing an absolute
 * http(s) URL, resolving a root/relative path against a base, and
 * extracting an origin for same-host comparison.
 */
const ABSOLUTE_SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

function resolveUrl(link, base) {
  const m = ABSOLUTE_SCHEME_RE.exec(link);

  if(m) {
    if(!/^https?:\/\//i.test(link)) throw new Error(`unsupported scheme: ${m[1]}`);
    return link;
  }

  const baseMatch = /^(https?:\/\/[^/]+)(\/[^?#]*)?/i.exec(base);
  if(!baseMatch) throw new Error(`invalid base URL: ${base}`);

  const origin = baseMatch[1];

  if(link.startsWith('//')) return origin.slice(0, origin.indexOf('://')) + ':' + link;
  if(link.startsWith('/')) return origin + link;

  const basePath = baseMatch[2] || '/';
  const dir = basePath.slice(0, basePath.lastIndexOf('/') + 1) || '/';
  return origin + dir + link;
}

function originOf(url) {
  const m = /^(https?:\/\/[^/]+)/i.exec(url);
  if(!m) throw new Error(`invalid URL: ${url}`);
  return m[1];
}

function assert(cond, message) {
  if(!cond) throw new Error('assertion failed: ' + message);
}

const ROOT = '/tmp/test-fetch-fixture';

const FIXTURE = {
  'index.html': `<html><body>
    <a href="/page2.html">page2</a>
    <a href="/page3.html">page3 (absolute, same host)</a>
    <a href="https://example.com/">external</a>
    <img src="/img/logo.png">
    <script src="/js/app.js"></script>
    <link rel="stylesheet" href="/css/style.css">
    <style>body { background: url(/img/bg.png); }</style>
  </body></html>`,
  'page2.html': `<html><body><a href="/index.html">back to index</a></body></html>`,
  'page3.html': `<html><body>leaf page, no further links</body></html>`,
  'img/logo.png': 'not a real png, just bytes',
  'img/bg.png': 'not a real png either',
  'js/app.js': 'console.log("fixture script");',
  'css/style.css': 'body { color: red; }',
};

function writeFixture() {
  mkdir(ROOT);
  mkdir(`${ROOT}/img`);
  mkdir(`${ROOT}/js`);
  mkdir(`${ROOT}/css`);

  for(const [name, content] of Object.entries(FIXTURE)) {
    const f = std.open(`${ROOT}/${name}`, 'w+');
    f.puts(content);
    f.close();
  }
}

/**
 * Starts a single fixture server for one combination; caller destroy()s it
 * when done. `h2c`, only meaningful without `tls`, opts the vhost into
 * accepting an h2 client preface directly over plain TCP
 * (LWS_SERVER_OPTION_H2_PRIOR_KNOWLEDGE) - without it, a prior-knowledge h2
 * connection attempt just gets dropped, since ALPN (TLS's usual way of
 * negotiating h2) doesn't exist to negotiate it over plain TCP.
 */
function serveFixture(port, tls, h2c) {
  return createContext({
    port,
    vhostName: 'localhost',
    ...(tls ? { tls } : {}),
    ...(h2c ? { options: LWS_SERVER_OPTION_H2_PRIOR_KNOWLEDGE } : {}),
    mounts: [{ mountpoint: '/', origin: ROOT, def: 'index.html', originProtocol: LWSMPRO_FILE }],
    protocols: [{ name: 'http' }],
  });
}

const LINK_RE = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;
const IMG_RE = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
const SCRIPT_RE = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
const STYLESHEET_RE = /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;
const CSS_URL_RE = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
const ABSOLUTE_URL_RE = /https?:\/\/[^\s"'<>()]+/gi;

function extractUrls(html) {
  const found = new Set();

  for(const re of [LINK_RE, IMG_RE, SCRIPT_RE, STYLESHEET_RE, CSS_URL_RE]) {
    re.lastIndex = 0;
    let m;
    while((m = re.exec(html))) found.add(m[1]);
  }

  ABSOLUTE_URL_RE.lastIndex = 0;
  let m;
  while((m = ABSOLUTE_URL_RE.exec(html))) found.add(m[0]);

  return found;
}

/** Crawls `startUrl` same-host, fetching every page/asset it can reach. Returns a summary for the caller to assert on. */
async function crawl(startUrl, fetchOptions) {
  const startOrigin = originOf(startUrl);
  const visited = new Set();
  const queue = [startUrl];
  const foreign = new Set();
  const connections = []; // { url, fd, h2, tls } for every fetch, in order

  while(queue.length) {
    const url = queue.shift();
    if(visited.has(url)) continue;
    visited.add(url);

    const resp = await fetch(url, {
      ...fetchOptions,
      pwsi(wsi) {
        connections.push({ url, fd: wsi.network?.fd, h2: wsi.h2, tls: !!wsi.tls });
      },
    });

    assert(resp.status === 200, `${url} -> status ${resp.status}`);

    const contentType = resp.headers.get('content-type') ?? '';
    const isText = /html|css|javascript|text/.test(contentType);

    let body = '';
    if(isText) for await(const chunk of resp.body) body += toString(chunk.buffer);
    else for await(const chunk of resp.body); // drain non-text bodies

    console.log(`  fetched ${url} -> ${resp.status} (${contentType || 'unknown type'}, ${body.length} bytes)`);

    if(!isText) continue;

    for(const link of extractUrls(body)) {
      let abs;
      try {
        abs = resolveUrl(link, url);
      } catch(e) {
        continue; // not a URL we can resolve (e.g. "javascript:...")
      }

      const linkOrigin = originOf(abs);

      if(linkOrigin !== startOrigin) {
        foreign.add(abs);
        continue;
      }

      if(!visited.has(abs) && !queue.includes(abs)) queue.push(abs);
    }
  }

  return { visited, foreign, connections };
}

/** Runs one {h2, tls} combination against its own, freshly started fixture server. */
async function runCombo(label, port, { h2, tls }) {
  console.log(`\n=== ${label} (port ${port}) ===`);

  const ctx = serveFixture(port, tls?.server, h2 && !tls);

  try {
    const scheme = tls ? 'https' : 'http';
    const startUrl = `${scheme}://127.0.0.1:${port}/index.html`;

    const { visited, foreign, connections } = await crawl(startUrl, { keepAlive: true, h2, tls: tls?.client });

    assert(visited.size === 7, `expected 7 same-host pages/assets, got ${visited.size}: ${[...visited]}`);
    assert(foreign.size === 1, `expected 1 foreign link, got ${foreign.size}: ${[...foreign]}`);

    for(const c of connections) {
      assert(c.tls === !!tls, `${c.url}: expected wsi.tls ${!!tls}, got ${c.tls}`);
      console.log(`  ${c.url} -> fd ${c.fd}, h2=${c.h2}, tls=${c.tls}`);
    }

    console.log(`${label}: OK (${connections.length} fetches, ${new Set(connections.map(c => c.fd)).size} distinct connection(s))`);
  } finally {
    ctx.destroy();
  }
}

async function main() {
  writeFixture();

  // Generated once, reused for both TLS combinations below - the server
  // presents it, the client trusts that exact cert as its CA (a
  // self-signed cert verifies fine against itself as a degenerate,
  // one-node trust chain) rather than disabling verification.
  const { cert, key } = generateSelfSignedCert({ commonName: 'localhost', altNames: ['localhost', '127.0.0.1'] });
  const tls = { server: { cert, key }, client: { ca: cert } };

  await runCombo('HTTP/1.1, plain', 8919, { h2: false, tls: null });
  await runCombo('HTTP/1.1, TLS', 8920, { h2: false, tls });
  await runCombo('H2, plain', 8921, { h2: true, tls: null });
  await runCombo('H2, TLS', 8922, { h2: true, tls });

  console.log('\nALL 4 COMBINATIONS PASSED');
}

main()
  .catch(e => {
    console.log('TEST FAILED:', e, e?.stack);
    std.exit(1);
  })
  .then(() => std.exit(0)); // the fixture server + shared fetch() context would otherwise keep the process alive
