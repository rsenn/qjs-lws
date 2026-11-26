/**
 * modes: how much the model may do without asking. Shift-Tab (or Alt-Tab)
 * cycles them, /mode NAME and --mode NAME set one.
 *
 *   mode    file changes   run_command   tools offered
 *   plan    refused        refused       read-only (list, read, grep, ask)
 *   auto    free           free          all
 *   manual  ask first      ask first     all
 *   edits   free           ask first     all              (default)
 */

/** in Shift-Tab order */
export const MODES = ['plan', 'auto', 'manual', 'edits'];

export const DEFAULT_MODE = 'edits';

/** tools that change files */
export const WRITE_TOOLS = new Set(['insert_above', 'edit_file', 'write_file']);

/** tools plan mode keeps */
export const READ_TOOLS = new Set(['list_directory', 'read_file', 'grep', 'ask_user']);

export const MODE_INFO = {
  plan: 'read-only: the model investigates and answers with a plan, changes nothing',
  auto: 'file changes and commands run without asking',
  manual: 'every file change and every command asks first',
  edits: 'file changes run, commands ask first',
};

/** SGR color per mode for the status line */
export const MODE_COLOR = { plan: '36', auto: '31', manual: '32', edits: '33' };

/** appended to a prompt sent in plan mode */
export const PLAN_NOTE =
  '\n\n(Plan mode: do not change any file and do not run commands. Investigate with the read-only tools as far as needed, then answer with a concrete step-by-step plan: which files and functions change, what the change is, and how to verify it. The user switches to an editing mode to carry it out.)';

export function nextMode(mode) {
  return MODES[(MODES.indexOf(mode) + 1) % MODES.length];
}

/** whether `name` may be offered to the model in `mode` */
export function toolAllowed(mode, name) {
  return mode !== 'plan' || READ_TOOLS.has(name);
}

/** whether a call of tool `name` must be approved by the user first */
export function needsApproval(mode, name) {
  if(mode === 'auto' || mode === 'plan') return false;
  if(name === 'run_command') return true;
  return mode === 'manual' && WRITE_TOOLS.has(name);
}

/**
 * question shown before a file change in manual mode
 *
 *   edit_file lib/a.js
 *     - old line
 *     + new line
 */
export function describeWrite(name, args) {
  const cut = (s, n = 8) => {
    const lines = String(s ?? '').split('\n');
    return lines.slice(0, n).concat(lines.length > n ? [`... (${lines.length - n} more lines)`] : []);
  };

  const head = `${name} ${args.path ?? '?'}`;
  if(name === 'edit_file') return [head, ...cut(args.old_string).map(l => `  - ${l}`), ...cut(args.new_string).map(l => `  + ${l}`)].join('\n');
  if(name === 'insert_above') return [`${head}, above: ${args.anchor ?? '?'}`, ...cut(args.text).map(l => `  + ${l}`)].join('\n');
  if(name === 'write_file') return [`${head} (${String(args.content ?? '').length} chars)`, ...cut(args.content, 5).map(l => `  + ${l}`)].join('\n');
  return head;
}
