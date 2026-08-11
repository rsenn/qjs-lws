# Web Crawler

A realtime-controllable web crawler that yields pages as Markdown via an async iterator - built for agentic use, where the caller inspects each page and decides where to go next.

## Features

- **Breadth-first traversal** with configurable max depth
- **Async iterable** - use `for await` to consume pages as they arrive
- **Realtime control** - pause/resume/stop/add URLs from an `on('page')` handler or between iterations
- **Same-host filtering** (default on) - only follow links on seed hosts, or configure an allowList
- **HTML → Markdown** via `html2md()` - strips `<script>`/`<style>` noise, extracts `<body>`, preserves structure
- **Event-driven** - `on('page')`, `on('error')`, `on('fetch')`, `on('pause')`, `on('resume')` callbacks
- **Graceful shutdown** - `stop()` abandons in-flight fetches, ends the iterator, and flushes consumers

## Quick Start

### CLI

```bash
qjsm examples/crawler/crawl.js https://example.com/docs
```

Crawl `https://example.com/docs` and its same-host links (depth 3), streaming Markdown to stdout.

```bash
qjsm examples/crawler/crawl.js --depth 2 --delay 500 -o docs.md https://example.com
```

Crawl to depth 2, wait 500ms between fetches, write output to `docs.md`.

```bash
qjsm examples/crawler/crawl.js --no-follow --allow api.example.com https://example.com
```

Don't auto-follow links, but allow `api.example.com` if manually added.

### Library

```js
import { Crawler } from './lib/crawler.js';

const crawler = new Crawler({ maxDepth: 2, delay: 200 });
crawler.start('https://example.com');

for await(const page of crawler) {
  console.log(`# ${page.title}\n${page.markdown}`);

  // Optionally direct the crawl:
  if(page.links.some(l => l.includes('api'))) {
    crawler.add('https://api.example.com');
  }
  if(page.markdown.includes('STOP')) {
    crawler.stop();
  }
}
```

Or callback-driven:

```js
const crawler = new Crawler({ maxDepth: 2 });

crawler.on('page', page => {
  console.log(`Fetched: ${page.url} (${page.markdown.length} bytes)`);
});

crawler.on('error', ({ url, error }) => {
  console.error(`Failed: ${url} - ${error.message}`);
});

await crawler.start('https://example.com');
```

## API

### `new Crawler(opts)`

- `maxDepth` (default: `3`) - BFS depth limit (0 = seed only)
- `sameHost` (default: `true`) - only follow links on seed hosts
- `allowList` - array of host patterns to allow (overrides `sameHost`)
- `delay` (default: `0`) - ms between consecutive fetches
- `timeoutSecs` (default: `30`) - per-page fetch timeout
- `userAgent` - User-Agent header
- `fetchOptions` - extra options passed to `fetch()`
- `followLinks` (default: `true`) - auto-queue same-host links; `false` for no auto-follow; `function(links, page)` for caller-controlled

### Instance Methods

- **`start(urlOrUrls)`** - begin crawling one or more seed URLs. Returns a promise that resolves when the crawl finishes (or `stop()` is called).
- **`add(urlOrUrls)`** - enqueue new URLs (respects `sameHost` / `allowList`). Returns the count of URLs actually enqueued. Safe to call at any time.
- **`stop()`** - abandon queue and in-flight fetches, end the iterator. Idempotent.
- **`pause()`** - stop dequeuing new URLs (in-flight fetches still finish).
- **`resume()`** - resume after `pause()`.
- **`on(event, fn)`** - register a callback (`'page'`, `'error'`, `'fetch'`, `'start'`, `'pause'`, `'resume'`).
- **`off(event, fn)`** - unregister a callback.

### Properties

- **`visited`** - `Set` of all URLs already fetched or queued (read-only copy)
- **`queued`** - number of URLs in the queue
- **`pending`** - number of in-flight fetches
- **`stopped`** - `true` if `stop()` has been called
- **`paused`** - `true` if `pause()` has been called (and not yet resumed)

### Async Iterator Protocol

`Crawler` implements `[Symbol.asyncIterator]()`, enabling `for await (const page of crawler)`. Each iteration yields a page object:

```js
{
  url: string,       // the page URL
  title: string,     // extracted from <title>, or the URL if absent
  markdown: string,  // the page body as Markdown
  links: string[],   // absolute URLs discovered in the page
}
```

### Events

- **`'start'`** `{ seeds: string[] }` - crawl started
- **`'fetch'`** `(url)` - about to fetch a URL
- **`'page'`** `(page)` - page fetched and converted to Markdown
- **`'error'`** `({ url, error })` - fetch failed or HTML parsing error
- **`'pause'`** - crawler paused
- **`'resume'`** - crawler resumed

## Realtime Control

The crawler is designed for agentic use: inspect each page and decide where to go next.

### Manual Link Following

```js
const crawler = new Crawler({ maxDepth: 2, followLinks: false });
crawler.start('https://example.com');

for await(const page of crawler) {
  // Only follow links that mention "api" or "docs"
  const interesting = page.links.filter(l => /api|docs/.test(l));
  crawler.add(interesting);
}
```

### Callback-Driven Control

```js
crawler.on('page', page => {
  if(page.title.includes('Login')) {
    crawler.stop(); // stop if we hit a login page
  }
  if(page.url.includes('/api/')) {
    crawler.add(page.links.filter(l => l.includes('/v2/')));
  }
});
```

### Custom Link Filter

```js
const crawler = new Crawler({
  maxDepth: 2,
  followLinks: (links, page) => {
    // Only follow links that share a path prefix with the current page
    const prefix = page.url.slice(0, page.url.lastIndexOf('/'));
    return links.filter(l => l.startsWith(prefix));
  },
});
```

### Pause and Resume

```js
const crawler = new Crawler({ maxDepth: 3 });
crawler.start('https://example.com');

crawler.on('page', async page => {
  if(page.markdown.length > 10000) {
    crawler.pause();
    await processLargePage(page);
    crawler.resume();
  }
});
```

## CLI Options

```
Usage: qjsm crawl.js [OPTIONS] URL [URL...]

Options:
  -d, --depth N          BFS depth limit (default: 3)
  --delay MS             ms between consecutive fetches (default: 0)
  --same-host            only follow links on seed hosts (default: on)
  --no-same-host         follow links to any host
  --allow HOST           comma-separated list of allowed hosts/patterns
  --no-follow            don't auto-follow links (manual crawl via .add())
  -o, --output FILE      write markdown to FILE instead of stdout
  --no-headers           suppress the "# URL" header before each page
  -q, --quiet            suppress progress output (stderr)
  -h, --help             show this help
```

## Architecture

- **`lib/crawler.js`** - the `Crawler` class (BFS queue, async iterator, realtime control)
- **`crawl.js`** - CLI wrapper that streams Markdown to stdout or a file
- **`fetch()`** - HTTP/1.1 + HTTP/2 client from `lib/fetch.js` (connection reuse, TLS, cookies)
- **`html2md()`** - HTML → Markdown converter (local copy in `lib/html2md.js`)

The crawler builds on `fetch()`'s connection reuse (shared context for keep-alive) and `html2md()`'s tolerant XMLParser-based conversion. `<script>` and `<style>` blocks are stripped before conversion to avoid noise. The `<body>` is extracted (or the full HTML if no `<body>` tag is found), and the `<title>` is extracted from the `<head>` before stripping.

## Limitations

- **No JavaScript rendering** - pages that require JS to render content will not be fully crawled
- **No robots.txt parsing** - the crawler does not respect `robots.txt` directives
- **No authentication** - no built-in support for cookies, tokens, or login flows (though `fetch()` supports `credentials: 'include'` if you extend the crawler)
- **No rate limiting** - use `delay` to throttle requests; no adaptive backoff on 429/503 responses

## Examples

### Crawl a Documentation Site

```bash
qjsm examples/crawler/crawl.js --depth 3 --delay 100 -o docs.md https://docs.example.com
```

### Crawl with Custom Link Filter

```js
const crawler = new Crawler({
  maxDepth: 2,
  followLinks: (links, page) => {
    // Only follow links in the same directory
    const dir = page.url.slice(0, page.url.lastIndexOf('/') + 1);
    return links.filter(l => l.startsWith(dir));
  },
});

crawler.start('https://example.com/docs/');
```

### Crawl and Index for RAG

```js
const crawler = new Crawler({ maxDepth: 2, sameHost: false });
crawler.start(['https://example.com', 'https://api.example.com']);

const documents = [];
for await(const page of crawler) {
  documents.push({
    source: page.url,
    title: page.title,
    content: page.markdown,
    metadata: { links: page.links.length },
  });
}

// Pass `documents` to your embedding model / vector store
```

## See Also

- [`lib/fetch.js`](../../../lib/fetch.js) - HTTP client with connection reuse, TLS, and cookies
- [`lib/html2md.js`](./lib/html2md.js) - HTML → Markdown converter
- [`ollama-repl`](../../ollama-repl/) - agentic REPL that could consume this crawler's output
