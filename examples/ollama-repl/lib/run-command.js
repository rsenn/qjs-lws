/**
 * Runs a shell command (via `/bin/sh -c`, so the model can write an
 * ordinary command line - "npm test", "grep -rn TODO src", ...) and
 * captures its combined stdout+stderr, for the RUN: request channel (see
 * the system prompt in repl.js and lib/tool-requests.js).
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
import * as os from 'os';
import { toString } from 'lws.so';

const MAX_OUTPUT_BYTES = 32 * 1024;
const POLL_MS = 40;

/**
 * @param {string} cmd
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ output: string, status: number|null, timedOut: boolean }>}
 */
export async function runCommand(cmd, { cwd = '.', timeoutMs = 20000 } = {}) {
  const [rfd, wfd] = os.pipe();
  const pid = os.exec(['/bin/sh', '-c', cmd], { block: false, stdout: wfd, stderr: wfd, cwd });

  os.close(wfd);

  const deadline = Date.now() + timeoutMs;
  let timedOut = false;
  let status = null;

  for(;;) {
    if(!timedOut && Date.now() > deadline) {
      timedOut = true;

      try {
        os.kill(pid, os.SIGKILL);
      } catch(e) {
        /* already exited */
      }
    }

    const [rpid, st] = os.waitpid(pid, timedOut ? 0 : os.WNOHANG);

    if(rpid === pid) {
      status = st;
      break;
    }

    await new Promise(resolve => os.setTimeout(resolve, POLL_MS));
  }

  let out = '';
  const buf = new Uint8Array(4096);

  for(;;) {
    const n = os.read(rfd, buf.buffer, 0, buf.length);
    if(n <= 0) break;

    out += toString(buf.buffer.slice(0, n));

    if(out.length > MAX_OUTPUT_BYTES) {
      out = out.slice(0, MAX_OUTPUT_BYTES) + '\n... (truncated)';
      break;
    }
  }

  os.close(rfd);

  return { output: timedOut ? `${out}\n... (timed out after ${timeoutMs}ms, process killed)` : out, status, timedOut };
}
