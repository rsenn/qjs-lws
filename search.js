#!/usr/bin/env qjsm
import { fetch } from './lib/fetch.js';
import { puts, exit, err as stderr } from 'std';
import { LLL_USER, LLL_WARN, LLL_ERR, logLevel } from 'lws.so';
import { Console } from 'console';

//globalThis.console = new Console(stderr, { inspectOptions: {} });

//logLevel((process.env.DEBUG ? LLL_USER : 0) | LLL_WARN | LLL_ERR, (l, m) => console.log(m.replace(/: \w+: /, ': ')));

// SerpApi `engine` value -> query parameter name and the response key holding web results
const ENGINES = {
  google: { q: 'q' },
  bing: { q: 'q' },
  duckduckgo: { q: 'q' },
  yahoo: { q: 'p' },
  yandex: { q: 'text' },
  baidu: { q: 'q' },
  naver: { q: 'query', results: 'web_results' },
};

// fetch() keeps one shared keep-alive context, so it may only be destroyed once every engine is done
let ctx;

async function searchEngine(engine, q, limit, apiKey, verbose) {
  const { q: queryParam, results: resultsKey = 'organic_results' } = ENGINES[engine];
  let allResults = [];
  let nextLink = null;
  let pageNum = 1;
  let positionOffset = 0;

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
      if(verbose) console.log(`Fetching ${engine} page ${pageNum}...`);
    } else {
      // First page
      const qs = [
        ['engine', engine],
        [queryParam, q],
        ['api_key', apiKey],
      ]
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
      url = `https://serpapi.com/search?${qs}`;
    }

    const resp = await fetch(url, {
      h2: false,
      retry: { retryMsTable: [2000, 5000, 10000], jitterPercent: 20 },
      pctx: c => (ctx = c),
    });
    const text = await resp.text();
    const data = JSON.parse(text);

    if(data.error) throw new Error(`API error: ${data.error}`);

    const results = data[resultsKey] || [];
    for(const r of results) {
      if(r.position !== undefined) r.position += positionOffset;
      r.engine = engine;
    }
    allResults = allResults.concat(results);
    positionOffset += results.length;

    // Check for pagination
    nextLink = data.serpapi_pagination?.next_link || null;

    // Stop if we have enough results or no more pages
  } while(nextLink && allResults.length < limit);

  return allResults;
}

// 1st result of every list, then the 2nd of every list, and so on
function interleave(lists) {
  const merged = [];
  for(let i = 0; lists.some(l => i < l.length); i++) for(const l of lists) if(i < l.length) merged.push(l[i]);
  return merged;
}

async function main() {
  const apiKey = process.env.SERP_API_KEY;
  if(!apiKey) {
    console.error('SERP_API_KEY environment variable not set');
    exit(1);
  }

  const jsonOutput = scriptArgs.includes('--json');
  const plainOutput = scriptArgs.includes('--plain');
  const allEngines = scriptArgs.includes('--all');
  let limit = Infinity;
  const engineNames = [];
  let args = scriptArgs.slice(1).filter(a => a !== '--json' && a !== '--plain' && a !== '--all');

  // Parse -n or --limit, -e or --engine (repeatable, comma-separated)
  for(let i = 0; i < args.length; i++) {
    if((args[i] === '-n' || args[i] === '--limit') && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      args.splice(i, 2);
      i--;
    } else if((args[i] === '-e' || args[i] === '--engine') && args[i + 1]) {
      engineNames.push(...args[i + 1].split(','));
      args.splice(i, 2);
      i--;
    }
  }

  const available = Object.keys(ENGINES);
  const engines = allEngines ? available : engineNames.length > 0 ? [...new Set(engineNames)] : ['google'];
  const unknown = engines.filter(e => !available.includes(e));
  if(unknown.length > 0) {
    console.error(`Unknown engine: ${unknown.join(', ')} (available: ${available.join(', ')})`);
    exit(1);
  }

  const q = args.length > 0 ? args.join(' ') : 'quickjs native modules';

  if(!plainOutput) console.log(`Searching: "${q}" via ${engines.join(', ')}${limit !== Infinity ? ` (limit: ${limit})` : ''}...`);

  // Interleaving takes at most ceil(limit / engines) from each, so don't page any further (each page is a billed search)
  const perEngine = Math.ceil(limit / engines.length);
  const outcomes = await Promise.allSettled(engines.map(e => searchEngine(e, q, perEngine, apiKey, !jsonOutput && !plainOutput)));
  const lists = [];
  outcomes.forEach((o, i) => {
    if(o.status === 'fulfilled') lists.push(o.value);
    else console.error(`${engines[i]}: ${o.reason?.message ?? o.reason}`);
  });
  if(lists.length === 0) exit(1);

  let allResults = interleave(lists);

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
      puts(`  ${engines.length > 1 ? `[${r.engine}] ` : ''}${r.title}\n`);
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
