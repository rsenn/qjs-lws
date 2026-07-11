/**
 * Talks to server.js over the WebSocket at /debug. Two kinds of WS message
 * arrive:
 *   - text messages carry debug-wire JSON, framed the same way as the raw
 *     TCP side ("%08x '\n' <json> '\n'", the 8 hex digits counting json's
 *     UTF-8 byte length + 1) rather than being one-message-per-frame - a
 *     large frame can otherwise come out on the wire as several separate
 *     WS messages, so it's decoded here by that explicit length prefix
 *     instead of relying on WS message boundaries (see decodeFrames()).
 *   - binary messages are streamed target I/O, the first byte the channel
 *     (1 = stdout, 2 = stderr).
 * server.js only shovels bytes; source files relative to this directory
 * are fetched as static assets from the same origin, and absolute-path
 * source files (e.g. modules the debug target loaded from elsewhere on
 * disk) go through GET /source?path=... instead, which server.js
 * restricts to .js files under the user's home.
 */

// 0: silent, 1: std{out,err,in}, 2: + wire protocol. Set from devtools.
let debugLevel = 1;

function debugLog(level, arrow, color, label, ...args) {
  if(debugLevel < level) return;
  console.log(`%c${arrow}%c ${label}`, `color: ${color};`, 'color: black', ...args);
}

const statusEl = document.getElementById('status');
const sourceEl = document.getElementById('source');
const varsEl = document.getElementById('vars');
const outputEl = document.getElementById('output');
const evalInput = document.getElementById('evalInput');
const evalResultEl = document.getElementById('evalResult');
const sourceCache = new Map();
const breakpoints = new Map(); // filename -> Set<line>

const KEYWORDS =
  'async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|finally|for|from|function|if|import|in|instanceof|let|new|of|return|static|super|switch|this|throw|try|typeof|var|void|while|with|yield';

// `other` covers every remaining char so escaping never splits across two
// <span>s. Regex-vs-division is a simple heuristic (word char before `/`
// means division) - misreads `return /re/`, an accepted edge case.
const tokenRe = new RegExp(
  '(?<comment>//[^\\n]*|/\\*[\\s\\S]*?\\*/)' +
    '|(?<regex>(?<![\\w$)\\]]\\s*)/(?:[^/\\\\\\n[]|\\\\.|\\[(?:[^\\]\\\\\\n]|\\\\.)*\\])+/[a-z]*)' +
    `|(?<string>"(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*')` +
    '|(?<numeric>\\b0[xX][\\da-fA-F]+\\b|\\b0[oO][0-7]+\\b|\\b0[bB][01]+\\b|\\b\\d+\\.\\d*(?:[eE][+-]?\\d+)?\\b|\\b\\.\\d+\\b|\\b\\d+(?:[eE][+-]?\\d+)?\\b)' +
    `|(?<keyword>\\b(?:${KEYWORDS})\\b)` +
    '|(?<ident>[A-Za-z_$][\\w$]*)' +
    '|(?<punct>[-+*/%=<>!&|^~?:;,.(){}\\[\\]]+)' +
    '|(?<other>[\\s\\S])',
  'g',
);

function escapeHtml(str) {
  return str.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

function highlightLine(line) {
  return line.replace(tokenRe, (match, ...rest) => {
    const groups = rest[rest.length - 1];
    const type = Object.keys(groups).find(k => groups[k] !== undefined);
    const escaped = escapeHtml(match);
    return type && type !== 'other' ? `<span class="tok-${type}">${escaped}</span>` : escaped;
  });
}

function toggleBreakpoint(filename, line, div) {
  let set = breakpoints.get(filename);
  if(!set) breakpoints.set(filename, (set = new Set()));
  if(set.has(line)) set.delete(line);
  else set.add(line);
  div.classList.toggle('breakpoint', set.has(line));
  ws.send(JSON.stringify({ type: 'breakpoints', breakpoints: { path: filename, breakpoints: [...set].map(line => ({ line })) } }));
}

let ws,
  seq = 1;
const pending = new Map();

function setStatus(text) {
  statusEl.textContent = text;
}

function request(command, args) {
  const request_seq = seq++;
  const request = { type: 'request', request: { command, request_seq, args } };
  debugLog(2, '🡆', 'red', 'sendMessage(', request, ')');
  ws.send(JSON.stringify(request));
  return new Promise(resolve => pending.set(request_seq, resolve));
}

function onFrame(json) {
  let msg;
  try {
    msg = JSON.parse(json);
  } catch(e) {
    console.log(`bad debugger frame: '${json}'`);
    return;
  }
  debugLog(2, '🡄', 'green', 'onFrame', msg);
  if(msg.type === 'response') {
    pending.get(msg.request_seq)?.(msg.body);
    pending.delete(msg.request_seq);
  } else if(msg.type === 'event') {
    if(msg.event.type === 'StoppedEvent') {
      setStatus(`paused (${msg.event.reason})`);
      refresh();
    } else if(msg.event.type === 'terminated') {
      setStatus('debug target terminated');
    }
  }
}

function onOutput(channel, text) {
  const stdin = channel === 3;
  debugLog(1, stdin ? '🡅' : '🡇', stdin ? 'blue' : '#ffc000', 'onOutput', { channel, text });
  const line = document.createElement('div');
  if(channel === 2) line.className = 'stderr';
  line.textContent = text;
  outputEl.appendChild(line);
  outputEl.scrollTop = outputEl.scrollHeight;
}

async function showSource(filename, line) {
  if(!filename) {
    sourceEl.textContent = '(no source info for this frame)';
    return;
  }

  let text = sourceCache.get(filename);

  if(text === undefined) {
    // Absolute paths point outside this directory (e.g. modules the debug
    // target loaded from elsewhere on disk) and aren't reachable through
    // the static mount at '/' - fetch those through /source instead, which
    // is restricted server-side to .js files under the user's home dir.
    const url = filename.startsWith('/') ? `/source?path=${encodeURIComponent(filename)}` : filename;
    try {
      const res = await fetch(url);
      text = res.ok ? await res.text() : `(HTTP ${res.status} fetching ${filename})`;
    } catch(e) {
      text = `(could not load ${filename}: ${e})`;
    }
    sourceCache.set(filename, text);
  }

  sourceEl.innerHTML = '';

  text.split('\n').forEach((codeLine, i) => {
    const div = document.createElement('div');
    const lineNo = i + 1;
    if(lineNo === line) div.classList.add('current');
    if(breakpoints.get(filename)?.has(lineNo)) div.classList.add('breakpoint');

    const no = document.createElement('span');
    no.className = 'line-no';
    no.textContent = lineNo;
    no.addEventListener('click', () => toggleBreakpoint(filename, lineNo, div));

    const code = document.createElement('span');
    code.innerHTML = highlightLine(codeLine);

    div.append(no, code);
    sourceEl.appendChild(div);
  });

  sourceEl.querySelector('.current')?.scrollIntoView({ block: 'center' });
}

let currentFrameId = 0;

async function refresh() {
  const frames = await request('stackTrace');
  const frame = frames[0];
  if(!frame) return;

  currentFrameId = frame.id;
  await showSource(frame.filename, frame.line);

  varsEl.innerHTML = '';

  for(const scope of await request('scopes', { frameId: frame.id })) {
    if(scope.expensive) continue; // skip Global: huge builtin list, not useful here

    const heading = document.createElement('div');
    heading.className = 'scope';
    heading.textContent = scope.name;
    varsEl.appendChild(heading);

    for(const v of await request('variables', { variablesReference: scope.reference })) {
      const row = document.createElement('div');
      row.textContent = `${v.name} = ${v.value}`;
      varsEl.appendChild(row);
    }
  }
}

async function evaluate(expression, frameId = currentFrameId) {
  const { result } = await request('evaluate', { expression, frameId });
  return result;
}

async function runEval() {
  const expression = evalInput.value;
  if(expression) evalResultEl.textContent = await evaluate(expression);
}

document.getElementById('evalRun').addEventListener('click', runEval);
evalInput.addEventListener('keydown', e => e.key === 'Enter' && runEval());

const keyMap = { F5: 'continue', F9: 'pause', F10: 'next', F11: 'stepIn', F12: 'stepOut' };

for(const [key, id] of Object.entries(keyMap)) document.getElementById(id).title = key;

for(const id of ['continue', 'next', 'stepIn', 'stepOut', 'pause']) document.getElementById(id).addEventListener('click', () => request(id));

document.addEventListener('keydown', e => {
  const id = keyMap[e.key];
  if(id) {
    e.preventDefault();
    request(id);
  }
});

ws = new WebSocket(`ws://${location.host}/debug`, 'browser');
ws.binaryType = 'arraybuffer';

// JSON debug-wire frames arrive as WS text messages, framed the same way
// server.js frames them on the raw TCP side to the debug target ("%08x '\n'
// <json> '\n'", the 8 hex digits counting json's UTF-8 byte length + 1 for
// the trailing '\n'). A large frame (e.g. a big variable listing) can come
// out on the wire as several separate WS messages instead of one - this
// decoder reassembles by the explicit length prefix rather than assuming
// one WS message == one frame. Streamed stdout/stderr (WS binary messages)
// stay small enough to not need this and are handled as before.
let textBuf = new Uint8Array(0);

function decodeFrames() {
  for(;;) {
    if(textBuf.length < 9) return;

    const len = parseInt(new TextDecoder().decode(textBuf.subarray(0, 8)), 16);
    const total = 9 + len;

    if(textBuf.length < total) return;

    onFrame(new TextDecoder().decode(textBuf.subarray(9, total - 1)));
    textBuf = textBuf.subarray(total);
  }
}

ws.onopen = () => setStatus('connected — waiting for a debug target…');
ws.onclose = () => setStatus('disconnected');
ws.onerror = () => setStatus('connection error');
ws.onmessage = ({ data }) => {
  if(typeof data == 'string') {
    const chunk = new TextEncoder().encode(data);
    const merged = new Uint8Array(textBuf.length + chunk.length);
    merged.set(textBuf, 0);
    merged.set(chunk, textBuf.length);
    textBuf = merged;
    decodeFrames();
    return;
  }

  const bytes = new Uint8Array(data);
  onOutput(bytes[0], new TextDecoder().decode(bytes.subarray(1)));
};
