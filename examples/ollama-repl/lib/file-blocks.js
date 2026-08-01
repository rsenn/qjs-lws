/**
 * Parses "File: path\n```lang\n...content...\n```" blocks out of an
 * assistant reply and writes them into the local project tree. This is the
 * one output convention the system prompt (repl.js) asks the model to
 * follow for any file it wants to create or modify - deliberately simple
 * and unambiguous to parse, rather than trying to guess intent from
 * arbitrary fenced code blocks.
 */
import * as os from 'os';
import * as std from 'std';

const FILE_BLOCK_RE = /^File:[ \t]*(\S+)[ \t]*\r?\n```[^\n`]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;

/** Every `{ path, content }` file block found in `text`. */
export function extractFileBlocks(text) {
  const blocks = [];
  let m;

  FILE_BLOCK_RE.lastIndex = 0;

  while((m = FILE_BLOCK_RE.exec(text))) blocks.push({ path: m[1].replaceAll(/(^[`'"]|[`'"]$)/g, ''), content: m[2] });

  return blocks;
}

function mkdirp(dir) {
  if(!dir || dir === '.' || dir === '/') return;

  const [st] = os.stat(dir);
  if(st) return;

  mkdirp(dir.slice(0, dir.lastIndexOf('/')));
  os.mkdir(dir);
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
 */
export function saveFileBlocks(blocks, root = '.') {
  const written = [];
  const rejected = [];

  for(const { path, content } of blocks) {
    if(!isSafeRelativePath(path)) {
      rejected.push(path);
      continue;
    }

    const full = root === '.' ? path : `${root}/${path}`;
    const dir = full.includes('/') ? full.slice(0, full.lastIndexOf('/')) : null;

    if(dir) mkdirp(dir);

    const f = std.open(full, 'w');
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
