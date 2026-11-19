/**
 * Native tool schemas (`TOOLS`, passed as `tools` to client.chat()/
 * chatStream() - see API.md) and their execution (`executeTool()`), for
 * the tool-calling loop in repl.js (`runToolLoop()`) - replaces the
 * earlier LIST:/READ:/RUN: plain-text-in-the-reply-body protocol with
 * real, provider-native function calling.
 */
import { stat, S_IFREG } from 'os';
import { loadFile } from 'std';
import { walk, fileMode } from './match.js';
import { runCommand } from './run-command.js';
import { qjsProjectDirs } from './reference-files.js';

const LISTABLE_EXT = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'c', 'h', 'cpp', 'hpp', 'html', 'css', 'md', 'cmake', 'txt', 'sh']);
const MAX_READ_BYTES = 64 * 1024;
const MAX_LIST_ENTRIES = 300;

function isListable(name) {
  const base = name.slice(name.lastIndexOf('/') + 1);
  if(/^readme/i.test(base)) return true;

  const ext = base.slice(base.lastIndexOf('.') + 1).toLowerCase();
  return LISTABLE_EXT.has(ext);
}

/** Every listable (JS/C/HTML/CSS/Markdown + README*) file under `dir` (relative to `root`), sorted. */
export function listFiles(dir, root) {
  const base = dir ? (root === '.' ? dir : `${root}/${dir}`) : root;
  const out = [];

  const filetime = (f, t = 'mtime') => stat(f)?.[0][t];

  for(const path of walk(base, root)) {
    const rel = root === '.' ? path : path.slice(root.length + 1);
    if(isListable(rel)) out.push([filetime(path), rel]);
    if(out.length >= MAX_LIST_ENTRIES) break;
  }

  return out.sort((a, b) => b[0] - a[0]).map(([tm, fn]) => fn);
}

/**
 * If `arg` names (or starts with, path-fashion) a sibling "qjs-*" project
 * (reference-files.js's `qjsProjectDirs()`), resolves it against that
 * project's own directory instead of `root` - so `list_directory`/
 * `read_file` with "qjs-modules" or "qjs-modules/quickjs-archive.c" reach
 * into the sibling project the same way they already reach into this one.
 * Falls back to `root` unchanged for anything that isn't a known project
 * name.
 */
function resolveBase(arg, root) {
  const slash = arg.indexOf('/');
  const name = slash === -1 ? arg : arg.slice(0, slash);
  const dir = qjsProjectDirs(root).get(name);

  if(dir == null) return { base: root, rel: arg, prefix: '' };

  return { base: dir, rel: slash === -1 ? '' : arg.slice(slash + 1), prefix: name };
}

function readFile(path, root) {
  const full = root === '.' ? path : `${root}/${path}`;

  if(fileMode(full) !== S_IFREG) return null;

  const content = loadFile(full);
  if(content == null) return null;

  return content.length > MAX_READ_BYTES ? content.slice(0, MAX_READ_BYTES) + '\n... (truncated)' : content;
}

/** `{ name, description, parameters }` triples - see API.md's shared
    message/tool-use format; passed straight through to whichever wire
    shape a given client needs (OllamaClient#toTools()/OpenAIClient#toTools()/
    GeminiClient's functionDeclarations wrapping). */
export const TOOLS = [
  {
    name: 'list_directory',
    description: 'Recursively lists source files and README* under a directory in the project tree (or a sibling "qjs-*" reference project checked out alongside it, e.g. "qjs-modules").',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Directory path relative to the project root, or a sibling "qjs-*" project name (e.g. "." or "lib" or "qjs-modules")' },
      },
      required: ['dir'],
    },
  },
  {
    name: 'read_file',
    description: 'Reads the contents of one file (path relative to the project root, or "qjs-*/..." into a sibling reference project).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to read, e.g. "src/main.c" or "qjs-modules/doc/js/fs.md"' },
      },
      required: ['path'],
    },
  },
  {
    name: 'run_command',
    description:
      "Runs a shell script in the project root and returns its combined stdout+stderr and exit code. This is a real shell (`shish -c '<script>'`, or `sh -c` if shish isn't installed) - not a single fixed command - so it accepts a whole multi-line script: pipes, `find`/`xargs`/`grep`/`head`/`tail`, `cat <<EOF > file` heredocs to write out a throwaway test file, `&&`/`;` to chain steps, etc. Typical uses: `git status`/`git diff`/`git log` to see what's actually changed; a heredoc + `qjsm -e` or `qjsm <path>` to write and run a small script that checks whether some API/behavior actually exists or works before writing it into a real file; a standalone `gcc -shared -fPIC ...` compile + smoke test for a native binding, instead of guessing it will work. You'll be asked to approve each script before it runs.",
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell script to execute - one line or many' },
      },
      required: ['command'],
    },
  },
  {
    name: 'ask_user',
    description: 'Asks the human user a clarifying question and waits for their typed answer - use when scope is ambiguous, a change looks destructive, or information is missing that only the user has, instead of guessing.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask the user' },
      },
      required: ['question'],
    },
  },
];

/**
 * Executes one tool call and returns its result as a string (the `tool`
 * message's `content` - see API.md).
 *
 * @param {string} name
 * @param {object} args
 * @param {string} root
 * @param {(cmd: string) => Promise<boolean>} [confirmRun] - asked before a
 *   `run_command` call actually executes; a declined script is reported
 *   back to the model as declined, not run. Omit to run unconditionally
 *   (used for repl.js's own startup project-scan reads, which never call
 *   `run_command` in the first place).
 * @param {(question: string) => Promise<string>} [askUser] - asked for
 *   `ask_user` calls; omit where there's no user to ask (same startup-scan
 *   case as `confirmRun`).
 */
export async function executeTool(name, args, root, confirmRun, askUser) {
  if(name === 'list_directory') {
    const dir = args.dir === '.' || !args.dir ? '' : args.dir;
    const { base, rel, prefix } = resolveBase(dir, root);
    const files = listFiles(rel, base).map(f => (prefix ? `${prefix}/${f}` : f));
    return files.length ? files.join('\n') : '(no matching files)';
  }

  if(name === 'read_file') {
    const { base, rel } = resolveBase(args.path, root);
    const content = readFile(rel, base);
    return content == null ? '(not found, or not a regular file)' : content;
  }

  if(name === 'run_command') {
    if(confirmRun && !(await confirmRun(args.command))) return '(declined by user - not executed)';

    const { output, status, timedOut } = await runCommand(args.command, { cwd: root });
    return `(exit ${status}${timedOut ? ', timed out' : ''})\n${output || '(no output)'}`;
  }

  if(name === 'ask_user') {
    if(!askUser) return '(no user prompt mechanism available)';
    return await askUser(args.question);
  }

  return `unknown tool: ${name}`;
}
