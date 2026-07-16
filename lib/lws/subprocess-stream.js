/**
 * Spawns a subprocess and exposes its stdin/stdout/stderr as WHATWG streams,
 * plus an `exited` promise that resolves once the child has actually been
 * reaped.
 *
 * Child exits are detected via SIGCHLD rather than polling: a single
 * process-wide handler (installed once, lazily) reaps every exited child
 * with a non-blocking `os.waitpid(-1, WNOHANG)` loop each time SIGCHLD
 * fires - one signal delivery can represent more than one exited child, so
 * that loop runs until waitpid reports nothing left to reap. Live children
 * are tracked in a LinkedList so a reaped pid can be matched back to the
 * promise that's waiting on it.
 *
 * stdout/stderr draining note: os.setReadHandler() only reliably fires once
 * a pipe actually has bytes to deliver - a pipe that reaches EOF without
 * ever having any data written to it (e.g. a child that produces no output
 * at all) never triggers its read handler, confirmed even for a bare pipe
 * with no subprocess involved. So closing is not left to that handler
 * alone: once `exited` resolves, both streams are force-drained (reads
 * against an already-exited child's pipe never block) and closed.
 */
import { WritableStream, ReadableStream } from './streams.js';
import { exec, pipe, close, read, write, setReadHandler, signal, waitpid, SIGCHLD, WNOHANG } from 'os';
import { toArrayBuffer } from 'lws';
import { LinkedList } from './list.js';

const READ_CHUNK_SIZE = 65536;

/* LinkedList of { pid, onExit } for every child spawned via
   SubprocessStream that hasn't been reaped yet. */
const liveChildren = new LinkedList();
let sigchldInstalled = false;

function installSigchldHandler() {
  if(sigchldInstalled) return;
  sigchldInstalled = true;

  signal(SIGCHLD, () => {
    for(;;) {
      const [pid, status] = waitpid(-1, WNOHANG);

      if(pid <= 0) break; // 0: nothing more ready right now; <0: no children left

      notifyExit(pid, decodeWaitStatus(status));
    }
  });
}

/* Removes and notifies the tracked entry for `pid`, if any. LinkedList only
   exposes push/pop at the ends, so removing an arbitrary entry means
   draining the whole list and rebuilding it without the match - fine here
   since the number of concurrently-tracked children is small. */
function notifyExit(pid, result) {
  const survivors = [];

  while(!liveChildren.empty) {
    const entry = liveChildren.popFront();

    if(entry.pid === pid) entry.onExit(result);
    else survivors.push(entry);
  }

  for(const entry of survivors) liveChildren.pushBack(entry);
}

/* POSIX wait status decoding: low 7 bits are the terminating signal number
   (0 means "exited normally"); if it exited normally, the next 8 bits are
   the exit code. */
function decodeWaitStatus(status) {
  const termSignal = status & 0x7f;

  if(termSignal === 0) return { code: (status >> 8) & 0xff, signal: null };

  return { code: null, signal: termSignal };
}

/**
 * @return {{stream:ReadableStream, drainAndClose:Function}}
 */
function readableFromFd(fd) {
  let ctrl;
  let closed = false;
  const buf = new ArrayBuffer(READ_CHUNK_SIZE);

  function pump() {
    if(closed) return;

    let n;

    try {
      n = read(fd, buf, 0, READ_CHUNK_SIZE);
    } catch(e) {
      closed = true;
      setReadHandler(fd, null);
      close(fd);
      ctrl.error(e);
      return;
    }

    if(n > 0) {
      ctrl.enqueue(buf.slice(0, n));
    } else {
      closed = true;
      setReadHandler(fd, null);
      close(fd);
      ctrl.close();
    }
  }

  const stream = new ReadableStream({
    start(controller) {
      ctrl = controller;
      setReadHandler(fd, pump);
    },
    cancel() {
      closed = true;
      setReadHandler(fd, null);
      close(fd);
    },
  });

  return {
    stream,
    drainAndClose() {
      // The child has already exited, so every remaining read is either
      // buffered data or immediate EOF - never blocks.
      while(!closed) pump();
    },
  };
}

function writableToFd(fd) {
  return new WritableStream({
    write(chunk) {
      const buf = typeof chunk === 'string' ? toArrayBuffer(chunk) : ArrayBuffer.isView(chunk) ? chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) : chunk;

      write(fd, buf, 0, buf.byteLength);
    },
    close() {
      close(fd);
    },
    abort() {
      close(fd);
    },
  });
}

/**
 * @param  {string[]} args     argv, including argv[0]
 * @param  {object}   [options] passed through to os.exec() (block is
 *                              always forced to false)
 * @return {{pid:number, stdin:WritableStream, stdout:ReadableStream,
 *           stderr:ReadableStream, exited:Promise<{code:number|null,
 *           signal:number|null}>}}
 */
export function SubprocessStream(args, options = {}) {
  installSigchldHandler();

  const spawnOptions = { ...options, block: false };
  let stdinWrite, stdoutRead, stderrRead;

  [spawnOptions.stdin, stdinWrite] = pipe();
  [stdoutRead, spawnOptions.stdout] = pipe();
  [stderrRead, spawnOptions.stderr] = pipe();

  const pid = exec(args, spawnOptions);

  // The child inherited its own copies via fork(); the parent's ends of the
  // fds it uses aren't needed here.
  for(const fd of [spawnOptions.stdin, spawnOptions.stdout, spawnOptions.stderr]) close(fd);

  const stdout = readableFromFd(stdoutRead);
  const stderr = readableFromFd(stderrRead);

  const exited = new Promise(resolve => {
    liveChildren.pushBack({
      pid,
      onExit(result) {
        stdout.drainAndClose();
        stderr.drainAndClose();
        resolve(result);
      },
    });
  });

  return {
    pid,
    stdin: writableToFd(stdinWrite),
    stdout: stdout.stream,
    stderr: stderr.stream,
    exited,
  };
}
