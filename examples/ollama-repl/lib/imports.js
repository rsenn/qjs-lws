/**
 * Regex-based import/include extraction, plus an readdir-backed
 * recursive resolver that follows local (relative) imports/includes from
 * a starting file to build its dependency closure - so attaching one file
 * can pull in the handful of other files it actually depends on, instead
 * of the model having to separately ask for each one.
 */
import { readdir, S_IFDIR, S_IFREG } from 'os';
import { fileMode } from './match.js';
import { loadFile } from 'std';

/* JS: import ... from 'x'; export ... from 'x'; require('x'); dynamic
   import('x'). C/C++: #include "x" (quoted only - a bare <x> is a system
   header, not a project-relative file, so intentionally not matched). */
const JS_IMPORT_RE = /(?:import|export)(?:[^'"();]*from)?\s*['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
const C_INCLUDE_RE = /^\s*#\s*include\s*"([^"]+)"/gm;

/** Every import/include target string found in `content`, in order, deduped. */
export function extractImportTargets(content) {
  const targets = [];
  const seen = new Set();
  let m;

  JS_IMPORT_RE.lastIndex = 0;
  while((m = JS_IMPORT_RE.exec(content))) {
    const target = m[1] ?? m[2] ?? m[3];
    if(target && !seen.has(target)) {
      seen.add(target);
      targets.push(target);
    }
  }

  C_INCLUDE_RE.lastIndex = 0;
  while((m = C_INCLUDE_RE.exec(content))) {
    if(!seen.has(m[1])) {
      seen.add(m[1]);
      targets.push(m[1]);
    }
  }

  return targets;
}

const CANDIDATE_EXTS = ['', '.js', '.mjs', '.cjs', '.ts', '.h', '.c', '.hpp', '.cpp'];

/** Resolves an import/include `target` (relative or bare) against the directory
    of the importing file (`fromDir`, relative to `root`); readdir()s a
    directory target to find its index file. Returns a root-relative path,
    or null if nothing on disk matches. */
function resolveTarget(target, fromDir, root) {
  if(!target.startsWith('.')) return null; // bare specifier (bare module name, system header) - not a project-local file

  const joined = fromDir ? `${fromDir}/${target}` : target;
  const parts = joined.split('/');
  const normalized = [];

  for(const part of parts) {
    if(part === '.' || part === '') continue;
    if(part === '..') normalized.pop();
    else normalized.push(part);
  }

  const rel = normalized.join('/');
  const base = root === '.' ? rel : `${root}/${rel}`;

  for(const ext of CANDIDATE_EXTS) {
    if(fileMode(base + ext) === S_IFREG) return rel + ext;
  }

  // Directory import (e.g. './lib') - look for an index file inside it via readdir().
  if(fileMode(base) === S_IFDIR) {
    const [names] = readdir(base);

    for(const name of names ?? []) {
      if(/^index\.(js|mjs|cjs|ts)$/.test(name)) return rel ? `${rel}/${name}` : name;
    }
  }

  return null;
}

/**
 * Recursively follows local imports/includes starting at `entryPath`
 * (root-relative), returning every reachable file's `{ path, content }` -
 * `entryPath` itself is not included, only what it (transitively) pulls
 * in. Bounded by `maxFiles` (total) and `maxDepth` (import chain length)
 * so a large or cyclic dependency graph can't flood the request.
 */
export function resolveImportGraph(entryPath, root, { maxFiles = 5, maxDepth = 2 } = {}) {
  const visited = new Set([entryPath]);
  const out = [];
  let frontier = [{ path: entryPath, depth: 0 }];

  while(frontier.length && out.length < maxFiles) {
    const next = [];

    for(const { path, depth } of frontier) {
      if(depth >= maxDepth) continue;

      const full = root === '.' ? path : `${root}/${path}`;
      if(fileMode(full) !== S_IFREG) continue;

      const content = loadFile(full);
      if(content == null) continue;

      const fromDir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

      for(const target of extractImportTargets(content)) {
        const resolved = resolveTarget(target, fromDir, root);
        if(!resolved || visited.has(resolved)) continue;

        visited.add(resolved);
        next.push({ path: resolved, depth: depth + 1 });

        if(out.length + next.length >= maxFiles) break;
      }
    }

    for(const { path } of next) {
      if(out.length >= maxFiles) break;

      const full = root === '.' ? path : `${root}/${path}`;
      const content = loadFile(full);
      if(content != null) out.push({ path, content });
    }

    frontier = next;
  }

  return out;
}
