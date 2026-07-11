/**
 * Helpers for tests/unittests/test-server.js and test-client.js: each test
 * there exercises one half (server or client) of a connection by spawning
 * the *other* half as a separate `qjsm` subprocess, so the two sides run in
 * genuinely independent event loops - the same shape a real client and a
 * real server would have.
 */
import * as os from 'os';
import * as std from 'std';

let seq = 0;

function tmpPath(suffix) {
  return `/tmp/qjs-lws-test-${os.getpid()}-${seq++}${suffix}`;
}

/**
 * Writes `code` to a temp .js file and runs it with qjsm as a detached
 * subprocess, with stdout+stderr redirected to a temp log file.
 *
 * @return {{pid:number, scriptPath:string, logPath:string}}
 */
export function spawnQjsm(code) {
  const scriptPath = tmpPath('.js');
  const logPath = tmpPath('.log');

  const script = std.open(scriptPath, 'w');
  script.puts(code);
  script.close();

  const fd = os.open(logPath, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644);
  const pid = os.exec(['qjsm', scriptPath], { block: false, stdout: fd, stderr: fd });
  os.close(fd);

  return { pid, scriptPath, logPath };
}

/**
 * Polls a log file until `predicate(content)` is true or `timeoutMs` elapses.
 *
 * Forking a process that holds an active LWSContext (open epoll/listening/
 * timer fds) is measurably slower than forking a bare process - observed
 * up to ~1s before a spawned child even reaches its first line of code - so
 * a short fixed sleep after spawnQjsm() is not reliable here. Every child
 * script used by these tests must print a marker line (e.g. "READY" once
 * listening, or "RESULT:...." once it has something to report) that the
 * predicate watches for, so the wait is bounded by actual readiness rather
 * than a guessed delay.
 *
 * @return {string} the log content once the predicate matched
 * @throws if the predicate never matched before timeoutMs
 */
export async function waitForLog(logPath, predicate, { timeoutMs = 5000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;

  for(;;) {
    const content = readLog(logPath);

    if(predicate(content)) return content;
    if(Date.now() >= deadline) throw new Error(`waitForLog: timed out after ${timeoutMs}ms waiting for a match. Log so far: ${JSON.stringify(content)}`);

    await os.sleepAsync(intervalMs);
  }
}

/** waitForLog() with a plain substring predicate. */
export function waitForMarker(logPath, marker, opts) {
  return waitForLog(logPath, content => content.includes(marker), opts);
}

/**
 * Runs an external command (e.g. `curl`) to completion and captures its
 * stdout, for tests that just need a plain, known-good client for
 * comparison rather than another qjs-lws process.
 *
 * @return {{status:number, stdout:string}}
 */
export function runCommandCapture(args) {
  const outPath = tmpPath('.out');
  const fd = os.open(outPath, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644);
  const pid = os.exec(args, { block: false, stdout: fd });
  os.close(fd);

  const [, status] = os.waitpid(pid, 0);
  const stdout = readLog(outPath);

  return { status, stdout };
}

/** spawnQjsm() plus waitForMarker() for the child's own "ready" line. */
export async function spawnAndWaitFor(code, marker, opts) {
  const proc = spawnQjsm(code);
  await waitForMarker(proc.logPath, marker, opts);
  return proc;
}

/** SIGTERM then waitpid, swallowing errors from an already-dead process. */
export function stopProcess(pid) {
  try {
    os.kill(pid, os.SIGTERM);
  } catch(e) {
    /* already gone */
  }
  try {
    os.waitpid(pid, 0);
  } catch(e) {
    /* already reaped */
  }
}

/** Reads back a subprocess's captured stdout+stderr. */
export function readLog(logPath) {
  try {
    const f = std.open(logPath, 'r');
    const content = f.readAsString();
    f.close();
    return content;
  } catch(e) {
    return '';
  }
}

let portSeq = 0;

/**
 * A port unlikely to collide with another concurrently-running instance of
 * this same suite (or the OS's own ephemeral range) - spread by pid so two
 * `run-all.sh` invocations racing each other still land on different ports.
 * Uses its own counter (not `seq`, shared with tmpPath()) so callers can
 * freely interleave freePort() and spawnQjsm() calls without either one's
 * numbering affecting the other's spread.
 */
export function freePort() {
  return 19000 + (os.getpid() % 4000) + (portSeq++ % 50);
}
