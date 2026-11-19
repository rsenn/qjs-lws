/**
 * Control socket: lets another process (e.g. Claude Code) type into a
 * running, interactive ollama-repl and read what it prints - the same
 * session the user sees on the terminal, not a fresh conversation.
 *
 * Unix stream socket at `<dir>/<pid>.sock` plus `<dir>/<pid>.json` (what a
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
import { mkdir, remove, setReadHandler, kill, getpid, readdir } from 'os';
import { getenv, loadFile, open } from 'std';
import { TextDecoder } from 'textcode';
import { AF_UNIX, SOCK_STREAM, SockAddr, Socket } from 'sockets';

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
   * @param {string} [path]  socket path; default <controlDir()>/<pid>.sock
   */
  constructor(info, onLine, busy, path) {
    const dir = controlDir();
    mkdir(dir.slice(0, dir.lastIndexOf('/')), 0o700);
    mkdir(dir, 0o700);

    const pid = getpid();
    this.path = path ?? `${dir}/${pid}.sock`;
    this.#infoPath = `${dir}/${pid}.json`;
    this.#info = { pid, sock: this.path, startedAt: new Date().toISOString(), ...info };
    this.#onLine = onLine;
    this.#busy = busy;
  }

  start() {
    remove(this.path);

    const srv = (this.#srv = new Socket(AF_UNIX, SOCK_STREAM));
    srv.bind(new SockAddr(AF_UNIX, this.path));
    srv.listen(4);
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
