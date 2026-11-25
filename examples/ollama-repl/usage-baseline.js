#!/usr/bin/env qjsm
/**
 * usage-baseline: the numbers of usage.jsonl (the requests of every session, ~/.cache/ollama-repl/) that the health,
 * exploration and failover changes are measured against, see doc/HEALTH-EXPERIMENTS.md.
 *
 *   qjsm usage-baseline.js [--days N] [--origin URL] [--json]
 *
 * --days N     only the last N days (default: all rows)
 * --origin URL only the rows of one gateway, e.g. http://localhost:3001
 * --json       the numbers as JSON instead of the tables
 */
import { out as stdout } from 'std';
import { readUsage } from './lib/persist.js';
import { baseline, baselineText } from './lib/usage-baseline.js';

const args = scriptArgs.slice(1);
let days = 0, origin, json = false;

for(let i = 0; i < args.length; i++) {
  if(args[i] === '--days') days = +args[++i];
  else if(args[i] === '--origin') origin = args[++i];
  else if(args[i] === '--json') json = true;
}

const rows = readUsage({ origin, sinceMs: days > 0 ? Date.now() - days * 86400e3 : 0 });
const b = baseline(rows);
stdout.puts(`${json ? JSON.stringify(b, null, 1) : baselineText(b)}\n`);
