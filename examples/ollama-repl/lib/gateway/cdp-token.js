/**
 * cdp-token: reads the freellmapi dashboard's session token out of the
 * browser the user is logged in with, over the Chrome DevTools Protocol.
 * The dashboard keeps it in localStorage, key freellmapi_dashboard_token,
 * of its own origin (http://localhost:3001).
 *
 * ```js
 * const token = await dashboardTokenFromBrowser('http://localhost:3001', { port: 9222 });
 * ```
 *
 * The browser must run with --remote-debugging-port, as for chat-bridge.
 * Without `open`, only tabs already showing the dashboard are read. With
 * it, a missing tab is opened in the background, read and closed again.
 */
import { WebSocketStream } from '../../../../lib/websocketstream.js';
import { TextDecoder } from 'textcode';
import { setTimeout } from 'os';
import { popen } from 'std';

const TOKEN_KEY = 'freellmapi_dashboard_token';

/* the devtools http endpoint through curl: an lws http request to that port
   breaks the next WebSocketStream to it (BUGS: ws-connect-after-http-to-devtools-port-fails) */
function devtoolsJSON(url, method = 'GET', timeoutMs = 1500) {
  const pipe = popen(`curl -sf -m ${Math.ceil(timeoutMs / 1000)} -X ${method} '${url.replace(/'/g, '')}'`, 'r');
  if(!pipe) throw new Error('cannot run curl');

  const text = pipe.readAsString();
  if(pipe.close() !== 0 || !text) throw new Error(`no answer from ${url.replace(/\/json.*/, '')}`);
  return JSON.parse(text);
}

/* rejects after ms, so a browser that does not answer cannot hang startup */
const within = (ms, p) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer within ${ms}ms`)), ms))]);

/** both spellings of a local origin: localStorage is per origin, localhost and 127.0.0.1 differ */
function originsOf(origin) {
  const u = origin.replace(/\/+$/, '');
  return [...new Set([u, u.replace('//localhost', '//127.0.0.1'), u.replace('//127.0.0.1', '//localhost')])];
}

/**
 * one CDP command on a target's websocket, then close
 *
 * @returns {Promise<object>} the command's result
 */
async function cdpCall(wsUrl, method, params) {
  const { readable, writable } = await new WebSocketStream(wsUrl).opened;
  const writer = writable.getWriter();
  const reader = readable.getReader();
  const dec = new TextDecoder();
  let buf = '';

  await writer.write(JSON.stringify({ id: 1, method, params }));

  try {
    for(;;) {
      const { done, value } = await reader.read();
      if(done) throw new Error('CDP connection closed');
      buf += typeof value == 'string' ? value : dec.decode(value, { stream: true });

      let msg;
      try {
        msg = JSON.parse(buf);
      } catch(e) {
        continue; // frame not complete yet
      }

      buf = '';
      if(msg.id !== 1) continue;
      if(msg.error) throw new Error(`CDP ${msg.error.code}: ${msg.error.message}`);
      return msg.result;
    }
  } finally {
    writer.close().catch(() => {});
  }
}

async function readToken(wsUrl) {
  const r = await cdpCall(wsUrl, 'Runtime.evaluate', { expression: `localStorage.getItem(${JSON.stringify(TOKEN_KEY)})`, returnByValue: true });
  return r?.result?.value || null;
}

/**
 * the dashboard token from a logged-in browser tab
 *
 *   origin      gateway origin, e.g. http://localhost:3001
 *   host, port  browser debugging endpoint (127.0.0.1:9222)
 *   open        open a background tab when none shows the dashboard
 *   timeoutMs   per step (1500)
 *
 * @returns {Promise<string|null>} null when no tab has one
 * @throws when the browser cannot be reached
 */
export async function dashboardTokenFromBrowser(origin, { host = '127.0.0.1', port = 9222, open = false, timeoutMs = 1500 } = {}) {
  const base = `http://${host}:${port}`;
  const origins = originsOf(origin);
  const pages = devtoolsJSON(`${base}/json`, 'GET', timeoutMs).filter(t => t.type === 'page' && t.webSocketDebuggerUrl);

  for(const t of pages.filter(t => origins.some(o => t.url.startsWith(o + '/') || t.url === o))) {
    const token = await within(timeoutMs, readToken(t.webSocketDebuggerUrl)).catch(() => null);
    if(token) return token;
  }

  if(!open) return null;

  /* each origin once: the user may have logged in under either spelling */
  for(const o of origins) {
    const t = devtoolsJSON(`${base}/json/new?${o}/`, 'PUT', timeoutMs);

    try {
      for(let i = 0; i < 10; i++) {
        const token = await within(timeoutMs, readToken(t.webSocketDebuggerUrl)).catch(() => null);
        if(token) return token;
        await new Promise(r => setTimeout(r, 300)); // the page may still be loading
      }
    } finally {
      try {
        devtoolsJSON(`${base}/json/close/${t.id}`, 'GET', timeoutMs);
      } catch(e) {}
    }
  }

  return null;
}
