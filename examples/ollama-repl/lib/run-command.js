/**
 * Runs a shell command/script (via `shish -c` if `shish` is on PATH,
 * otherwise `/bin/sh -c` - see #resolveShell() below) - `-c` takes one
 * argument, an arbitrary script (multi-line, heredocs, pipes, `find`/
 * `xargs`/`head`/`tail`, ...), not just a single command line - and
 * captures its combined stdout+stderr, for the `run_command` tool (see
 * lib/agent/tool-requests.js).
 *
 * The output goes to an unlinked temporary file, not to a pipe. Reading a
 * pipe to EOF blocks while any descendant of the shell still holds its write
 * end (`ss ... | grep` after the shell was killed on a timeout, `cmd &`), and
 * a blocking read stops the whole single-threaded REPL; a file is read to its
 * end at once whatever is still running. A pipe also stopped a command that
 * wrote more than its buffer (~64KB) before exiting. The child's exit is
 * polled with os.waitpid(pid, os.WNOHANG) on a short timer.
 */
import { close, exec, kill, open, read, remove, seek, setTimeout, waitpid, WNOHANG, O_CREAT, O_EXCL, O_RDWR } from 'os';
import { getenv } from 'std';
import { toString } from 'lws.so';

const MAX_OUTPUT_BYTES = 32 * 1024;
/* a command that writes more than this is killed: the file would fill the disk */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const POLL_MS = 40;
const SIGKILL = 9;
const SEEK_SET = 0;
const SEEK_END = 2;

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

let counter = 0;

/** a read-write file that is already unlinked: gone when the last holder closes it */
function scratchFile() {
  const dir = getenv('XDG_RUNTIME_DIR') || getenv('TMPDIR') || '/tmp';
  const path = `${dir}/ollama-repl-cmd-${Date.now()}-${counter++}`;
  const fd = open(path, O_RDWR | O_CREAT | O_EXCL, 0o600);

  if(fd < 0) throw new Error(`cannot create ${path}`);

  remove(path);
  return fd;
}

/**
 * @param {string} cmd
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ output: string, status: number|null, timedOut: boolean }>}
 */
export async function runCommand(cmd, { cwd = '.', timeoutMs = 20000 } = {}) {
  const fd = scratchFile();
  const pid = exec([...resolveShell(), cmd], { block: false, stdout: fd, stderr: fd, cwd });

  const deadline = Date.now() + timeoutMs;
  let timedOut = false;
  let tooBig = false;
  let status = null;

  for(;;) {
    if(!timedOut && !tooBig) {
      const over = Date.now() > deadline;
      tooBig = !over && seek(fd, 0, SEEK_END) > MAX_FILE_BYTES;

      if(over || tooBig) {
        timedOut = over;

        try {
          kill(pid, SIGKILL);
        } catch(e) {
          /* already exited */
        }
      }
    }

    const [rpid, st] = waitpid(pid, timedOut || tooBig ? 0 : WNOHANG);

    if(rpid === pid) {
      status = st;
      break;
    }

    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }

  let out = '';
  const buf = new Uint8Array(4096);

  seek(fd, 0, SEEK_SET);

  for(;;) {
    const n = read(fd, buf.buffer, 0, buf.length);
    if(n <= 0) break;

    out += toString(buf.buffer.slice(0, n));

    if(out.length > MAX_OUTPUT_BYTES) {
      out = out.slice(0, MAX_OUTPUT_BYTES) + '\n... (truncated)';
      break;
    }
  }

  close(fd);

  return { output: timedOut ? `${out}\n... (timed out after ${timeoutMs}ms, process killed)` : tooBig ? `${out}\n... (more than ${MAX_FILE_BYTES >> 20} MB of output, process killed)` : out, status, timedOut };
}
