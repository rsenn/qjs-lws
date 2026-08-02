/**
 * Parses LIST:/READ:/RUN: request lines out of a reply and executes them,
 * so the model can inspect the project - or run a command - before giving
 * its actual answer, instead of guessing. See the system prompt in
 * repl.js for the exact contract given to the model; repl.js's chat loop
 * is what bounds how many rounds of this run per turn (MAX_TOOL_ROUNDS).
 */
import { stat, S_IFREG } from 'os';
import { loadFile } from 'std';
import { walk, fileMode } from './match.js';
import { runCommand } from './run-command.js';

const REQUEST_RE = /^(LIST|READ|RUN):[ \t]*(.+)$/gm;

const LISTABLE_EXT = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'c', 'h', 'cpp', 'hpp', 'html', 'css', 'md', 'cmake', 'txt', 'sh']);
const MAX_READ_BYTES = 64 * 1024;
const MAX_LIST_ENTRIES = 300;

function isListable(name) {
  const base = name.slice(name.lastIndexOf('/') + 1);
  if(/^readme/i.test(base)) return true;

  const ext = base.slice(base.lastIndexOf('.') + 1).toLowerCase();
  return LISTABLE_EXT.has(ext);
}

/** Every `{ type: 'LIST'|'READ'|'RUN', arg }` request found in `text`, in order. */
export function extractRequests(text) {
  const requests = [];
  let m;

  REQUEST_RE.lastIndex = 0;
  while((m = REQUEST_RE.exec(text))) requests.push({ type: m[1], arg: m[2].trim() });

  return requests;
}

/** Every listable (JS/C/HTML/CSS/Markdown + README*) file under `dir` (relative to `root`), sorted. */
export function listFiles(dir, root) {
  const base = dir ? (root === '.' ? dir : `${root}/${dir}`) : root;
  const out = [];

  const filetime = (f, t = 'mtime') => stat(f)?.[0][t];

  for(const path of walk(base, root)) {
    const rel = root === '.' ? path : path.slice(root.length + 1);
    if(isListable(rel)) out.push([filetime(rel), rel]);
    if(out.length >= MAX_LIST_ENTRIES) break;
  }

  return out.sort((a, b) => b[0] - a[0]).map(([tm, fn]) => fn);
}

function readFile(path, root) {
  const full = root === '.' ? path : `${root}/${path}`;

  //console.log('fileMode(full)', fileMode(full), S_IFREG);

  if(fileMode(full) !== S_IFREG) return null;

  const content = loadFile(full);
  if(content == null) return null;

  return content.length > MAX_READ_BYTES ? content.slice(0, MAX_READ_BYTES) + '\n... (truncated)' : content;
}

/**
 * Runs every request against the project tree rooted at `root`, and
 * formats the results into one block of text meant to be fed straight
 * back to the model as its next turn's input (see repl.js's tool loop).
 *
 * @param {(cmd: string) => Promise<boolean>} [confirmRun] - asked before
 *   each RUN: request actually executes; a declined command is reported
 *   back to the model as declined, not run. Omit to run unconditionally
 *   (used for repl.js's own startup project-scan, which never issues
 *   RUN: requests in the first place).
 */
export async function runRequests(requests, root, confirmRun) {
  const parts = [];

  for(const { type, arg } of requests) {
    if(type === 'LIST') {
      const files = listFiles(arg === '.' || arg === '' ? '' : arg, root);
      parts.push(`LIST: ${arg}\n${files.length ? files.join('\n') : '(no matching files)'}`);
    } else if(type === 'READ') {
      const content = readFile(arg, root);
      parts.push(content == null ? `READ: ${arg}\n(not found, or not a regular file)` : `READ: ${arg}\n\`\`\`\n${content}\n\`\`\``);
    } else if(type === 'RUN') {
      if(confirmRun && !(await confirmRun(arg))) {
        parts.push(`RUN: ${arg}\n(declined by user - not executed)`);
        continue;
      }

      const { output, status, timedOut } = await runCommand(arg, { cwd: root });
      parts.push(`RUN: ${arg}\n(exit ${status}${timedOut ? ', timed out' : ''})\n\`\`\`\n${output || '(no output)'}\n\`\`\``);
    }
  }

  return parts.join('\n\n');
}
