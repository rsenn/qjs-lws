/**
 * Native tool schemas (`TOOLS`, passed as `tools` to client.chat()/
 * chatStream() - see API.md) and their execution (`executeTool()`), for
 * the tool-calling loop in repl.js (`runToolLoop()`) - replaces the
 * earlier LIST:/READ:/RUN: plain-text-in-the-reply-body protocol with
 * real, provider-native function calling.
 */
import { stat, remove, S_IFREG } from 'os';
import { loadFile, open as fopen } from 'std';
import { walk, fileMode } from './match.js';
import { runCommand } from './run-command.js';
import { qjsProjectDirs } from './reference-files.js';

const LISTABLE_EXT = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'c', 'h', 'cpp', 'hpp', 'html', 'css', 'md', 'cmake', 'txt', 'sh']);
const MAX_READ_BYTES = 16 * 1024;
const MAX_GREP_LINES = 60;
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

/** Lines `start`..`end` (1-based, inclusive; both optional) of a file. */
function readFile(path, root, start, end) {
  const full = root === '.' ? path : `${root}/${path}`;

  if(fileMode(full) !== S_IFREG) return null;

  let content = loadFile(full);
  if(content == null) return null;

  if(start || end) {
    const lines = content.split('\n');
    const a = Math.max(1, +start || 1);
    const b = Math.min(lines.length, +end || lines.length);
    return `(lines ${a}-${b} of ${lines.length})\n${lines.slice(a - 1, b).join('\n')}`;
  }

  return content.length > MAX_READ_BYTES ? content.slice(0, MAX_READ_BYTES) + `\n... (truncated at ${MAX_READ_BYTES} bytes of ${content.length} - read the rest with start/end line numbers)` : content;
}

/** Path inside `root` that a tool may write: relative, no "..". Returns the full path or null. */
function writablePath(path, root) {
  if(typeof path !== 'string' || !path) return null;
  if( path.startsWith('/') || path.split('/').includes('..')) return null;
  return root === '.' ? path : `${root}/${path}`;
}

const pathError = path => (path ? `error: ${path}: path must be relative to the project root and must not contain ".."` : 'error: the path argument is missing - give the file to change, e.g. path: "lib/path.h"');

/* Original content (null = file did not exist) of every file written since
   the last resetJournal(), first write wins - what /undo restores. */
const journal = new Map();

export const resetJournal = () => journal.clear();
export const journalPaths = () => [...journal.keys()];

export function undoJournal() {
  const paths = journalPaths();

  for(const [full, original] of journal) {
    if(original === null) remove(full);
    else writeFile(full, original, false);
  }

  journal.clear();
  return paths;
}

function writeFile(full, content, record = true) {
  if(record && !journal.has(full)) journal.set(full, fileMode(full) === S_IFREG ? loadFile(full) : null);

  const f = fopen(full, 'w');
  if(!f) return false;
  f.puts(content);
  f.close();
  return true;
}

const shellQuote = s => `'${String(s).replaceAll("'", "'\\''")}'`;

/** Inserts `text` as new line(s) directly above the (unique) line containing `anchor`. */
function insertAbove({ path, anchor, text }, root) {
  const full = writablePath(path, root);
  if(!full) return pathError(path);
  if(typeof anchor !== 'string' || !anchor || typeof text !== 'string') return 'error: anchor (text of the line to insert above) and text are required';
  if(fileMode(full) !== S_IFREG) return `error: ${path} not found`;

  const content = loadFile(full);
  const at = content.indexOf(anchor);

  if(at === -1) return `error: anchor not found in ${path} - it must match the file exactly; read_file the relevant lines again`;
  if(content.indexOf(anchor, at + 1) !== -1) return `error: anchor occurs more than once in ${path} - use more of the line to make it unique`;

  const lineStart = content.lastIndexOf('\n', at - 1) + 1;
  const insert = text.endsWith('\n') ? text : text + '\n';

  if(!writeFile(full, content.slice(0, lineStart) + insert + content.slice(lineStart))) return `error: cannot write ${path}`;

  return `inserted ${insert.split('\n').length - 1} line(s) into ${path} above the line containing the anchor`;
}

/** Exact-text replacement of `oldStr` by `newStr` in one file; the match must be unique. */
function editFile({ path, old_string: oldStr, new_string: newStr }, root) {
  const full = writablePath(path, root);
  if(!full) return pathError(path);
  if(typeof oldStr !== 'string' || !oldStr) return 'error: old_string is required (the exact existing text to replace)';
  if(typeof newStr !== 'string') return 'error: new_string is required';
  if(fileMode(full) !== S_IFREG) return `error: ${path} not found - use write_file to create a new file`;

  const content = loadFile(full);
  const first = content.indexOf(oldStr);

  if(first === -1) return `error: old_string not found in ${path} - it must match the file exactly (whitespace included); read_file the relevant lines again`;

  if(content.indexOf(oldStr, first + 1) !== -1) return `error: old_string occurs more than once in ${path} - include more surrounding lines so it is unique`;

  if(!writeFile(full, content.slice(0, first) + newStr + content.slice(first + oldStr.length))) return `error: cannot write ${path}`;

  const count = s => s.split('\n').length;

  /* Lines of old_string that no longer exist in new_string: a small model
     "inserting" by replacing a span routinely drops neighbouring lines (a
     declaration, a closing brace) without noticing. Say so in the result. */
  const kept = new Set(newStr.split('\n').map(l => l.trim()));
  const dropped = oldStr.split('\n').filter(l => l.trim() && !kept.has(l.trim()));
  const warning = dropped.length
    ? `\nWARNING: this edit REMOVED ${dropped.length} line(s):\n${dropped.slice(0, 6).join('\n')}\nIf that was not intended, put them back now (insert_above).`
    : '';

  return `edited ${path}: ${count(oldStr)} line(s) replaced by ${count(newStr)}${warning}`;
}

/** `{ name, description, parameters }` triples - see API.md's shared
    message/tool-use format; passed straight through to whichever wire
    shape a given client needs (OllamaClient#toTools()/OpenAIClient#toTools()/
    GeminiClient's functionDeclarations wrapping). */
export const TOOLS = [
  {
    name: 'list_directory',
    description: 'Lists the source files (and README*) under a directory, recursively, newest first.',
    parameters: {
      type: 'object',
      properties: { dir: { type: 'string', description: 'Directory relative to the project root, e.g. "." or "lib/path"' } },
      required: ['dir'],
    },
  },
  {
    name: 'read_file',
    description: 'Reads a file (path relative to the project root). Optionally only lines start..end (1-based) - use that for big files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'e.g. "lib/path.h"' },
        start: { type: 'integer', description: 'first line to read (optional)' },
        end: { type: 'integer', description: 'last line to read (optional)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'grep',
    description: 'Searches files for a regular expression (grep -rn); returns "file:line:text" matches.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'regular expression' },
        path: { type: 'string', description: 'file or directory to search, default "."' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'insert_above',
    description: 'Inserts new line(s) directly above an existing line of a file, e.g. a comment above a function declaration. Nothing existing is changed or removed. anchor must identify that line (copy it, or its beginning, from read_file) and occur exactly once in the file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'file to edit, relative to the project root' },
        anchor: { type: 'string', description: 'text of the existing line to insert above (unique in the file)' },
        text: { type: 'string', description: 'the new line(s) to insert' },
      },
      required: ['path', 'anchor', 'text'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Edits an existing file by replacing old_string with new_string. old_string must be the exact existing text (copy it from read_file) and must occur exactly once - include a neighbouring line to make it unique. To only add lines, use insert_above instead. Changes are applied immediately.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'file to edit, relative to the project root' },
        old_string: { type: 'string', description: 'exact text to replace (unique in the file)' },
        new_string: { type: 'string', description: 'replacement text' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'write_file',
    description: 'Creates a new file, or completely overwrites one, with the given content. For small changes to an existing file use edit_file instead.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'file to write, relative to the project root' },
        content: { type: 'string', description: 'complete file content' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'for_each',
    description:
      'Runs the same task once for each item of a list, every item in its own fresh, short conversation (with all the file tools). Use it whenever a job repeats over many things - every function in a header, every file in a directory - instead of doing them all yourself in one go: the results are much more reliable that way. Write the task once with {item} where the item goes; each run reads the files it needs itself, so the task should say where to look.',
    parameters: {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'string' }, description: 'the items, e.g. function names or file paths' },
        task: { type: 'string', description: 'what to do for one item, e.g. "In lib/path.h add a 1-2 line comment above the declaration of {item}, based on what lib/path/{item}.c does"' },
      },
      required: ['items', 'task'],
    },
  },
  {
    name: 'run_command',
    description:
      'Runs a shell script in the project root and returns its combined stdout+stderr and exit code (sh syntax: pipes, &&, heredocs). Use it for git (status/diff/log), builds and tests. The user approves each script before it runs.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Shell script to execute - one line or many' } },
      required: ['command'],
    },
  },
  {
    name: 'ask_user',
    description: 'Asks the human user a question and waits for the typed answer - use when the task is ambiguous or information is missing that only the user has.',
    parameters: {
      type: 'object',
      properties: { question: { type: 'string', description: 'The question to ask the user' } },
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
 * @param {(items: string[], task: string) => Promise<string>} [forEach] -
 *   runs `task` once per item in fresh sub-conversations (repl.js
 *   `runForEach()`); omit inside such a sub-conversation (no nesting).
 * @param {(question: string) => Promise<string>} [askUser] - asked for
 *   `ask_user` calls; omit where there's no user to ask (same startup-scan
 *   case as `confirmRun`).
 */
export async function executeTool(name, args, root, confirmRun, askUser, forEach) {
  /* a tool that throws (e.g. a missing argument) is reported to the model
     like any other tool error, not allowed to abort the whole turn */
  try {
    return await runTool(name, args ?? {}, root, confirmRun, askUser, forEach);
  } catch(e) {
    return `error: ${name} failed: ${e.message} (check the arguments)`;
  }
}

async function runTool(name, args, root, confirmRun, askUser, forEach) {
  if(name === 'list_directory') {
    const dir = args.dir === '.' || !args.dir ? '' : String(args.dir);
    const { base, rel, prefix } = resolveBase(dir, root);
    const files = listFiles(rel, base).map(f => (prefix ? `${prefix}/${f}` : f));
    return files.length ? files.join('\n') : '(no matching files)';
  }

  if(name === 'read_file') {
    if(typeof args.path !== 'string' || !args.path) return 'error: the path argument is missing - give the file to read, e.g. path: "lib/path.h"';
    const { base, rel } = resolveBase(args.path, root);
    const content = readFile(rel, base, args.start, args.end);
    return content == null ? '(not found, or not a regular file)' : content;
  }

  if(name === 'grep') {
    if(!args.pattern) return 'error: pattern is required';

    const { output } = await runCommand(`grep -rnE -- ${shellQuote(args.pattern)} ${shellQuote(args.path || '.')} 2>&1 | head -n ${MAX_GREP_LINES}`, { cwd: root });
    return output.trim() ? output : '(no matches)';
  }

  if(name === 'for_each') {
    if(!forEach) return 'error: for_each is not available here';

    let items = args.items;
    if(typeof items === 'string') items = items.trim().startsWith('[') ? JSON.parse(items) : items.split(/[\n,]+/);
    items = (items ?? []).map(i => String(i).trim()).filter(Boolean);

    if(!items.length || typeof args.task !== 'string' || !args.task) return 'error: items (non-empty list) and task are required';

    return await forEach(items, args.task);
  }

  if(name === 'edit_file') return editFile(args, root);

  if(name === 'insert_above') return insertAbove(args, root);

  if(name === 'write_file') {
    const full = writablePath(args.path, root);
    if(!full) return pathError(args.path);
    if(typeof args.content !== 'string') return 'error: content is required';
    if(!writeFile(full, args.content)) return `error: cannot write ${args.path} (does its directory exist?)`;
    return `wrote ${args.path} (${args.content.split('\n').length} lines)`;
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
