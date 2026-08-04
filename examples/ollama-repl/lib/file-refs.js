/**
 * Detects file paths and glob patterns typed into a chat prompt (e.g. "fix
 * the bug in src/foo.js" or "review *.md") and reads their contents so they
 * can be attached to the outgoing message - the same "@file" convenience
 * Claude Code's own prompt does, just token-scanned instead of an explicit
 * `@` syntax.
 */
import { stat, S_IFREG } from 'os';
import { loadFile } from 'std';
import { globMatch, isGlobPattern, walk, fileMode } from './match.js';
import { referenceFiles } from './reference-files.js';
import { resolveImportGraph } from './imports.js';

/* A path-shaped token: contains a `/`, or a glob metacharacter, or ends in
   a plausible file extension. Deliberately permissive - false positives
   are filtered out below by actually trying to resolve them on disk. */
const TOKEN_RE = /[./]*[\w.\-\/*?[\]{}]*[\w*?\]][\w.\-\/*?[\]{}]*/g;

const MAX_FILES = 20;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const MAX_DIR_FILES = 5;
const SOURCE_EXT = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'c', 'h', 'cpp', 'hpp', 'html', 'css', 'md']);

function looksLikePath(token) {
  if(token.length < 2) return false;
  if(isGlobPattern(token)) return true;
  if(token.endsWith('/')) return true;
  if(token.includes('/')) return true;
  return /\.[A-Za-z0-9]{1,10}$/.test(token) && !/^\d+\.\d+$/.test(token); // skip bare "2.5"-style numbers
}

/** The `MAX_DIR_FILES` most-recently-modified source files directly under
    `dir` (recursively) - path.js/.c/.md/etc references ending in "/"
    trigger this instead of a single-file lookup ("src/" -> its newest
    handful of source files, not a literal file named "src/"). */
function newestSourceFiles(dir, root) {
  const base = dir ? (root === '.' ? dir : `${root}/${dir}`) : root;
  const candidates = [];

  for(const path of walk(base, root)) {
    const rel = root === '.' ? path : path.slice(root.length + 1);
    const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase();

    if(!SOURCE_EXT.has(ext)) continue;

    const [st] = stat(root === '.' ? rel : `${root}/${rel}`);
    if(st) candidates.push({ path: rel, mtime: st.mtime });
  }

  candidates.sort((a, b) => b.mtime - a.mtime);

  return candidates.slice(0, MAX_DIR_FILES).map(c => c.path);
}

function stripPunctuation(token) {
  return token.replace(/^[,.;:()'"`]+/, '').replace(/[,.;:()'"`]+$/, '');
}

/**
 * Scans `text` for file/glob references, resolves them against `root`, and
 * returns `{ text, files }` - `files` is `[{ path, content }]` for every
 * match that actually resolved to a readable regular file, deduped, capped
 * at `MAX_FILES`/`MAX_TOTAL_BYTES` so a runaway glob can't flood the
 * request. `text` is unchanged; callers combine it with `files` themselves
 * (see buildMessage() in repl.js) so detection stays independent of
 * formatting.
 */
export function extractFileRefs(text, root = '.') {
  const candidates = new Set();

  for(const raw of text.match(TOKEN_RE) ?? []) {
    const token = stripPunctuation(raw);
    if(looksLikePath(token)) candidates.add(token);
  }

  /* label (shown to the model, and used as the write-back path if the
     model echoes it in a "File:" block) -> the actual path to read from -
     the same for project files, but different for referenceFiles() entries
     (label is just the bare name, e.g. "quickjs.h"; the actual path is
     wherever that's installed or checked out). */
  const paths = new Map();

  /* Direct (non-glob, non-directory) file matches also pull in their own
     direct/transitive local imports (lib/imports.js) - one file reference
     brings its immediate dependencies along, instead of the model having
     to separately ask for each one it turns out to need. */
  const importRoots = [];
  const referenceFilePaths = referenceFiles(root);

  for(const token of candidates) {
    if(token.endsWith('/')) {
      const dir = token.replace(/\/+$/, '');

      for(const p of newestSourceFiles(dir, root)) paths.set(p, root === '.' ? p : `${root}/${p}`);
      continue;
    }

    if(isGlobPattern(token)) {
      for(const p of globMatch(token, root)) paths.set(p, root === '.' ? p : `${root}/${p}`);
      continue;
    }

    const full = root === '.' ? token : `${root}/${token}`;

    if(fileMode(full) === S_IFREG) {
      paths.set(token, full);
      importRoots.push(token);
    } else if(referenceFilePaths[token]) {
      paths.set(token, referenceFilePaths[token]);
    }
  }

  for(const entry of importRoots) {
    for(const { path } of resolveImportGraph(entry, root)) {
      if(!paths.has(path)) paths.set(path, root === '.' ? path : `${root}/${path}`);
    }
  }

  const files = [];
  let totalBytes = 0;
  const skipped = [];

  for(const [label, full] of paths) {
    if(files.length >= MAX_FILES) {
      skipped.push(label);
      continue;
    }

    const [st] = stat(full);

    if(!st || st.size > MAX_FILE_BYTES || totalBytes + st.size > MAX_TOTAL_BYTES) {
      skipped.push(label);
      continue;
    }

    const content = loadFile(full);
    if(content == null) {
      skipped.push(label);
      continue;
    }

    files.push({ path: label, content });
    totalBytes += st.size;
  }

  return { files, skipped };
}

const EXT_LANG = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  jsx: 'jsx',
  tsx: 'tsx',
  json: 'json',
  py: 'python',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  sh: 'bash',
  md: 'markdown',
  html: 'html',
  css: 'css',
  yml: 'yaml',
  yaml: 'yaml',
  log: 'text',
  txt: 'cmake',
  cmake: 'cmake',
  ac: 'aclocal',
  in: 'autotools',
  am: 'automake',
  'clang-format': 'yaml',
  crt: 'pem/x509',
  key: 'pem/x509',
  pem: 'pem',
  'sublime-project': 'json/sublime-text',
  'sublime-workspace': 'json/sublime-text',
  prettierrc: 'json',
  git: 'text',
  gitignore: 'magic',
  'cmake-format': 'magic',
  gitmodules: 'text',
  diff: 'diff',
  patch: 'diff',
  sqlite: 'sqlite',
  sqlite3: 'sqlite',
  project: 'xml/eclipse',
  cproject: 'xml/eclipse',
};

export function languageFor(path) {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return EXT_LANG[ext] ?? '';
}

/** Renders `files` as "File: path" + fenced-code blocks, the same shape the
    assistant is instructed (see SYSTEM_PROMPT in repl.js) to reply with. */
export function formatFileBlocks(files) {
  return files.map(f => `File: ${f.path}\n\`\`\`${languageFor(f.path)}\n${f.content}\n\`\`\``).join('\n\n');
}
