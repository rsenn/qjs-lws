import { isatty } from 'os';
import { out as stdout } from 'std';

/* stdout is not a tty: a script or LLM drives the REPL over a pipe (see the
   REPL's "Piped mode"), so output carries no escape sequences. Same test as
   the base REPL's own `piped`. */
export const piped = !isatty(stdout.fileno());

const sgr = code => (piped ? s => s : s => `\x1b[${code}m${s}\x1b[0m`);

export const dim = sgr('2');
export const red = sgr('31');
export const green = sgr('32');
export const yellow = sgr('33');
