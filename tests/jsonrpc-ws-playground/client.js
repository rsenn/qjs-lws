import { createWebSocketClient } from './lib/rpc/socket-client.js';
import { createWebSocketServer } from './lib/rpc/socket-server.js';
import { createRemoteObjectFactory } from './lib/rpc/remote-object-factory.js';
import { createRemoteObjectEndpoint } from './lib/rpc/remote-object-endpoint.js';
import { JsonRpcHandler } from './lib/rpc/json-rpc-handler.js';

const log = document.getElementById('log');
const classSelect = document.getElementById('class-select');
const argsInput = document.getElementById('ctor-args');
const instantiateBtn = document.getElementById('instantiate');
const instances = document.getElementById('instances');

function print(...args) {
  const line = document.createElement('div');
  line.textContent = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

const ws = new WebSocket(`ws://${location.host}/rpc`, 'jsonrpc');

await new Promise((resolve, reject) => {
  ws.addEventListener('open', () => resolve(), { once: true });
  ws.addEventListener('error', () => reject(new Error('WebSocket error')), { once: true });
});
ws.addEventListener('close', () => print('WebSocket closed'));

print('connected to', ws.url);

const call = createWebSocketClient(ws).call;
const factory = createRemoteObjectFactory(call);
window.factory = factory; // for poking at the /rpc endpoint's remote objects from the devtools console

/* Reversed-roles endpoint: this page also dials out to /rpc-reverse and,
   once connected, plays the JSON-RPC *server* itself (createWebSocketServer(),
   ./lib/rpc/socket-server.js) via the same createRemoteObjectEndpoint()
   methods table the real server uses for /rpc - so the terminal REPL on the
   test-jsonrpc-ws.js side (globalThis.factory there) can instantiate,
   invoke, and inspect classes running in *this* page. */
const reverseWs = new WebSocket(`ws://${location.host}/rpc-reverse`, 'jsonrpc-reverse');

await new Promise((resolve, reject) => {
  reverseWs.addEventListener('open', () => resolve(), { once: true });
  reverseWs.addEventListener('error', () => reject(new Error('WebSocket error')), { once: true });
});
createWebSocketServer(reverseWs, new JsonRpcHandler({ methods: createRemoteObjectEndpoint({ Array, Map, Set, Date, Uint32Array }) }));
print('serving /rpc-reverse (browser is the JSON-RPC server here)');

for(const name of await call('list', [])) {
  const option = document.createElement('option');
  option.value = name;
  option.textContent = name;
  classSelect.appendChild(option);
}

/** Renders one instantiated remote object as a card: its methods (callable, with a JSON-args field) and properties (fetched async, with a refresh button). */
function renderInstance(className, obj) {
  const card = document.createElement('div');
  card.className = 'card';

  const title = document.createElement('h3');
  title.textContent = `${className} #${factory.id(obj)}`;
  card.appendChild(title);

  for(const key of Reflect.ownKeys(obj)) {
    if(typeof key !== 'string') continue; // skip symbol keys (e.g. Symbol.iterator) in the UI

    const value = obj[key];
    const row = document.createElement('div');
    row.className = 'row';

    const label = document.createElement('span');
    label.textContent = key;
    row.appendChild(label);

    if(typeof value === 'function') {
      const argsField = document.createElement('input');
      argsField.placeholder = 'args, JSON array';
      const button = document.createElement('button');
      button.textContent = 'call';
      const result = document.createElement('span');
      result.className = 'result';

      button.addEventListener('click', async () => {
        let callArgs;
        try {
          callArgs = JSON.parse(argsField.value || '[]');
        } catch(error) {
          result.textContent = 'bad args JSON';
          return;
        }

        try {
          const r = await value(...callArgs);
          result.textContent = JSON.stringify(r);
          print(className, `#${factory.id(obj)}.${key}(${argsField.value || ''}) =`, r);
        } catch(error) {
          result.textContent = 'error: ' + error.message;
        }
      });

      row.append(argsField, button, result);
    } else {
      // a property access - `value` is already the in-flight/resolved get() promise
      const result = document.createElement('span');
      result.className = 'result';
      result.textContent = '...';
      value.then(v => (result.textContent = JSON.stringify(v))).catch(e => (result.textContent = 'error: ' + e.message));

      const refresh = document.createElement('button');
      refresh.textContent = '↻';
      refresh.title = 'refresh';
      refresh.addEventListener('click', async () => {
        result.textContent = '...';
        try {
          result.textContent = JSON.stringify(await obj[key]);
        } catch(error) {
          result.textContent = 'error: ' + error.message;
        }
      });

      row.append(result, refresh);
    }

    card.appendChild(row);
  }

  const del = document.createElement('button');
  del.textContent = 'delete instance';
  del.addEventListener('click', async () => {
    await factory.delete(obj);
    card.remove();
    print('deleted', className, `#${factory.id(obj)}`);
  });
  card.appendChild(del);

  instances.appendChild(card);
}

instantiateBtn.addEventListener('click', async () => {
  const className = classSelect.value;
  let args;

  try {
    args = JSON.parse(argsInput.value || '[]');
  } catch(error) {
    print('bad constructor args JSON:', error.message);
    return;
  }

  let obj;
  try {
    obj = await factory.new(className, ...args);
  } catch(error) {
    print('new', className, 'failed:', error.message);
    return;
  }

  print('created', className, `#${factory.id(obj)}`);
  renderInstance(className, obj);
});
