/**
 * Demonstrates fetch()'s reused-connection (keep-alive) behaviour with a
 * tiny same-host crawler:
 *
 *   1. GET an HTML file.
 *   2. Scan it with RegExp for URLs: <a href>, <img src>, <script src>,
 *      <link href> (stylesheets), CSS url(...) (from <style> blocks), and
 *      bare http(s):// URLs anywhere in the markup.
 *   3. Queue same-origin links and fetch them too; foreign-origin links
 *      are only reported, never fetched.
 *   4. Report how many distinct TCP connections the whole crawl actually
 *      used - ideally exactly one, since every fetch() call after the
 *      first should reuse the connection via LCCSCF_PIPELINE.
 *
 * Serves its own tiny fixture site (LWSMPRO_FILE mount) so the crawl is
 * deterministic and needs no network access.
 */
import { fetch } from '../lib/fetch.js';
import { toString, createServer, logLevel, LWSMPRO_FILE, LLL_USER, LLL_DEBUG, LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG } from 'lws';
import { mkdir } from 'os';
import * as std from 'std';

logLevel(LLL_USER | LLL_DEBUG);

/*
 * Minimal http(s)-only URL resolution, used instead of the 'url' module's
 * URL class: that module's new URL(href, base) incorrectly treats an
 * already-absolute href as relative to base (e.g. resolving
 * "http://host/x" against a base yields "http://host/http:/host/x").
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

const PORT = 8919;
const ROOT = '/tmp/test-fetch-fixture';

const FIXTURE = {
  'index.html': `<html><body>
    <a href="/page2.html">page2</a>
    <a href="http://127.0.0.1:${PORT}/page3.html">page3 (absolute, same host)</a>
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

function serveFixture() {
  createServer({
    port: PORT,
    vhostName: 'localhost',
    options: LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG,
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

async function main(url) {
  writeFixture();
  serveFixture();

  const startUrl = url ?? `http://127.0.0.1:${PORT}/index.html`;
  const startOrigin = originOf(startUrl);

  console.log('url', startUrl);

  const visited = new Set();
  const queue = [startUrl];
  const foreign = new Set();
  const connections = []; // { url, fd } for every fetch, in order

  while(queue.length) {
    const url = queue.shift();
    if(visited.has(url)) continue;
    visited.add(url);

    const resp = await fetch(url, {
      keepAlive: true,
      pwsi(wsi) {
        connections.push({ url, fd: wsi.network?.fd, isPipelineLeader: wsi.isPipelineLeader, queuedBehind: wsi.pipelineLeader?.network?.fd });
      },
    });

    const contentType = resp.headers.get('content-type') ?? '';
    const isText = /html|css|javascript|text/.test(contentType);

    let body = '';
    if(isText) for await(const chunk of resp.body) body += toString(chunk.buffer);
    else for await(const chunk of resp.body); // drain non-text bodies

    console.log(`fetched ${url} -> ${resp.status} (${contentType || 'unknown type'}, ${body.length} bytes)`);

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

  console.log('\n--- crawl summary ---');
  console.log('same-host pages/assets fetched:', visited.size, [...visited]);
  console.log('foreign links (reported, not fetched):', foreign.size, [...foreign]);

  const distinctFds = new Set(connections.map(c => c.fd));

  console.log('\n--- connection reuse ---');
  for(const c of connections) console.log(' ', c.url, '-> fd', c.fd, c.queuedBehind !== undefined ? `(queued behind fd ${c.queuedBehind})` : '(own connection)');

  console.log(
    `\n${connections.length} fetches used ${distinctFds.size} distinct TCP connection(s)` + (distinctFds.size === 1 ? ' - fully reused, as intended.' : ' - reuse did not happen for all requests.'),
  );
}

main(...scriptArgs.slice(1))
  .catch(e => console.log('CRAWL ERROR', e, e?.stack))
  .then(() => std.exit(0)); // the fixture server + shared fetch() context would otherwise keep the process alive
