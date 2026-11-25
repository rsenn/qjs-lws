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
import { directDependencies } from './imports.js';

/* A path-shaped token: contains a `/`, or a glob metacharacter, or ends in
   a plausible file extension. Deliberately permissive - false positives
   are filtered out below by actually trying to resolve them on disk. */
const TOKEN_RE = /[./]*[\w.\-\/*?[\]{}]*[\w*?\]][\w.\-\/*?[\]{}]*/g;

/* what goes into the message as text: a file over ATTACH_MAX_BYTES, generated or binary, or one past the count or total budget
   is only named (see formatFileRefs()) and the model reads it with read_file when it needs it */
const MAX_FILES = 12;
export const ATTACH_MAX_BYTES = 10 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024;
/* largest file read just to count its lines for the reference (and to spot a binary) */
const COUNT_MAX_BYTES = 512 * 1024;
const MAX_REFS = 20;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|xz|bz2|zst|tar|7z|so|o|a|dll|exe|bin|wasm|class|jar|mp[34]|mkv|mov|woff2?|ttf|otf|sqlite3?|db|cpio)$/i;
const GENERATED = /(^|\/)(node_modules|\.git|build[^/]*|dist|out)\/|\.min\.(js|css)$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;
const MAX_DIR_FILES = 4;
export const SOURCE_EXT = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'c', 'h', 'cpp', 'hpp', 'html', 'css', 'md']);

function looksLikePath(token) {
  if(token.length < 2) return false;
  if(isGlobPattern(token)) {
    // Require at least one alphanumeric character to avoid matching
    // pure glob metacharacters like "***", "**", "???" which commonly
    // appear in make output and would expand to every file.
    return /[A-Za-z0-9]/.test(token);
  }
  if(token.endsWith('/')) return true;
  if(token.includes('/')) return true;
  return /\.[A-Za-z0-9]{1,10}$/.test(token) && !/^\d+\.\d+$/.test(token); // skip bare "2.5"-style numbers
}

/** Up to `MAX_DIR_FILES` source files under `dir` (recursively) - a bare
    directory reference ending in "/" triggers this instead of a single-
    file lookup ("src/" -> a handful of its source files, not a literal
    file named "src/"). Ordered top-level-first (files directly in `dir`
    before anything in a subdirectory), then newest-first within each
    depth - representative of the directory's own top rather than
    whichever subdirectory happens to have the single newest file, and
    capped well below "every file in there" so a broad directory
    reference can't flood the request. */
function newestSourceFiles(dir, root) {
  const base = dir ? (root === '.' ? dir : `${root}/${dir}`) : root;
  const candidates = [];

  for(const path of walk(base, root)) {
    const rel = root === '.' ? path : path.slice(root.length + 1);
    const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase();

    if(!SOURCE_EXT.has(ext)) continue;

    const [st] = stat(root === '.' ? rel : `${root}/${rel}`);
    if(!st) continue;

    const withinDir = dir ? rel.slice(dir.length + 1) : rel;
    const depth = withinDir.split('/').length - 1; // 0 = directly in `dir`, 1 = one subdirectory down, ...

    candidates.push({ path: rel, mtime: st.mtime, depth });
  }

  candidates.sort((a, b) => a.depth - b.depth || b.mtime - a.mtime);

  return candidates.slice(0, MAX_DIR_FILES).map(c => c.path);
}

function stripPunctuation(token) {
  return token.replace(/^[,.;:()'"`]+/, '').replace(/[,.;:()'"`]+$/, '');
}

/**
 * Scans `text` for file/glob references, resolves them against `root`, and
 * returns `{ text, files }` - `files` is `[{ path, content, dependencies }]`
 * for every match that actually resolved to a readable regular file,
 * deduped, capped at `MAX_FILES`/`MAX_TOTAL_BYTES` so a runaway glob can't
 * flood the request. `dependencies` is that file's own direct imports/
 * includes (paths only, see `directDependencies()` - `lib/imports.js`) -
 * not attached, just named, so the model can `read_file` whichever it
 * actually needs instead of every attached file dragging its dependency chain along
 * unasked. `text` is unchanged; callers combine it with `files` themselves
 * (see buildMessage() in repl.js) so detection stays independent of
 * formatting.
 */
export function extractFileRefs(text, root = '.') {
  const candidates = new Set();

  /* "lib/path/<function-name>.c" / "lib/{name}.c" are templates, not paths:
     without this the directory part ("lib/path/") alone was picked up and
     four arbitrary files from it attached. */
  const scanned = text.replace(/\S*[<{][^>}\s]*[>}]\S*/g, ' ');

  for(const raw of scanned.match(TOKEN_RE) ?? []) {
    const token = stripPunctuation(raw);
    if(looksLikePath(token)) candidates.add(token);
  }

  /* label (shown to the model, and used as the write-back path if the
     model echoes it in a "File:" block) -> the actual path to read from -
     the same for project files, but different for referenceFiles() entries
     (label is just the bare name, e.g. "quickjs.h"; the actual path is
     wherever that's installed or checked out). */
  const paths = new Map();

  /* Labels eligible for directDependencies() below - every root-relative
     match (direct file, glob, directory pick), but not a referenceFiles()
     entry: those live outside `root` entirely (an installed/checked-out
     location), so resolving *their* imports/includes against `root`
     wouldn't mean anything. */
  const projectRelative = new Set();
  const referenceFilePaths = referenceFiles(root);

  for(const token of candidates) {
    if(token.endsWith('/')) {
      const dir = token.replace(/\/+$/, '');

      for(const p of newestSourceFiles(dir, root)) {
        paths.set(p, root === '.' ? p : `${root}/${p}`);
        projectRelative.add(p);
      }
      continue;
    }

    if(isGlobPattern(token)) {
      for(const p of globMatch(token, root)) {
        paths.set(p, root === '.' ? p : `${root}/${p}`);
        projectRelative.add(p);
      }
      continue;
    }

    const full = root === '.' ? token : `${root}/${token}`;

    if(fileMode(full) === S_IFREG) {
      paths.set(token, full);
      projectRelative.add(token);
    } else if(referenceFilePaths[token]) {
      paths.set(token, referenceFilePaths[token]);
    }
  }

  const files = [];
  let totalBytes = 0;
  const skipped = [];
  const large = [];

  for(const [label, full] of paths) {
    const [st] = stat(full);

    if(!st || BINARY_EXT.test(label)) {
      skipped.push(label);
      continue;
    }

    const why = GENERATED.test(label) ? 'generated' : st.size > ATTACH_MAX_BYTES ? 'too large' : files.length >= MAX_FILES || totalBytes + st.size > MAX_TOTAL_BYTES ? 'over the budget' : null;

    if(why) {
      /* named only: its size and lines tell the model whether to read it whole or by line range */
      const text = st.size <= COUNT_MAX_BYTES ? loadFile(full) : null;
      if(text?.includes('\0')) skipped.push(label);
      else large.push({ path: label, size: st.size, lines: text == null ? null : text.split('\n').length - (text.endsWith('\n') ? 1 : 0), why });
      continue;
    }

    const content = loadFile(full);
    if(content == null || content.includes('\0')) {
      skipped.push(label);
      continue;
    }

    const dependencies = projectRelative.has(label) ? directDependencies(label, content, root) : [];

    files.push({ path: label, content, dependencies });
    totalBytes += st.size;
  }

  return { files, skipped, large };
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

/** Renders `files` as "File: path" + fenced-code blocks (plus a
    dependencies note when `extractFileRefs()` found any - see its own
    doc comment), the same shape the assistant is instructed (see
    SYSTEM_PROMPT in repl.js) to reply with. */
/** "53 KB", "812 B", "1.4 MB" */
const fmtSize = n => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 102.4) / 10} KB` : `${Math.round(n / 104857.6) / 10} MB`);

/** the files that were not attached, by name in backticks with size and lines, and how to get at them */
export function formatFileRefs(large) {
  if(!large?.length) return '';

  const rows = large.slice(0, MAX_REFS).map(f => `- \`${f.path}\` (${f.lines != null ? `${f.lines} lines, ` : ''}${fmtSize(f.size)}${f.why === 'too large' ? '' : `, ${f.why}`})`);
  if(large.length > MAX_REFS) rows.push(`- ... and ${large.length - MAX_REFS} more`);

  return `Not attached (too large, generated or over the size budget of this message): read the part you need with read_file (path, and start/end for a line range), do not guess what is in them:\n${rows.join('\n')}`;
}

export function formatFileBlocks(files) {
  return files
    .map(f => {
      const deps = f.dependencies?.length ? `\n(imports/includes: ${f.dependencies.join(', ')} - read_file any of these you actually need)` : '';
      return `File: ${f.path}\n\`\`\`${languageFor(f.path)}\n${f.content}\n\`\`\`${deps}`;
    })
    .join('\n\n');
}
