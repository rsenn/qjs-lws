/**
 * A realtime-controllable web crawler that yields pages as Markdown via an
 * async iterator - built for agentic use, where the caller inspects each
 * page and decides where to go next.
 *
 * Breadth-first traversal with configurable max depth, same-host filtering
 * (default on), per-page delay, and live control (pause/resume/stop/add)
 * between pages. Each page is fetched via `fetch()` (lib/fetch.js), its
 * HTML converted to Markdown via `html2md()` (lib/html2md.js),
 * and yielded as `{ url, title, markdown, links }`.
 *
 * Usage:
 *   const crawler = new Crawler({ maxDepth: 2, delay: 200 });
 *   crawler.start('https://example.com');
 *
 *   for await(const page of crawler) {
 *     console.log(`# ${page.title}\n${page.markdown}`);
 *     // optionally direct the crawl:
 *     if(page.links.some(l => l.includes('api'))) crawler.add(thatUrl);
 *     if(page.markdown.includes('STOP')) crawler.stop();
 *   }
 *
 * Or callback-driven:
 *   crawler.on('page', page => { ... });
 *   crawler.on('error', err => { ... });
 *   await crawler.start(urls);
 *
 * Realtime control methods (safe to call from an `on('page')` handler or
 * between `for await` iterations):
 *   .add(url|urls)  - enqueue new URLs (respects sameHost / allowList)
 *   .stop()         - abandon queue and in-flight fetches, end the iterator
 *   .pause()        - stop dequeuing new URLs (in-flight fetches finish)
 *   .resume()       - resume after pause
 *   .visited        - Set of all URLs already fetched or queued
 */
import { fetch } from '../../../lib/fetch.js';
import { generateSelfSignedCert } from '../../../lib/lws/tls.js';
import { html2md } from './html2md.js';
import { LLL_USER, LLL_INFO, LLL_NOTICE, logLevel, toString } from 'lws.so';
import { URL } from '../../../lib/lws/url.js';

const DEFAULT_USER_AGENT = 'qjs-crawler/1.0';

/** Strip <script> and <style> blocks from HTML before markdown conversion -
    they produce no useful markdown and can confuse the output. */
function stripNoise(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
}

/** Extract the <body> innerHTML from a full HTML document. Falls back to
    the raw input if no <body> tag is found (fragment or non-standard page). */
function extractBody(html) {
  const m = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  return m ? m[1] : html;
}

/** Extract the page title from the <head>, before <body> is stripped. */
function extractTitle(html) {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

/** Discover all hrefs in raw HTML and resolve them to absolute URLs against
    `baseUrl`. Returns an array of absolute URL strings. */
function discoverLinks(html, baseUrl) {
  const links = [];
  const re = /\bhref\s*=\s*["']([^"']+)["']/gi;
  let m;

  while((m = re.exec(html))) {
    const href = m[1];
    if(!/^https?:\/\//i.test(href)) continue;
    links.push(href.split('#')[0]);
  }

  return [...new Set(links)];
}

export class Crawler {
  #maxDepth;
  #sameHost;
  #allowList;
  #fetchOptions;
  #delay;
  #retries;
  #retryDelayMs;
  #retryJitterPercent;
  #followLinks;

  #queue = []; // [{ url, depth }]
  #visited = new Set();
  #pending = 0; // in-flight fetches
  #hosts = new Set(); // seed URL hosts for same-host filtering

  #stopped = false;
  #paused = false;

  // Async iterator plumbing: a FIFO of yielded pages, and a pending "done"
  // resolver that fires when the queue empties with no fetches in flight.
  #results = [];
  #waiters = []; // resolve fns from for-await consumers
  #done = null; // { resolve } - set when the crawl loop has ended
  #drain = null; // the crawl loop's current idle resolver

  #listeners = new Map();

  /**
   * @param {object} [opts]
   * @param {number} [opts.maxDepth=3]       BFS depth limit (0 = seed only)
   * @param {boolean} [opts.sameHost=true]   only follow links on seed hosts
   * @param {string[]} [opts.allowList]      host patterns to allow (overrides sameHost)
   * @param {number} [opts.delay=0]          ms between consecutive fetches
   * @param {number} [opts.timeoutSecs=120] per-page fetch timeout
   * @param {number} [opts.retries=3]       max retries per page (on 5xx/network errors)
   * @param {number} [opts.retryDelayMs=1000] initial retry delay (exponential backoff)
   * @param {number} [opts.retryJitterPercent=25] jitter percentage on retry delays
   * @param {string} [opts.userAgent]        User-Agent header
   * @param {boolean} [opts.h2=false]        enable HTTP/2 (default false to avoid lws WINDOW_UPDATE overflow bug)
   * @param {object} [opts.fetchOptions]     extra options passed to fetch()
   * @param {boolean|function} [opts.followLinks=true]
   *   `true`: auto-queue same-host links; `false`: no auto-follow (use
   *   .add() to direct the crawl); `function(links, page)`: caller picks
   *   which URLs to queue (return an array of URLs to follow)
   */
  constructor({
    maxDepth = 3,
    sameHost = true,
    allowList,
    delay = 0,
    timeoutSecs = 120,
    retries = 3,
    retryDelayMs = 1000,
    retryJitterPercent = 25,
    userAgent,
    h2 = false,
    fetchOptions,
    followLinks = true,
  } = {}) {
    this.#maxDepth = maxDepth;
    this.#sameHost = sameHost;
    this.#allowList = allowList;
    this.#delay = delay;
    this.#retries = retries;
    this.#retryDelayMs = retryDelayMs;
    this.#retryJitterPercent = retryJitterPercent;
    this.#followLinks = followLinks;
    this.#fetchOptions = { timeoutSecs, h2, ...fetchOptions };
    if(userAgent) this.#fetchOptions.userAgent = userAgent;

    /* Force HTTP/1.1 by default (h2: false) to avoid lws's HTTP/2
       WINDOW_UPDATE overflow bug: some servers send a WINDOW_UPDATE that
       overflows lws's 31-bit tx-credit max (0x10000 + 0x7fff0000 =
       0x80000000), causing lws to GOAWAY the connection. The
       LWS_SERVER_OPTION_H2_JUST_FIX_WINDOW_UPDATE_OVERFLOW flag meant to
       work around this actually breaks TLS connect() entirely, so we
       sidestep h2 instead. Pass h2: true if you know the server is safe. */

    /* Generate a self-signed cert and pass its CA to fetch() via `tls`,
       so the crawler can trust HTTPS servers presenting certs signed by
       this CA (local/internal servers with self-signed certs) - same
       pattern as tests/test-fetch.js. Only if the caller hasn't already
       provided a `tls` option in fetchOptions. */
    if(!this.#fetchOptions.tls) {
      const { cert } = generateSelfSignedCert({ commonName: 'crawler', altNames: ['localhost', '127.0.0.1'] });
      this.#fetchOptions.tls = { ca: cert };
    }
  }

  get visited() {
    return new Set(this.#visited);
  }
  get queued() {
    return this.#queue.length;
  }
  get pending() {
    return this.#pending;
  }
  get stopped() {
    return this.#stopped;
  }
  get paused() {
    return this.#paused;
  }

  on(event, fn) {
    if(!this.#listeners.has(event)) this.#listeners.set(event, []);
    this.#listeners.get(event).push(fn);
    return this;
  }

  off(event, fn) {
    const list = this.#listeners.get(event);
    if(!list) return this;
    const i = list.indexOf(fn);
    if(i !== -1) list.splice(i, 1);
    return this;
  }

  #emit(event, ...args) {
    for(const fn of this.#listeners.get(event) ?? []) fn(...args);
  }

  #isSameHost(url) {
    try {
      return this.#hosts.has(new URL(url).host);
    } catch {
      return false;
    }
  }

  #isAllowed(url) {
    if(this.#allowList) {
      const host = new URL(url).host;
      return this.#allowList.some(pattern => host === pattern || host.endsWith('.' + pattern));
    }
    return !this.#sameHost || this.#isSameHost(url);
  }

  #markVisited(url) {
    this.#visited.add(url);
  }

  #isDone() {
    return this.#queue.length === 0 && this.#pending === 0;
  }

  /** Enqueue one or more URLs for crawling. Respects sameHost / allowList
      and deduplicates against the visited set. Returns the count of URLs
      actually enqueued. Safe to call at any time - before start(), between
      pages, from an on('page') handler. */
  add(urlOrUrls) {
    const urls = Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls];
    let added = 0;

    for(const raw of urls) {
      const url = raw.split('#')[0];
      if(this.#visited.has(url)) continue;
      if(!/^https?:\/\//i.test(url)) continue;
      if(!this.#isAllowed(url)) continue;

      this.#markVisited(url);
      this.#queue.push({ url, depth: 0 });
      added++;
    }

    // If the crawl loop is idle-waiting on #drain, wake it.
    if(this.#drain) {
      this.#drain.resolve();
      this.#drain = null;
    }

    return added;
  }

  /** Permanently stop the crawl. In-flight fetches are abandoned (their
      results won't be yielded), the queue is cleared, and the async
      iterator ends. Idempotent. */
  stop() {
    this.#stopped = true;
    this.#queue = [];

    // Wake the crawl loop if it's idle-waiting.
    if(this.#drain) {
      this.#drain.resolve();
      this.#drain = null;
    }

    // Wake any for-await consumers blocked on #waiters.
    this.#flushWaiters();
  }

  /** Pause dequeuing. In-flight fetches still complete and yield results,
      but no new URLs are fetched until resume(). */
  pause() {
    this.#paused = true;
    this.#emit('pause');
  }

  /** Resume after pause(). */
  resume() {
    this.#paused = false;
    this.#emit('resume');

    if(this.#drain) {
      this.#drain.resolve();
      this.#drain = null;
    }
  }

  /** Push a page result into the consumer queue, waking any blocked
      for-await reader. */
  #pushResult(page) {
    if(this.#waiters.length > 0) {
      this.#waiters.shift()({ value: page, done: false });
    } else {
      this.#results.push(page);
    }
  }

  /** Resolve all blocked for-await consumers with `done: true`. */
  #flushWaiters() {
    for(const resolve of this.#waiters) resolve({ value: undefined, done: true });
    this.#waiters = [];
  }

  /** Fetch one page: GET, extract title, strip noise, convert to markdown,
      discover links. Retries on 5xx and network errors with exponential
      backoff + jitter (same shape as lws's own retry_bo_from_retryobj:
      a delay table with jitter). Returns a page object or null on failure. */
  async #fetchPage(url) {
    let lastError;

    for(let attempt = 0; attempt <= this.#retries; attempt++) {
      if(attempt > 0) {
        /* Exponential backoff: retryDelayMs * 2^(attempt-1), with jitter
           applied as a random offset in [0, jitterPercent] of the base -
           same pattern lws uses internally (retry_bo_from_retryobj,
           lws-context.c: jitter_percent applied to each table entry). */
        const base = this.#retryDelayMs * Math.pow(2, attempt - 1);
        const jitter = ((base * this.#retryJitterPercent) / 100) * Math.random();
        const delay = base + jitter;

        this.#emit('retry', { url, attempt, delay: Math.round(delay), error: lastError });
        await new Promise(r => setTimeout(r, delay));
      }

      try {
        const resp = await fetch(url, { ...this.#fetchOptions });

        if(resp.status >= 500) {
          lastError = new Error(`HTTP ${resp.status}`);
          continue;
        }

        if(resp.status < 200 || resp.status >= 300) return null;

        const ct = resp.headers?.get?.('content-type') ?? '';
        // Only parse HTML, XML, XHTML, and similar text-based markup formats
        if(!/^(text\/html|application\/xhtml\+xml|application\/xml|text\/xml|text\/plain)\b/i.test(ct)) return null;

        const chunks = [];
        for await(const chunk of resp.body) chunks.push(toString(chunk.buffer ?? chunk));
        const html = chunks.join('');

        /*console.log('url', url);
        console.log('html', { html });*/

        const title = extractTitle(html) ?? url;
        const body = extractBody(html);
        const cleaned = stripNoise(body);
        const markdown = html2md(cleaned);
        const links = discoverLinks(html, url);

        return { url, title, markdown, links };
      } catch(e) {
        lastError = e;
      }
    }

    // All retries exhausted
    throw lastError ?? new Error(`failed to fetch ${url}`);
  }

  /** Main crawl loop. Processes the BFS queue one page at a time, yielding
      results to consumers and discovering links after each page. Runs until
      the queue empties with no pending fetches, or stop() is called. */
  async #run() {
    while(!this.#stopped) {
      if(this.#paused || this.#queue.length === 0) {
        // Nothing to do. If no fetches in flight, we're done.
        if(this.#queue.length === 0 && this.#pending === 0) break;

        // Idle-wait: park on a promise that stop()/resume()/add() resolves.
        await new Promise(resolve => {
          this.#drain = { resolve };
        });
        continue;
      }

      const { url, depth } = this.#queue.shift();

      this.#pending++;
      this.#emit('fetch', url);

      try {
        const page = await this.#fetchPage(url);

        if(page) {
          this.#pushResult(page);
          this.#emit('page', page);

          // Discover and queue links if within depth budget.
          if(depth < this.#maxDepth) {
            const toFollow =
              typeof this.#followLinks === 'function'
                ? this.#followLinks(page.links, page)
                : this.#followLinks
                  ? page.links.filter(l => this.#isAllowed(l) && !/\.(css|js)(\?|$)/i.test(l))
                  : [];

            for(const link of toFollow) {
              if(!this.#visited.has(link)) {
                this.#markVisited(link);
                this.#queue.push({ url: link, depth: depth + 1 });
              }
            }
          }
        }
      } catch(e) {
        this.#emit('error', { url, error: e });
      }

      this.#pending--;

      if(this.#delay > 0 && !this.#stopped && this.#queue.length > 0) {
        await new Promise(r => setTimeout(r, this.#delay));
      }
    }

    // Crawl finished - signal all waiting consumers.
    this.#flushWaiters();
  }

  /** Start crawling one or more seed URLs. Returns a promise that resolves
      when the crawl finishes (all reachable pages yielded, or stop() was
      called). The async iterator (for-await) can be consumed concurrently. */
  async start(urlOrUrls) {
    const seeds = Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls];

    for(const url of seeds) {
      const clean = url.split('#')[0];
      if(this.#visited.has(clean)) continue;

      try {
        this.#hosts.add(new URL(clean).host);
      } catch(e) {
        continue;
      }

      this.#markVisited(clean);
      this.#queue.push({ url: clean, depth: 0 });
    }

    this.#stopped = false;
    this.#paused = false;

    this.#emit('start', { seeds: [...this.#visited] });

    return this.#run();
  }

  /** Async iterator protocol - enables `for await (const page of crawler)`.
      Each iteration yields one page object:
        { url: string, title: string, markdown: string, links: string[] } */
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if(this.#results.length > 0) {
          return Promise.resolve({ value: this.#results.shift(), done: false });
        }

        // If the crawl is stopped and no buffered results, we're done.
        if(this.#stopped && this.#queue.length === 0 && this.#pending === 0) {
          return Promise.resolve({ value: undefined, done: true });
        }

        // Block until a page is available or the crawl ends.
        return new Promise(resolve => this.#waiters.push(resolve));
      },
      return: () => {
        this.stop();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
