/**
 * `--provider bridge`: starts examples/chat-bridge as a child process on a
 * free port and hands back its OpenAI endpoint URL, so the repl needs no
 * separately started server.
 *
 * The bridge is found, in this order: $CHAT_BRIDGE, the in-repo
 * ../chat-bridge/chat-bridge.js next to this repl, or a `chat-bridge`
 * executable on PATH (what `cmake --install` creates).
 */
import { close, exec, kill, pipe, read, setReadHandler, setTimeout, sleep, waitpid, mkdir, WNOHANG } from 'os';
import { getenv, loadFile, open } from 'std';
import { toString } from 'lws.so';

const SIGTERM = 15;
const SIGKILL = 9;

/** the command line that runs the bridge, or null */
function bridgeCommand(scriptPath) {
  const env = getenv('CHAT_BRIDGE');
  if(env) return env.endsWith('.js') ? ['qjsm', env] : [env];

  /* the one next to this repl first: same checkout, same version */
  const dir = (scriptPath ?? '').replace(/[^/]*$/, '') || './';
  const local = `${dir}../chat-bridge/chat-bridge.js`;
  if(loadFile(local) !== null) return ['qjsm', local];

  return exec(['/bin/sh', '-c', 'command -v chat-bridge >/dev/null'], { block: true }) === 0 ? ['chat-bridge'] : null;
}

/**
 * @param {object} o
 * @param {string} [o.scriptPath]  path of repl.js, to find the in-repo bridge
 * @param {string} [o.cdpHost]
 * @param {number} [o.cdpPort]
 * @param {boolean} [o.allowPaid]  let the bridge use pay-as-you-go sites
 * @returns {Promise<{url: string, pid: number, stop: () => void}>}
 */
export async function startBridge({ scriptPath, cdpHost = '127.0.0.1', cdpPort = 9222, allowPaid = false, timeoutMs = 20000 } = {}) {
  const cmd = bridgeCommand(scriptPath);
  if(!cmd) throw new Error('chat-bridge not found: install it (cmake --install), put it on PATH, or set CHAT_BRIDGE');

  const [rfd, wfd] = pipe();
  const pid = exec([...cmd, '--listen', '0', '--host', cdpHost, '--port', String(cdpPort), ...(allowPaid ? ['--allow-paid'] : []), 'serve'], { block: false, stdout: wfd, stderr: wfd });
  close(wfd);

  let out = '';
  let url = null;
  const buf = new Uint8Array(4096);

  /* kept installed after the URL line: draining the pipe means the bridge
     can never block (or die of SIGPIPE) writing to it */
  setReadHandler(rfd, () => {
    const n = read(rfd, buf.buffer, 0, buf.length);
    if(n > 0 && url === null) {
      out += toString(buf.buffer.slice(0, n));
      url = /chat-bridge: (http:\/\/\S+\/v1)/.exec(out)?.[1] ?? null;
    }
  });

  const stop = () => {
    setReadHandler(rfd, null);
    try {
      kill(pid, SIGTERM); /* the bridge closes the tabs it opened */
    } catch(e) {
      return;
    }
    for(let i = 0; i < 40; i++) {
      if(waitpid(pid, WNOHANG)[0] === pid) return close(rfd);
      sleep(50);
    }
    try {
      kill(pid, SIGKILL);
    } catch(e) {}
    close(rfd);
  };

  for(const end = Date.now() + timeoutMs; url === null; ) {
    if(waitpid(pid, WNOHANG)[0] === pid) {
      setReadHandler(rfd, null);
      close(rfd);
      throw new Error(out.trim().split('\n').pop() || 'chat-bridge exited at startup');
    }
    if(Date.now() > end) {
      stop();
      throw new Error('chat-bridge did not report its address in time');
    }
    await new Promise(r => setTimeout(r, 50));
  }

  return { url, pid, stop };
}

/**
 * The model for a session that did not name one: the available models
 * taken in turn, remembering where the last session stopped, so successive
 * sessions spread over the sites (and their free-tier quotas).
 *
 * @param {{name: string, available: boolean}[]} models
 * @returns {string|null}
 */
export function pickModel(models) {
  const ok = models.filter(m => m.available);
  if(!ok.length) return null;

  const dir = `${getenv('HOME') ?? '.'}/.cache/ollama-repl`;
  const file = `${dir}/bridge-next`;
  const n = parseInt(loadFile(file) ?? '', 10) || 0;
  const pick = ok[n % ok.length];

  mkdir(`${getenv('HOME') ?? '.'}/.cache`, 0o755);
  mkdir(dir, 0o755);
  const f = open(file, 'w');
  if(f) {
    f.puts(String(n + 1));
    f.close();
  }

  return pick.name;
}
