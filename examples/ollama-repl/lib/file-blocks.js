/**
 * Parses "File: path\n```lang\n...content...\n```" blocks out of an
 * assistant reply and writes them into the local project tree. This is the
 * one output convention the system prompt (repl.js) asks the model to
 * follow for any file it wants to create or modify - deliberately simple
 * and unambiguous to parse, rather than trying to guess intent from
 * arbitrary fenced code blocks.
 */
import { stat, mkdir } from 'os';
import { open as fopen } from 'std';

const FILE_BLOCK_RE = /^File:[ \t]*(\S+)[ \t]*\r?\n```[^\n`]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;
const FENCE_RE = /```([a-zA-Z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)\r?\n```/g;

/** Every `{ path, content }` file block found in `text`. */
export function extractFileBlocks(text) {
  const blocks = [];
  let m;

  FILE_BLOCK_RE.lastIndex = 0;

  while((m = FILE_BLOCK_RE.exec(text))) blocks.push({ path: m[1].replaceAll(/(^[`'"]|[`'"]$)/g, ''), content: m[2] });

  return blocks;
}

const LANG_EXT = {
  javascript: 'js',
  js: 'js',
  jsx: 'jsx',
  typescript: 'ts',
  ts: 'ts',
  tsx: 'tsx',
  json: 'json',
  python: 'py',
  py: 'py',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  hpp: 'cpp',
  html: 'html',
  css: 'css',
  bash: 'sh',
  sh: 'sh',
  shell: 'sh',
  markdown: 'md',
  md: 'md',
  yaml: 'yaml',
  yml: 'yaml',
};

/** File extension (no dot) for a fenced-code-block language tag, "txt" for anything unrecognized/empty. */
export function extensionFor(lang) {
  return LANG_EXT[(lang || '').toLowerCase()] ?? 'txt';
}

/**
 * Every fenced code block in `text` that ISN'T claimed by a "File:" label
 * (extractFileBlocks() above) - the "never miss a file in a response"
 * fallback for a reply that includes unlabeled code. Returned as
 * `{ lang, content }` in reply order; callers (saveAllBlocks() below)
 * assign the actual output path.
 */
export function extractAnonymousBlocks(text) {
  const namedRanges = [];
  let m;

  FILE_BLOCK_RE.lastIndex = 0;
  while((m = FILE_BLOCK_RE.exec(text))) namedRanges.push([m.index, m.index + m[0].length]);

  const blocks = [];

  FENCE_RE.lastIndex = 0;
  while((m = FENCE_RE.exec(text))) {
    if(namedRanges.some(([start, end]) => m.index >= start && m.index < end)) continue;
    blocks.push({ lang: m[1], content: m[2] });
  }

  return blocks;
}

function mkdirp(dir) {
  if(!dir || dir === '.' || dir === '/') return;

  const [st] = stat(dir);
  if(st) return;

  mkdirp(dir.slice(0, dir.lastIndexOf('/')));
  mkdir(dir);
}

/** Rejects paths that would escape `root` (`../..`, an absolute path, ...). */
function isSafeRelativePath(path) {
  if(path.startsWith('/') || path.startsWith('~')) return false;

  const parts = path.split('/');
  let depth = 0;

  for(const part of parts) {
    if(part === '..') {
      depth--;
      if(depth < 0) return false;
    } else if(part !== '.' && part !== '') {
      depth++;
    }
  }

  return true;
}

/**
 * Writes every block from `extractFileBlocks()` under `root`, creating
 * parent directories as needed. Returns `{ written, rejected }` - paths
 * that fail `isSafeRelativePath()` are reported in `rejected` and never
 * touch the filesystem.
 *
 * @param {import('./file-exchange.js').FileExchange} [fileExchange] - if
 *   given, each path's old-vs-new diff is recorded (see
 *   FileExchange#recordReceived()) *before* it's overwritten.
 */
export async function saveFileBlocks(blocks, root = '.', fileExchange) {
  const written = [];
  const rejected = [];

  for(const { path, content } of blocks) {
    if(!isSafeRelativePath(path)) {
      rejected.push(path);
      continue;
    }

    if(fileExchange) await fileExchange.recordReceived(path, content);

    const full = root === '.' ? path : `${root}/${path}`;
    const dir = full.includes('/') ? full.slice(0, full.lastIndexOf('/')) : null;

    if(dir) mkdirp(dir);

    const f = fopen(full, 'w');
    if(!f) {
      rejected.push(path);
      continue;
    }

    f.puts(content);
    f.close();
    written.push(path);
  }

  return { written, rejected };
}

/**
 * Saves *every* code block in a reply - "File:"-labeled ones under their
 * given path, and any remaining unlabeled fenced block (see
 * extractAnonymousBlocks() above) under an auto-assigned
 * "<model>-output-N.ext" path from `sentFiles` (lib/sent-files.js) - so a
 * reply never silently drops code the model produced just because it
 * didn't follow the "File:" convention for it. Every path actually
 * written (named or auto-named) is registered with `sentFiles.add()`.
 */
export async function saveAllBlocks(reply, { root = '.', sentFiles, fileExchange } = {}) {
  const named = extractFileBlocks(reply);
  const anonymous = extractAnonymousBlocks(reply).map(({ lang, content }) => ({
    path: sentFiles.nextOutputPath(extensionFor(lang)),
    content,
  }));

  const { written, rejected } = await saveFileBlocks([...named, ...anonymous], root, fileExchange);

  for(const path of written) sentFiles.add(path);

  return { written, rejected };
}
