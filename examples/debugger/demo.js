/**
 * Speaks the quickjs-debugger.c wire protocol directly over the WebSocket
 * that server.js forwards to/from the raw TCP debug target:
 *
 *     %08x '\n' <json> '\n'          (8 hex digit length, counts json + \n)
 *
 * server.js does not parse any of this — it only shovels bytes. Source files
 * are fetched as plain static assets from the same origin (server.js serves
 * the current directory), so `qjs target.js` must be run from this directory
 * for the reported filename to resolve.
 */

class FrameDecoder {
  #buf = new Uint8Array(0);
  #need = -1; // -1: waiting for the 9-byte header, else payload bytes wanted

  constructor(onFrame) {
    this.onFrame = onFrame;
  }

  push(chunk) {
    const add = new Uint8Array(chunk);
    const buf = new Uint8Array(this.#buf.length + add.length);
    buf.set(this.#buf, 0);
    buf.set(add, this.#buf.length);
    this.#buf = buf;

    for(;;) {
      if(this.#need < 0) {
        if(this.#buf.length < 9) return;

        this.#need = parseInt(new TextDecoder().decode(this.#buf.subarray(0, 8)), 16);
        this.#buf = this.#buf.subarray(9);
      }

      if(this.#buf.length < this.#need) return;

      const payload = this.#buf.subarray(0, this.#need);
      this.#buf = this.#buf.subarray(this.#need);
      this.#need = -1;

      let json = new TextDecoder().decode(payload);
      if(json.endsWith('\n')) json = json.slice(0, -1);

      this.onFrame(json);
    }
  }
}

function encodeFrame(jsonText) {
  const body = new TextEncoder().encode(jsonText);
  const header = new TextEncoder().encode((body.length + 1).toString(16).padStart(8, '0') + '\n');
  const out = new Uint8Array(header.length + body.length + 1);
  out.set(header, 0);
  out.set(body, header.length);
  out[out.length - 1] = 0x0a; // '\n'
  return out.buffer;
}

const statusEl = document.getElementById('status');
const sourceEl = document.getElementById('source');
const varsEl = document.getElementById('vars');
const sourceCache = new Map();

let ws,
  seq = 1;
const pending = new Map();

function setStatus(text) {
  statusEl.textContent = text;
}

function request(command, args) {
  const request_seq = seq++;
  const r = { type: 'request', request: { command, request_seq, args } };
  //console.log('sending req',  r);
  ws.send(encodeFrame(JSON.stringify(r)));
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

  //console.log('received frame',  msg);

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

for(const id of ['continue', 'next', 'stepIn', 'stepOut', 'pause']) {
  document.getElementById(id).addEventListener('click', () => request(id));
}

ws = new WebSocket(`ws://${location.host}/debug`, 'browser');
ws.binaryType = 'arraybuffer';

const decoder = new FrameDecoder(onFrame);

ws.onopen = () => setStatus('connected — waiting for a debug target…');
ws.onclose = () => setStatus('disconnected');
ws.onerror = () => setStatus('connection error');
ws.onmessage = event => {
  let { data } = event;

  if(typeof data == 'string') data = new TextEncoder('utf-8').encode(data).buffer;

  decoder.push(data);
};
