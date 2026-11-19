/**
 * Control socket: lets another process (e.g. Claude Code) type into a
 * running, interactive ollama-repl and read what it prints - the same
 * session the user sees on the terminal, not a fresh conversation.
 *
 * Unix stream socket at `<runtime dir>/o<pid>.s` (short: see unixAddr()) plus `<dir>/<pid>.json` (what a
 * client needs to pick a session). Client -> server: plain text, one input
 * line per line. Server -> client: one JSON object per line:
 *   {type:'hello', ...info, busy}   on connect
 *   {type:'accepted'}               a line was taken (it may still be queued)
 *   {type:'output', text}           everything the REPL prints (ANSI stripped)
 *   {type:'waiting', kind, text}    a y/N or ask_user question is on the
 *                                   terminal; only the user can answer it
 *   {type:'ready'}                  every submitted line has been handled
 *   {type:'info', ...}              session info changed (the model, after /model)
 */
import { mkdir, setReadHandler, kill, getpid, readdir } from 'os';
import { rmSync } from 'fs';
import { getenv, loadFile, open } from 'std';
import { TextDecoder, TextEncoder } from 'textcode';
import { AF_UNIX, SOCK_STREAM, SockAddr, Socket } from 'sockets';

/**
 * How many bytes of a socket path the sockets binding binds: the size of its SockAddr minus the family. A
 * qjsm built without HAVE_AF_UNIX (checked 2026-11-19, qjsm 757b576bf8ab-dirty, BUGS: sockaddr-unix-length)
 * has 28 bytes, so 26: bind() then cuts a longer path (/run/user/1000/ollama-repl/123.sock becomes the
 * directory /run/user/1000/ollama-repl and fails with EADDRINUSE); a good build has 110 bytes, 107 of path.
 */
export function sockPathLimit() {
  return Math.min(107, new SockAddr(AF_UNIX).byteLength - 2);
}

/**
 * sockaddr_un for `path`, built from the raw struct: `new SockAddr(AF_UNIX, path)` leaves sun_path zero in
 * that build and binds the shared empty abstract name (the first session gets it, every other one fails with
 * EADDRINUSE, and a client connects to whichever session holds it). Refuses a path the binding would cut.
 */
export function unixAddr(path) {
  const bytes = new TextEncoder().encode(path);
  const limit = sockPathLimit();
  if(bytes.length > limit) throw new Error(`the socket path is ${bytes.length} bytes, this qjsm binds at most ${limit} of a Unix socket path: ${path}`);

  const buf = new ArrayBuffer(110);
  new DataView(buf).setUint16(0, AF_UNIX, true);
  new Uint8Array(buf, 2).set(bytes);
  return new SockAddr(buf);
}

/* rmSync throws on a missing file, the sock/json files often are */
const remove = path => rmSync(path, { force: true });

export function controlDir() {
  const base = getenv('XDG_RUNTIME_DIR') || `${getenv('HOME')}/.cache`;
  return `${base}/ollama-repl`;
}

/** @returns {object[]} info of every live session, stale ones are removed */
export function listSessions(dir = controlDir()) {
  const [names] = readdir(dir);
  const sessions = [];

  for(const name of names ?? []) {
    if(!name.endsWith('.json')) continue;

    try {
      const info = JSON.parse(loadFile(`${dir}/${name}`));
      if(kill(info.pid, 0) === 0) sessions.push(info);
      else {
        remove(`${dir}/${name}`);
        remove(info.sock);
      }
    } catch {}
  }

  return sessions;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\r/g;

export class ControlSocket {
  #srv;
  #clients = new Map(); // Socket -> { buf: string, dec: TextDecoder }
  #info;
  #infoPath;
  #onLine;
  #busy;

  /**
   * @param {object} info  fields published for clients (model, root, ...)
   * @param {(line: string) => void} onLine  a client submitted a line
   * @param {() => boolean} busy  whether a line is being handled now
   * @param {string} [path]  socket path; default o<pid>.s in the runtime directory (controlDir()'s parent), short enough to be bound whole
   */
  constructor(info, onLine, busy, path) {
    const dir = controlDir();
    mkdir(dir.slice(0, dir.lastIndexOf('/')), 0o700);
    mkdir(dir, 0o700);

    const pid = getpid();
    this.path = path ?? `${dir.slice(0, dir.lastIndexOf('/'))}/o${pid}.s`;
    this.#infoPath = `${dir}/${pid}.json`;
    this.#info = { pid, sock: this.path, startedAt: new Date().toISOString(), ...info };
    this.#onLine = onLine;
    this.#busy = busy;
  }

  start() {
    const addr = unixAddr(this.path); // refuses a path longer than a sockaddr_un holds

    remove(this.path);

    const srv = (this.#srv = new Socket(AF_UNIX, SOCK_STREAM));

    try {
      srv.bind(addr);
      srv.listen(4);
    } catch(e) {
      throw new Error(`cannot listen on ${this.path}: ${e?.message || e?.code || e}`);
    }

    setReadHandler(srv.fd, () => this.#accept());

    const f = open(this.#infoPath, 'w');
    f.puts(JSON.stringify(this.#info) + '\n');
    f.close();
  }

  #accept() {
    const conn = this.#srv.accept(new SockAddr(AF_UNIX));
    this.#clients.set(conn, { buf: '', dec: new TextDecoder() });
    setReadHandler(conn.fd, () => this.#read(conn));
    this.#send(conn, { type: 'hello', ...this.#info, busy: this.#busy() });
  }

  #read(conn) {
    const st = this.#clients.get(conn);
    const chunk = new ArrayBuffer(4096);
    const n = conn.recv(chunk);

    if(n === 0) return this.#drop(conn);
    if(n < 0) return;

    st.buf += st.dec.decode(new Uint8Array(chunk, 0, n), { stream: true });

    let nl;
    while((nl = st.buf.indexOf('\n')) !== -1) {
      const line = st.buf.slice(0, nl).replace(/\r$/, '');
      st.buf = st.buf.slice(nl + 1);

      if(!line.trim()) continue;
      this.#send(conn, { type: 'accepted' });
      this.#onLine(line);
    }
  }

  #send(conn, obj) {
    try {
      conn.send(JSON.stringify(obj) + '\n');
    } catch {
      this.#drop(conn);
    }
  }

  #drop(conn) {
    if(!this.#clients.delete(conn)) return;
    setReadHandler(conn.fd, null);
    conn.close();
  }

  /** @param {object} obj  an event for every connected client */
  event(obj) {
    for(const conn of this.#clients.keys()) this.#send(conn, obj);
  }

  /** Publishes changed session info (e.g. the model after /model). */
  update(patch) {
    Object.assign(this.#info, patch);

    const f = open(this.#infoPath, 'w');
    f.puts(JSON.stringify(this.#info) + '\n');
    f.close();
    this.event({ type: 'info', ...patch });
  }

  output(text) {
    if(!this.#clients.size) return;
    const t = String(text).replace(ANSI, '');
    if(t) this.event({ type: 'output', text: t });
  }

  close() {
    for(const conn of [...this.#clients.keys()]) this.#drop(conn);
    if(this.#srv) {
      setReadHandler(this.#srv.fd, null);
      this.#srv.close();
    }
    remove(this.path);
    remove(this.#infoPath);
  }
}
