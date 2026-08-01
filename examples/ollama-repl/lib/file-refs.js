/**
 * Detects file paths and glob patterns typed into a chat prompt (e.g. "fix
 * the bug in src/foo.js" or "review *.md") and reads their contents so they
 * can be attached to the outgoing message - the same "@file" convenience
 * Claude Code's own prompt does, just token-scanned instead of an explicit
 * `@` syntax.
 */
import * as os from 'os';
import * as std from 'std';
import { globMatch, isGlobPattern } from './match.js';
import { REFERENCE_FILES } from './reference-files.js';

/* A path-shaped token: contains a `/`, or a glob metacharacter, or ends in
   a plausible file extension. Deliberately permissive - false positives
   are filtered out below by actually trying to resolve them on disk. */
const TOKEN_RE = /[./]*[\w.\-\/*?[\]{}]*[\w*?\]][\w.\-\/*?[\]{}]*/g;

const MAX_FILES = 20;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;

function looksLikePath(token) {
  if(token.length < 2) return false;
  if(isGlobPattern(token)) return true;
  if(token.includes('/')) return true;
  return /\.[A-Za-z0-9]{1,10}$/.test(token) && !/^\d+\.\d+$/.test(token); // skip bare "2.5"-style numbers
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
     the same for project files, but different for REFERENCE_FILES entries
     (label is just the bare name, e.g. "quickjs.h"; the actual path is
     wherever that's installed). */
  const paths = new Map();

  for(const token of candidates) {
    if(isGlobPattern(token)) {
      for(const p of globMatch(token, root)) paths.set(p, root === '.' ? p : `${root}/${p}`);
      continue;
    }

    const full = root === '.' ? token : `${root}/${token}`;
    const [st] = os.stat(full);

    if(st && (st.mode & os.S_IFMT) === os.S_IFREG) paths.set(token, full);
    else if(REFERENCE_FILES[token]) paths.set(token, REFERENCE_FILES[token]);
  }

  const files = [];
  let totalBytes = 0;
  const skipped = [];

  for(const [label, full] of paths) {
    if(files.length >= MAX_FILES) {
      skipped.push(label);
      continue;
    }

    const [st] = os.stat(full);

    if(!st || st.size > MAX_FILE_BYTES || totalBytes + st.size > MAX_TOTAL_BYTES) {
      skipped.push(label);
      continue;
    }

    const content = std.loadFile(full);
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
