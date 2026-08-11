/**
 * CDP (Chrome DevTools Protocol) inspector - connects to Chrome/Chromium
 * running with --remote-debugging-port and single-steps through scripts.
 *
 * Usage: qjsm inspector2.js [port]
 *
 * Prerequisites:
 *   chrome --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
 *
 * Uses high-level abstractions:
 *   - fetch() from lib/fetch.js for HTTP discovery
 *   - WebSocketStream from lib/websocketstream.js for CDP communication
 */

import { fetch } from './lib/fetch.js';
import { WebSocketStream } from './lib/websocketstream.js';
import { TextDecoder } from 'textcode';

const DEFAULT_PORT = 9222;
const DEFAULT_HOST = '127.0.0.1';

class CDPInspector {
  #ws;
  #writer;
  #seq = 1;
  #pending = new Map();
  #running = true;

  async discoverTargets(host, port) {
    const url = `http://${host}:${port}/json/list`;
    const resp = await fetch(url);

    if(!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`CDP HTTP ${resp.status}: ${body}`);
    }

    return await resp.json();
  }

  async connect(wsUrl) {
    const wss = new WebSocketStream(wsUrl);
    const { readable, writable } = await wss.opened;

    this.#ws = wss;
    this.#writer = writable.getWriter();

    // Start reading messages in background
    this.#readMessages(readable).catch(err => {
      if(this.#running) console.error('WebSocket error:', err.message);
    });
  }

  async #readMessages(readable) {
    const reader = readable.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while(true) {
      const { done, value } = await reader.read();
      if(done) break;

      buf += typeof value === 'string' ? value : decoder.decode(value, { stream: true });

      // Try to extract complete JSON objects from the buffer
      let start = 0;
      while(start < buf.length) {
        const end = this.#findJsonObjectEnd(buf, start);
        if(end === -1) break;

        try {
          const msg = JSON.parse(buf.slice(start, end + 1));
          this.#dispatchMessage(msg);
        } catch(e) {
          // Skip malformed messages
        }
        start = end + 1;
      }
      buf = buf.slice(start);
    }
  }

  #findJsonObjectEnd(str, start) {
    let depth = 0;
    let inString = false;
    let escape = false;

    for(let i = start; i < str.length; i++) {
      const c = str[i];
      if(escape) { escape = false; continue; }
      if(c === '\\' && inString) { escape = true; continue; }
      if(c === '"') { inString = !inString; continue; }
      if(inString) continue;
      if(c === '{') depth++;
      else if(c === '}') { depth--; if(depth === 0) return i; }
    }
    return -1;
  }

  #dispatchMessage(msg) {
    if(msg.id !== undefined) {
      const pending = this.#pending.get(msg.id);
      if(pending) {
        this.#pending.delete(msg.id);
        if(msg.error) {
          pending.reject(new Error(`CDP error ${msg.error.code}: ${msg.error.message}`));
        } else {
          pending.resolve(msg.result);
        }
      }
    } else if(msg.method) {
      this.#onEvent(msg.method, msg.params);
    }
  }

  async send(method, params = {}) {
    if(!this.#ws) throw new Error('Not connected');

    const id = this.#seq++;
    const msg = { id, method, params };

    await this.#writer.write(JSON.stringify(msg));

    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
  }

  #onEvent(method, params) {
    switch(method) {
      case 'Debugger.scriptParsed':
        console.log(`[script parsed] ${params.url || params.scriptId}`);
        break;

      case 'Debugger.paused':
        console.log(`\n[paused] reason: ${params.reason}`);
        if(params.callFrames?.length > 0) {
          this.#printCallFrame(params.callFrames[0]);
        }
        this.#handlePaused(params);
        break;

      case 'Debugger.resumed':
        console.log('[resumed]');
        break;

      case 'Runtime.executionContextCreated':
        console.log(`[execution context] ${params.context.id}: ${params.context.name || '(unnamed)'}`);
        break;

      case 'Runtime.consoleAPICalled':
        const args = params.args.map(a => a.value || a.description || String(a)).join(' ');
        console.log(`[console.${params.type}]`, args);
        break;

      case 'Runtime.exceptionThrown':
        console.log(`[exception] ${params.exceptionDetails.text || 'unknown'}`);
        break;
    }
  }

  #printCallFrame(frame) {
    const loc = frame.location;
    const funcName = frame.functionName || '(anonymous)';
    console.log(`  at ${funcName} (${loc.scriptId}:${loc.lineNumber}:${loc.columnNumber})`);
  }

  async #handlePaused(params) {
    const frame = params.callFrames?.[0];
    if(!frame) {
      console.log('  (no call frames)');
      await this.send('Debugger.resume');
      return;
    }

    // Print scope variables
    for(const scope of frame.scopeChain) {
      if(scope.type === 'global') continue;

      console.log(`  [${scope.type} scope]`);
      try {
        const result = await this.send('Runtime.getProperties', {
          objectId: scope.object.objectId,
          ownProperties: true,
        });

        for(const prop of result.result.slice(0, 10)) {
          const value = prop.value?.value !== undefined
            ? String(prop.value.value)
            : prop.value?.description || prop.value?.type || '(unknown)';
          console.log(`    ${prop.name}: ${value}`);
        }
        if(result.result.length > 10) {
          console.log(`    ... (${result.result.length - 10} more)`);
        }
      } catch(e) {
        console.log(`    (failed to get properties: ${e.message})`);
      }
    }

    console.log('\n  [stepping...]');
    await this.send('Debugger.stepInto');
  }

  async run(host = DEFAULT_HOST, port = DEFAULT_PORT) {
    console.log(`Connecting to CDP at ${host}:${port}...`);

    try {
      const targets = await this.discoverTargets(host, port);

      if(targets.length === 0) {
        console.error('No debug targets found. Is Chrome running with --remote-debugging-port?');
        return;
      }

      const target = targets.find(t => t.type === 'page') || targets[0];
      console.log(`Target: ${target.title || target.url}`);
      console.log(`URL: ${target.url}`);

      let wsUrl = target.webSocketDebuggerUrl;
      if(wsUrl && !wsUrl.match(/:\d+\//)) {
        wsUrl = wsUrl.replace(/^(ws:\/\/[^\/]+)/, `$1:${port}`);
      }
      console.log(`WebSocket: ${wsUrl}\n`);

      await this.connect(wsUrl);
      console.log('Connected to debugger.\n');

      await this.send('Debugger.enable');
      console.log('Debugger enabled.');

      await this.send('Runtime.enable');
      console.log('Runtime enabled.');

      await this.send('Debugger.setPauseOnExceptions', { state: 'all' });
      console.log('Pause on exceptions: enabled.');

      console.log('\nWaiting for debugger events...\n');
      console.log('Use Ctrl+C to stop.\n');

      await this.send('Debugger.pause');
      console.log('Paused. Stepping through script...\n');

      // Keep the event loop alive
      await new Promise(() => {});
    } catch(e) {
      console.error('Error:', e.message);
      if(e.stack) console.error(e.stack);
    } finally {
      this.destroy();
    }
  }

  destroy() {
    this.#running = false;
    this.#ws?.close();
  }
}

// Main
const port = parseInt(process.argv[2] || String(DEFAULT_PORT), 10);
const inspector = new CDPInspector();

inspector.run(DEFAULT_HOST, port).catch(err => {
  console.error('Fatal error:', err.message);
  inspector.destroy();
});
