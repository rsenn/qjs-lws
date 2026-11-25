/**
 * palette: every color of the ollama-repl TUI as a '#rrggbb' string, in
 * one place. look.js (panels, notes, tool lines) and rawcolor.js (the raw
 * content of Ctrl-O verbose mode) take their colors from here; nothing
 * else is defined in this file.
 *
 * ```js
 * import { ACCENT, TEAL } from './palette.js';
 * ```
 */

/** gradient of the look.js widgets, the accent is its first stop */
export const STOPS = ['#2dd4bf', '#a3e635', '#fbbf24'];
export const ACCENT = STOPS[0];
export const WARN = STOPS[2];

/** generic highlighter: file names, token counts, sizes, times, other numbers, arrows */
export const FILE = '#ffcc00';
export const TOKENS = '#38bdf8';
export const SIZES = '#a78bfa';
export const TIMES = '#fba000';
export const NUMBERS = '#fdba74';
export const ARROWS = '#a3e635';

/** text, errors and the dark grey of a line that came over the control socket */
export const TEXT = '#cbd5e1';
export const ERROR = '#f87171';
export const REMOTE = '#8a8a8a';

/** shell command syntax: quoted strings, operators, variables, paths */
export const SHELL_STRING = '#86efac';
export const SHELL_OP = '#f472b6';
export const SHELL_VAR = '#c084fc';
export const SHELL_PATH = '#fde68a';

/** a color per kind of tool: looking is green and blue, changing red and amber, running pink, talking violet */
export const TOOL_COLORS = {
  read_file: '#3ed610',
  list_directory: '#10a0ff',
  grep: '#3e6efa',
  write_file: '#b40035',
  edit_file: '#ff8000',
  insert_above: '#cec03f',
  run_command: '#e52087',
  ask_user: '#8d1fff',
  for_each: '#96c507',
  spawn_agent: '#6148ff',
};

/** raw content: teal keys, lime strings, amber numbers, violet literals, green and red diff lines */
export const TEAL = '#1f8181';
export const LIME = '#67ff00';
export const AMBER = '#d9a51f';
export const VIOLET = '#651dff';
export const GREEN = '#07923a';
export const RED = '#f83171';
export const SKYBLUE = '#a9d8ea';

/** beach / balearic theme: panel border, header, hints */
export const BORDER = '#a000ff';
export const HEADER = '#ffcc00';
export const HINT = '#9C8F7E';

/** prose, inline code and code fences of the reasoning text */
export const PROSE = '#999999';
export const INLINE_CODE = '#5080ff';
export const CODE_FENCE = '#4040FF';

/** strings in fenced code, background shading of a fence */
export const CODE_STRING = '#F2CC8F';
export const CODE_BG = '#0f292e';

/** name of the theme above */
export const THEME = 'beach / balearic';
