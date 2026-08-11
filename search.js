#!/usr/bin/env qjsm
import { fetch } from './lib/fetch.js';
import { puts, exit, err as stderr } from 'std';
import { LLL_USER, LLL_WARN, LLL_ERR, logLevel } from 'lws.so';
import { Console } from 'console';

globalThis.console = new Console(stderr, { inspectOptions: {} });

logLevel((process.env.DEBUG ? LLL_USER : 0) | LLL_WARN | LLL_ERR, (l, m) => console.log(m.replace(/: \w+: /, ': ')));

async function main() {
  const apiKey = process.env.SERP_API_KEY;
  if(!apiKey) {
    console.error('SERP_API_KEY environment variable not set');
    exit(1);
  }

  const jsonOutput = scriptArgs.includes('--json');
  const plainOutput = scriptArgs.includes('--plain');
  let limit = Infinity;
  let args = scriptArgs.slice(1).filter(a => a !== '--json' && a !== '--plain');

  // Parse -n or --limit
  for(let i = 0; i < args.length; i++) {
    if((args[i] === '-n' || args[i] === '--limit') && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      args.splice(i, 2);
      i--;
    }
  }

  const q = args.length > 0 ? args.join(' ') : 'quickjs native modules';

  let allResults = [];
  let nextLink = null;
  let pageNum = 1;
  let ctx;
  let positionOffset = 0;

  if(!plainOutput) console.log(`Searching: "${q}"${limit !== Infinity ? ` (limit: ${limit})` : ''}...`);

  do {
    let url;
    if(nextLink) {
      // Use the next page link from pagination
      // Add api_key if not already present
      if(!nextLink.includes('api_key=')) {
        url = `${nextLink}&api_key=${encodeURIComponent(apiKey)}`;
      } else {
        url = nextLink;
      }

      pageNum++;
      if(!jsonOutput && !plainOutput) console.log(`Fetching page ${pageNum}...`);
    } else {
      // First page
      const qs = [
        ['engine', 'google'],
        ['q', q],
        ['api_key', apiKey],
      ]
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
      url = `https://serpapi.com/search?${qs}`;
    }

    const resp = await fetch(url, {
      h2: false,
      retry: { retryMsTable: [2000, 5000, 10000], jitter_percent: 20 },
      pctx: c => (ctx = c),
    });
    const text = await resp.text();
    const data = JSON.parse(text);

    if(data.error) {
      console.error('API error:', data.error);
      exit(1);
    }

    const results = data.organic_results || [];
    for(const r of results) {
      if(r.position !== undefined) r.position += positionOffset;
    }
    allResults = allResults.concat(results);
    positionOffset += results.length;

    // Check for pagination
    nextLink = data.serpapi_pagination?.next_link || null;

    // Stop if we have enough results or no more pages
  } while(nextLink && allResults.length < limit);

  // Apply limit
  if(limit !== Infinity && allResults.length > limit) {
    allResults = allResults.slice(0, limit);
  }

  if(plainOutput) {
    for(const r of allResults) {
      if(r.link) puts(r.link + '\n');
    }
  } else if(jsonOutput) {
    puts(JSON.stringify(allResults, null, 2) + '\n');
  } else if(allResults.length > 0) {
    console.log(`\n${allResults.length} results:\n`);

    for(const r of allResults) {
      puts(`  ${r.title}\n`);
      puts(`  ${r.link}\n`);

      if(r.snippet) puts(`  ${r.snippet}\n`);

      puts('\n');
    }
  } else {
    console.log('No results found.');
  }

  ctx?.destroy();
}

main();
