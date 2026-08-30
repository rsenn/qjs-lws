/**
 * Runs a shell command/script (via `shish -c` if `shish` is on PATH,
 * otherwise `/bin/sh -c` - see #resolveShell() below) - `-c` takes one
 * argument, an arbitrary script (multi-line, heredocs, pipes, `find`/
 * `xargs`/`head`/`tail`, ...), not just a single command line - and
 * captures its combined stdout+stderr, for the `run_command` tool (see
 * lib/tool-requests.js).
 *
 * Polls the child's exit with os.waitpid(pid, os.WNOHANG) on a short
 * timer instead of os.setReadHandler() on the output pipe - confirmed by
 * direct testing that the latter is unreliable here: the handler fires
 * once when the first output arrives, but never fires again for EOF even
 * after the child has long since exited, hanging forever. waitpid(WNOHANG)
 * has no such issue. The output itself is only read once the child has
 * exited (so the pipe's write end is closed and read() reaches real EOF
 * without blocking) - fine for this channel's actual use (short-lived
 * dev commands with bounded output), at the cost of a small deadlock risk
 * if a command emits more than the OS pipe buffer (~64KB, comfortably
 * above MAX_OUTPUT_BYTES below) *before* exiting.
 */
import { close, exec, kill, pipe, read, setReadHandler, setTimeout, waitpid, WNOHANG } from 'os';
import { toString } from 'lws.so';

const MAX_OUTPUT_BYTES = 32 * 1024;
const POLL_MS = 40;
const SIGKILL = 9;

/* Resolved once, lazily, and cached: `['shish', '-c']` if a `shish`
   binary is reachable via PATH, else `['/bin/sh', '-c']`. `exec()` with
   `usePath` (the default) doesn't throw for a missing binary - the child
   fails to execvp and exits with status 127, same convention a real shell
   itself uses for "command not found" (confirmed directly: a blocking
   `exec(['shish', '-c', 'exit 0'])` against a real shish/PATH combo
   returns 0, and against a nonexistent binary name returns 127) - so a
   plain exit-code check is enough to probe for it, no PATH-directory
   scanning needed. */
let shellArgv;

function resolveShell() {
  if(shellArgv) return shellArgv;

  shellArgv = exec(['shish', '-c', 'exit 0'], { block: true }) === 0 ? ['shish', '-c'] : ['/bin/sh', '-c'];
  return shellArgv;
}

/**
 * @param {string} cmd
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ output: string, status: number|null, timedOut: boolean }>}
 */
export async function runCommand(cmd, { cwd = '.', timeoutMs = 20000 } = {}) {
  const [rfd, wfd] = pipe();
  const pid = exec([...resolveShell(), cmd], { block: false, stdout: wfd, stderr: wfd, cwd });

  close(wfd);

  const deadline = Date.now() + timeoutMs;
  let timedOut = false;
  let status = null;

  for(;;) {
    if(!timedOut && Date.now() > deadline) {
      timedOut = true;

      try {
        kill(pid, SIGKILL);
      } catch(e) {
        /* already exited */
      }
    }

    const [rpid, st] = waitpid(pid, timedOut ? 0 : WNOHANG);

    if(rpid === pid) {
      status = st;
      break;
    }

    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }

  let out = '';
  const buf = new Uint8Array(4096);

  for(;;) {
    const n = read(rfd, buf.buffer, 0, buf.length);
    if(n <= 0) break;

    out += toString(buf.buffer.slice(0, n));

    if(out.length > MAX_OUTPUT_BYTES) {
      out = out.slice(0, MAX_OUTPUT_BYTES) + '\n... (truncated)';
      break;
    }
  }

  close(rfd);

  return { output: timedOut ? `${out}\n... (timed out after ${timeoutMs}ms, process killed)` : out, status, timedOut };
}
