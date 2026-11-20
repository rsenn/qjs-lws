/**
 * peer: hands a task to another ollama-repl instance through its control
 * socket (the protocol ollama-repl-ctl speaks), so a job can run on another
 * provider or model than this session's.
 *
 * ```js
 * const peers = findPeers({ root: '/src/proj' });                       // workers on the same project
 * const r = await askPeer(peers[0], ['/reset'], 'summarize lib/a.js');   // { ok, text, busy, waiting, error }
 * ```
 *
 * A worker is an instance started with `--worker` (it listens, never
 * delegates itself, so two instances cannot hand a task back and forth).
 * Only workers on the same project root are found by findPeers(); any other
 * live session can still be named by hand. The task goes in as one input
 * line, as if typed at that session; everything it prints until it is idle
 * again is the answer. A session that asks for an approval at its terminal
 * cannot be answered from here: that ends the wait with `waiting`.
 */
import { setReadHandler, setTimeout, clearTimeout, realpath } from 'os';
import { TextDecoder } from 'textcode';
import { AF_UNIX, SOCK_STREAM, Socket } from 'sockets';
import { listSessions, unixAddr } from './control-socket.js';

const abs = (info, root) => realpath(String(root).startsWith('/') ? root : `${info.cwd ?? '.'}/${root}`)[0];

/** whether a session works on the project at `root` */
export const sameRoot = (info, root) => {
  try {
    return abs(info, info.root) === realpath(root)[0];
  } catch(e) {
    return false;
  }
};

/**
 * Live worker sessions on the same project, not this process.
 *
 * @param {{root: string, selfPid?: number, all?: boolean}} opts  all: any session, not only workers
 */
export function findPeers({ root, selfPid, all = false }) {
  let sessions = [];

  try {
    sessions = listSessions();
  } catch(e) {}

  return sessions.filter(s => s.pid !== selfPid && (all || s.worker) && sameRoot(s, root));
}

/**
 * Sends `pre` lines (commands such as /reset), then `task`, one after the
 * other, each waiting until the session is idle; collects what the session
 * printed for the task.
 *
 * @param {object} info  a session from listSessions()
 * @param {string[]} pre
 * @param {string} task
 * @returns {Promise<{ok: boolean, text: string, busy?: boolean, waiting?: string, error?: string}>}
 */
export function askPeer(info, pre, task, { timeoutMs = 600000 } = {}) {
  return new Promise(resolve => {
    const sock = new Socket(AF_UNIX, SOCK_STREAM);
    const dec = new TextDecoder();
    const steps = [...pre, task].map(l => l.replaceAll('\n', ' '));
    let step = -1;
    let buf = '';
    let text = '';
    let done = false;

    const finish = r => {
      if(done) return;
      done = true;
      clearTimeout(timer);
      try {
        setReadHandler(sock.fd, null);
        sock.close();
      } catch(e) {}
      resolve({ text: text.trim(), ...r });
    };

    const timer = setTimeout(() => finish({ ok: false, error: `no answer within ${Math.round(timeoutMs / 1000)}s (the session keeps working)` }), timeoutMs);

    const next = () => {
      step++;
      sock.send(steps[step] + '\n');
    };

    const handle = ev => {
      switch(ev.type) {
        case 'hello':
          if(ev.busy) return finish({ ok: false, busy: true, error: 'the session is busy with something else' });
          next();
          break;
        case 'output':
          if(step === steps.length - 1) text += ev.text;
          break;
        case 'waiting':
          finish({ ok: false, waiting: ev.text ?? ev.kind, error: `the session waits for an approval at its terminal (${ev.kind})` });
          break;
        case 'ready':
          if(step < steps.length - 1) next();
          else finish({ ok: true });
          break;
      }
    };

    try {
      sock.connect(unixAddr(info.sock));
    } catch(e) {
      return finish({ ok: false, error: `cannot connect to ${info.sock}: ${e.message}` });
    }

    setReadHandler(sock.fd, () => {
      const chunk = new ArrayBuffer(65536);
      const n = sock.recv(chunk);

      if(n === 0) return finish({ ok: false, error: 'the session closed the connection' });
      if(n < 0) return;

      buf += dec.decode(new Uint8Array(chunk, 0, n), { stream: true });

      let nl;
      while((nl = buf.indexOf('\n')) !== -1 && !done) {
        const l = buf.slice(0, nl);
        buf = buf.slice(nl + 1);

        try {
          if(l) handle(JSON.parse(l));
        } catch(e) {}
      }
    });
  });
}

/**
 * The answer of a peer as text: without the echo of the typed line, the
 * spinner lines (they end in "..."), the closing line with time and
 * routing ("Plundered in 3.2s - auto -> ...") and the reply mark; the last
 * `max` characters.
 */
export function peerAnswer(text, max = 6000) {
  const t = String(text)
    .split('\n')
    .map(l => l.replace(/^\s*[≋≈☼]+ /, '').replace(/\s+$/, ''))
    .filter(l => !l.startsWith('[remote]>') && !l.startsWith('⇄ remote ❯') && !/(\.\.\.|…)\s*$/.test(l) && !/\bin \d+(\.\d+)?s( - |$)/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return t.length > max ? `[...]\n${t.slice(-max)}` : t;
}
