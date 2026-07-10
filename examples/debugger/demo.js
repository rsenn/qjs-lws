/**
 * Talks to server.js over the WebSocket at /debug. Each WS message is one
 * self-contained unit (no manual length framing needed, the transport
 * already delimits messages):
 *   - a message starting with '{' is a debug-wire JSON message
 *   - a message starting with a byte < 0x20 is streamed target I/O: that
 *     first byte is a channel number (1 = stdout, 2 = stderr), the rest is
 *     raw output text
 *
 * server.js does not parse any of this — it only shovels bytes. Source files
 * are fetched as plain static assets from the same origin (server.js serves
 * the current directory), so `qjs target.js` must be run from this directory
 * for the reported filename to resolve.
 */

// 0: silent, 1: std{out,err,in} streams, 2: + wire protocol (sendMessage/onFrame).
// Adjust from devtools with e.g. `debugLevel = 2`.
let debugLevel = 1;

function debugLog(level, arrow, color, label, ...args) {
  if(debugLevel < level) return;
  console.log(`%c${arrow}%c ${label}`, `color: ${color};`, 'color: black', ...args);
}

const statusEl = document.getElementById('status');
const sourceEl = document.getElementById('source');
const varsEl = document.getElementById('vars');
const outputEl = document.getElementById('output');
const sourceCache = new Map();

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
    try {
      const res = await fetch(filename);
      text = res.ok ? await res.text() : `(HTTP ${res.status} fetching ${filename})`;
    } catch(e) {
      text = `(could not load ${filename}: ${e})`;
    }

    sourceCache.set(filename, text);
  }

  sourceEl.innerHTML = '';

  text.split('\n').forEach((codeLine, i) => {
    const div = document.createElement('div');

    if(i + 1 === line) div.className = 'current';

    const no = document.createElement('span');
    no.className = 'line-no';
    no.textContent = i + 1;

    div.append(no, codeLine);
    sourceEl.appendChild(div);
  });

  sourceEl.querySelector('.current')?.scrollIntoView({ block: 'center' });
}

async function refresh() {
  const frames = await request('stackTrace');
  const frame = frames[0];

  if(!frame) return;

  await showSource(frame.filename, frame.line);

  varsEl.innerHTML = '';

  for(const scope of await request('scopes', { frameId: frame.id })) {
    if(scope.expensive)
      // skip Global: huge builtin list, not useful here
      continue;

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

const keyMap = {
  F5: 'continue',
  F9: 'pause',
  F10: 'next',
  F11: 'stepIn',
  F12: 'stepOut',
};

for(const [key, id] of Object.entries(keyMap)) {
  document.getElementById(id).title = key;
}

for(const id of ['continue', 'next', 'stepIn', 'stepOut', 'pause']) {
  document.getElementById(id).addEventListener('click', () => request(id));
}

document.addEventListener('keydown', e => {
  const id = keyMap[e.key];

  if(id) {
    e.preventDefault();
    request(id);
  }
});

ws = new WebSocket(`ws://${location.host}/debug`, 'browser');
ws.binaryType = 'arraybuffer';

ws.onopen = () => setStatus('connected — waiting for a debug target…');
ws.onclose = () => setStatus('disconnected');
ws.onerror = () => setStatus('connection error');
ws.onmessage = ({data}) => {
  const bytes = typeof data == 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);

  if(bytes[0] === 0x7b) onFrame(new TextDecoder().decode(bytes));
  else onOutput(bytes[0], new TextDecoder().decode(bytes.subarray(1)));
};
