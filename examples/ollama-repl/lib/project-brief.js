/**
 * project-brief: collects what a project says about itself (CLAUDE.md,
 * README, TODO, BUGS, ChangeLog, doc/, the other text files) and its tree,
 * and has a local Ollama instruct model condense it to a size chosen for
 * the model that will read it. Used by /brief (repl.js); nothing here talks
 * to the model that does the coding.
 *
 * ```js
 * const size = briefSize(16384);                               // characters for a 16k-token window
 * const { brief, files } = await buildBrief(root, { size, model: 'qwen3:4b-instruct', onProgress: console.log });
 * ```
 *
 * The tree is rendered here, not by the model: a small model cannot be
 * trusted to copy a listing, so the tree is cut to its share of the size by
 * making it shallower. The documents are condensed by the model, each to
 * its share, then (when the shares still add up to more than the size) all
 * together; a document that is already short is kept as it is. The
 * result is cached per project (keyed by size, model and the files'
 * mtimes and sizes), so /brief on an unchanged project is free.
 */
import { loadFile } from 'std';
import { stat } from 'os';
import { OllamaClient } from './ollama-client.js';
import { HANDOFF_MODEL } from './handoff.js';
import { runCommand } from './run-command.js';
import { SKIP_DIRS } from './match.js';
import { configDir, writeConfigFile } from './config.js';

const CHUNK_CHARS = 10000;
const MAX_FILES = 40;
const READ_CHARS = 40000;

/** characters of brief for a context window of `ctxTokens`: about 8% of it, between 1500 and 12000 */
export function briefSize(ctxTokens) {
  return Math.max(1500, Math.min(12000, Math.round(ctxTokens * 3.5 * 0.08)));
}

/** the project's files: git's list (tracked and untracked, not ignored), else a walk of the tree */
export async function listFiles(root) {
  const { output, status } = await runCommand('git ls-files -co --exclude-standard', { cwd: root });
  if(status === 0 && output.trim()) return output.split('\n').filter(Boolean);

  const { output: found } = await runCommand(`find . -type f ${[...SKIP_DIRS].map(d => `-not -path '*/${d}/*'`).join(' ')} | head -5000`, { cwd: root });
  return found
    .split('\n')
    .filter(Boolean)
    .map(p => p.replace(/^\.\//, ''));
}

const NAMED = /(^|\/)(CLAUDE|AGENTS|README|TODO|BUGS|CHANGELOG|ChangeLog|NOTES|HACKING|CONTRIBUTING|ARCHITECTURE|DESIGN)[^/]*$/;
const NOISE = /(^|\/)(\d{4}-\d\d-\d\d-[^/]*|[^/]*\.log|[^/]*lock[^/]*|CMakeCache\.txt)$/;

/** the text and doc files worth reading, the ones that describe the project first */
export function pickDocs(paths) {
  const rank = p => (/(^|\/)(CLAUDE|AGENTS)[^/]*$/.test(p) ? 0 : /(^|\/)README/.test(p) ? 1 : /(^|\/)(TODO|BUGS)/.test(p) ? 2 : NAMED.test(p) ? 3 : /^docs?\//.test(p) ? 4 : 5);
  const text = p => (/\.(md|txt|rst|markdown)$/i.test(p) || NAMED.test(p)) && !NOISE.test(p);

  return paths
    .filter(text)
    .map(p => [rank(p), p.split('/').length, p])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : 1))
    .map(x => x[2])
    .slice(0, MAX_FILES);
}

/** the directory tree of `paths` as indented text, at most `maxChars` (shallower until it fits) */
export function renderTree(paths, maxChars) {
  const root = { dirs: new Map(), files: [] };

  for(const p of paths) {
    const parts = p.split('/');
    let n = root;
    for(const d of parts.slice(0, -1)) {
      if(!n.dirs.has(d)) n.dirs.set(d, { dirs: new Map(), files: [] });
      n = n.dirs.get(d);
    }
    n.files.push(parts[parts.length - 1]);
  }

  const count = n => n.files.length + [...n.dirs.values()].reduce((a, d) => a + count(d), 0);

  const draw = (n, depth, maxDepth, indent, out) => {
    const dirs = [...n.dirs].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    for(const [name, d] of dirs) {
      out.push(`${indent}${name}/ (${count(d)} files)`);
      if(depth < maxDepth) draw(d, depth + 1, maxDepth, `${indent}  `, out);
    }

    const files = n.files.sort();
    for(const f of files.slice(0, 12)) out.push(`${indent}${f}`);
    if(files.length > 12) out.push(`${indent}... +${files.length - 12} more files`);
  };

  let text = '';
  for(let depth = 3; depth >= 0; depth--) {
    const out = [];
    draw(root, 0, depth, '', out);
    text = out.join('\n');
    if(text.length <= maxChars) return text;
  }

  return `${text.slice(0, maxChars)}\n...`;
}

/** one local-model call: `text` condensed to about `chars` characters */
async function once(client, text, chars, what) {
  const { content } = await client.chat([
    { role: 'system', content: 'You condense project documentation for another assistant that has not seen it. Reply with the condensed text only, no preface.' },
    { role: 'user', content: `Condense this ${what} to at most ${chars} characters of plain text. Keep exact names (files, functions, commands, options, error messages), decisions, conventions and open tasks. Drop prose, examples, repetition and anything that only sells the project.\n\n${text}` },
  ]);

  return content?.trim() || null;
}

/** cuts text to `chars` at a line end where possible */
const cut = (text, chars) => {
  if(text.length <= chars) return text;
  const at = text.lastIndexOf('\n', chars);
  return `${text.slice(0, at > chars * 0.6 ? at : chars).trimEnd()}\n...`;
};

/**
 * `text` condensed to about `chars` characters, in chunks and passes when it is longer than one call takes;
 * a small model overshoots, so the result is cut to the size in the end. null if the model fails
 */
export async function condense(client, text, chars, what) {
  for(let pass = 0; text.length > chars * 1.25 && pass < 4; pass++) {
    if(text.length <= CHUNK_CHARS) {
      const s = await once(client, text, chars, what);
      if(s === null) return null;
      text = s;
      continue;
    }

    const parts = [];
    for(let i = 0; i < text.length; i += CHUNK_CHARS) parts.push(text.slice(i, i + CHUNK_CHARS));

    const each = Math.max(300, Math.floor((chars * CHUNK_CHARS) / text.length));
    const sums = [];
    for(const part of parts) {
      const s = await once(client, part, each, what);
      if(s === null) return null;
      sums.push(s);
    }

    text = sums.join('\n\n');
  }

  return cut(text, Math.round(chars * 1.25));
}

/* a short string for a cache key */
const hash = s => {
  let h = 5381;
  for(let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

const cachePath = root => `${configDir()}/brief-${hash(root)}.json`;

/** the last brief built for this project, null if there is none */
export function lastBrief(root) {
  try {
    return JSON.parse(loadFile(cachePath(root)));
  } catch(e) {
    return null;
  }
}

/**
 * @param {string} root
 * @param {object} o
 * @param {number} o.size        characters of brief
 * @param {string} [o.model]     the local condenser
 * @param {string} [o.host]
 * @param {number} [o.port]
 * @param {boolean} [o.refresh]  ignore the cache
 * @param {(line: string) => void} [o.onProgress]
 * @param {(stop: () => void) => void} [o.register]  gets a function that aborts the running model call
 * @param {(client: OllamaClient) => void} [o.onClient]  gets the client of the condenser model before its first call (to watch its traffic)
 * @returns {Promise<{brief: string, files: number, cached: boolean, by: string}|null>} null if the condenser model could not be reached
 */
export async function buildBrief(root, { size, model = HANDOFF_MODEL, host = 'localhost', port = 11434, refresh = false, onProgress = () => {}, register = () => {}, onClient = () => {} } = {}) {
  const paths = await listFiles(root);
  const docs = pickDocs(paths);
  const abs = p => (root === '.' ? p : `${root}/${p}`);

  const sig = hash(JSON.stringify([size, model, paths.length, docs.map(p => [p, (stat(abs(p))[0] ?? {}).mtime, (stat(abs(p))[0] ?? {}).size])]));
  const cached = lastBrief(root);
  if(!refresh && cached?.sig === sig) return { brief: cached.brief, files: docs.length, cached: true, by: cached.by };

  const client = new OllamaClient({ host, port, model, think: false, numCtx: 8192, temperature: 0.2, timeoutSecs: 240 });

  register(() => client.abort());
  onClient(client);

  try {
    const tree = renderTree(paths, Math.round(size * 0.3));
    const budget = size - tree.length;
    const each = Math.max(250, Math.min(2500, Math.round((budget * 1.6) / Math.max(1, docs.length))));
    const sections = [];

    for(const [i, p] of docs.entries()) {
      const full = (loadFile(abs(p)) ?? '').slice(0, READ_CHARS).trim();
      if(!full) continue;

      if(full.length <= each * 1.3) {
        sections.push(`## ${p}\n${full}`);
        continue;
      }

      onProgress(`brief: ${p} (${i + 1}/${docs.length}, ${full.length} chars)`);
      const s = await condense(client, full, each, `file ${p}`);
      if(s === null) return null;
      sections.push(`## ${p}\n${s}`);
    }

    let body = sections.join('\n\n');

    if(body.length > budget) {
      onProgress(`brief: condensing all ${sections.length} documents together (${body.length} -> ${budget} chars)`);
      const all = await condense(client, body, budget, 'set of project documents (each starts with ## FILENAME, keep those headings)');
      if(all === null) return null;
      body = all;

      /* still over: every document gets an equal cut, so none is lost to the end of the text */
      if(body.length > budget * 1.25) {
        const per = Math.floor(budget / sections.length);
        body = sections.map(x => cut(x, per)).join('\n\n');
      }
    }

    const brief = `Project brief (condensed by ${model} from ${docs.length} documents; read the real files for detail)\n\nLayout:\n${tree}\n\n${body}`;
    writeConfigFile(cachePath(root), JSON.stringify({ sig, brief, by: model, at: Date.now() }));

    return { brief, files: docs.length, cached: false, by: model };
  } catch(e) {
    return null;
  } finally {
    client.destroy();
  }
}
