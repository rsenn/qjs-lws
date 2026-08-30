/**
 * Regex-based import/include extraction, plus an readdir-backed resolver
 * that turns a local (relative) import/include target into a project-
 * relative path - so a file attached to a prompt can be annotated with
 * what it directly depends on (see `directDependencies()` below and
 * `file-refs.js`) without those files' *contents* being pulled in and
 * attached too; the model is expected to `read_file` whichever of them it
 * actually turns out to need (see the system prompt, repl.js).
 */
import { readdir, S_IFDIR, S_IFREG } from 'os';
import { fileMode } from './match.js';

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
 * `fromPath`'s own direct (one level, not transitive) local imports/
 * includes, resolved to project-relative paths - paths only, nothing is
 * read beyond `fromPath`'s own already-loaded `content`, so this is cheap
 * to call for every file a prompt attaches. Targets that don't resolve to
 * a real file (bare specifiers, system headers, a typo) are silently
 * dropped, same as `resolveImportGraph` used to.
 */
export function directDependencies(fromPath, content, root) {
  const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
  const deps = [];

  for(const target of extractImportTargets(content)) {
    const resolved = resolveTarget(target, fromDir, root);
    if(resolved && !deps.includes(resolved)) deps.push(resolved);
  }

  return deps;
}
