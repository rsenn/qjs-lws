/**
 * CDP (Chrome DevTools Protocol) inspector - connects to a Chrome/Chromium
 * instance running with --remote-debugging-port and single-steps through a
 * script using the Debugger domain.
 *
 * Usage: qjsm inspector.js [port]
 *
 * Prerequisites:
 *   chrome --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
 *   (or use the default port 9222)
 *
 * Wire protocol:
 *   1. HTTP GET /json/list to discover debug targets and their webSocketDebuggerUrl
 *   2. WebSocket connection to that URL for CDP commands/events
 *   3. JSON messages: {"id":N,"method":"Domain.method","params":{...}} for requests
 *                      {"id":N,"result":{...}} for responses
 *                      {"method":"Domain.event","params":{...}} for events
 *
 * This script:
 *   - Discovers the first available target via HTTP
 *   - Connects to its WebSocket debugger URL
 *   - Enables the Debugger domain
 *   - Pauses on the first statement (via Debugger.pauseOnException or manual pause)
 *   - Single-steps through the script, printing source locations
 *   - Evaluates expressions at each pause
 */

import createContext from './lib/lws/context.js';
import { httpClient, client } from './lib/lws/protocols.js';
import { LCCSCF_PIPELINE, LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX, LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT, LWS_SERVER_OPTION_IGNORE_MISSING_CERT, toString } from 'lws.so';
import { Console } from 'console';
import { open } from 'std';

const DEFAULT_PORT = 9222;
const DEFAULT_HOST = '127.0.0.1';
const DEBUG_LOG_PATH = 'inspector-debug.log';

class CDPInspector {
  #ctx;
  #httpAdapter;
  #wsAdapter;
  #httpSettled = new Map();
  #wsSession = null;
  #debugConsole;
  #debugFile;
  #seq = 1;
  #pending = new Map();

  constructor(debug = false) {
    if(debug) {
      this.#debugFile = open(DEBUG_LOG_PATH, 'a');
      this.#debugConsole = new Console(this.#debugFile, { inspectOptions: { depth: Infinity, compact: false } });
    }

    this.#httpAdapter = httpClient((req, resp) => this.#resolveHttp(req, resp), { error: (req, err) => this.#rejectHttp(req, err) });

    this.#wsAdapter = client({
      open: wsi => this.#onWsOpen(wsi),
      message: (wsi, data) => this.#onWsMessage(wsi, data),
      close: (wsi, code, reason) => this.#onWsClose(wsi, code, reason),
      error: (wsi, msg) => this.#onWsError(wsi, msg),
    });

    this.#ctx = createContext({
      options: LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT | LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX | LWS_SERVER_OPTION_IGNORE_MISSING_CERT,
      protocols: [
        { name: 'http', ...this.#httpAdapter },
        { name: 'ws', ...this.#wsAdapter },
      ],
      timeout_secs: 30,
    });
  }

  async #discoverTargets(host, port) {
    const url = `http://${host}:${port}/json/list`;
    this.#debugConsole?.debug('Discovering targets:', url);

    const { req } = await this.#httpAdapter.connect(this.#ctx, url, {
      method: 'GET',
      ssl_connection: LCCSCF_PIPELINE,
    });

    const resp = await this.#awaitHttp(req);

    if(resp.status < 200 || resp.status >= 300) {
      const headers = {};
      resp.headers?.forEach((v, k) => (headers[k] = v));
      const body = await resp.text().catch(() => '');
      throw new Error(`CDP HTTP ${resp.status}\nheaders: ${JSON.stringify(headers, null, 2)}\nbody: ${body}`);
    }

    const targets = await resp.json();
    this.#debugConsole?.debug('Targets:', targets);

    return targets;
  }

  #awaitHttp(req) {
    return new Promise((resolve, reject) => {
      this.#httpSettled.set(req, { resolve, reject });
    });
  }

  #resolveHttp(req, resp) {
    const record = this.#httpSettled.get(req);
    this.#httpSettled.delete(req);
    record?.resolve(resp);
  }

  #rejectHttp(req, err) {
    const reason = new Error(`CDP connection failed: ${err.message}`);
    if(req) {
      this.#httpSettled.get(req)?.reject(reason);
      this.#httpSettled.delete(req);
      return;
    }
    for(const { reject } of this.#httpSettled.values()) reject(reason);
    this.#httpSettled.clear();
  }

  async #connectToTarget(wsUrl) {
    this.#debugConsole?.debug('Connecting to WebSocket:', wsUrl);

    const { wsi } = this.#wsAdapter.connect(this.#ctx, wsUrl, {
      protocol: 'ws',
      localProtocolName: 'ws',
      ssl_connection: LCCSCF_PIPELINE,
    });

    this.#wsSession = wsi;
    this.#debugConsole?.debug('WebSocket session:', wsi);
  }

  #onWsOpen(wsi) {
    this.#debugConsole?.debug('WebSocket opened');
    const pending = this.#pending.get('_connect');
    if(pending) {
      clearTimeout(pending.timeout);
      this.#pending.delete('_connect');
      pending.resolve(wsi);
    }
  }

  #onWsMessage(wsi, data) {
    const text = typeof data === 'string' ? data : toString(data);
    this.#debugConsole?.debug('WS message:', text);

    try {
      const msg = JSON.parse(text);

      if(msg.id !== undefined) {
        // Response to a request
        const pending = this.#pending.get(msg.id);
        if(pending) {
          clearTimeout(pending.timeout);
          this.#pending.delete(msg.id);
          if(msg.error) {
            pending.reject(new Error(`CDP error ${msg.error.code}: ${msg.error.message}`));
          } else {
            pending.resolve(msg.result);
          }
        }
      } else if(msg.method) {
        // Event
        this.#onEvent(msg.method, msg.params);
      }
    } catch(e) {
      this.#debugConsole?.error('Failed to parse message:', e, text);
    }
  }

  #onWsClose(wsi, code, reason) {
    this.#debugConsole?.debug('WebSocket closed:', code, reason);
    this.#wsSession = null;

    // Reject all pending requests
    for(const [id, pending] of this.#pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`WebSocket closed: ${code} ${reason}`));
    }
    this.#pending.clear();
  }

  #onWsError(wsi, msg) {
    this.#debugConsole?.error('WebSocket error:', msg);
    const pending = this.#pending.get('_connect');
    if(pending) {
      clearTimeout(pending.timeout);
      this.#pending.delete('_connect');
      pending.reject(new Error(`WebSocket error: ${msg}`));
    }
  }

  async #send(method, params = {}) {
    if(!this.#wsSession) throw new Error('Not connected');

    const id = this.#seq++;
    const msg = { id, method, params };
    const text = JSON.stringify(msg);

    this.#debugConsole?.debug('Sending:', text);
    this.#wsSession.write(text);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`CDP request timeout: ${method}`)), 30000);
      this.#pending.set(id, { resolve, reject, timeout });
    });
  }

  #onEvent(method, params) {
    this.#debugConsole?.debug('Event:', method, params);

    switch (method) {
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
      await this.#send('Debugger.resume');
      return;
    }

    // Print scope variables
    for(const scope of frame.scopeChain) {
      if(scope.type === 'global') continue; // Skip global scope (too verbose)

      console.log(`  [${scope.type} scope]`);
      try {
        const result = await this.#send('Runtime.getProperties', {
          objectId: scope.object.objectId,
          ownProperties: true,
        });

        for(const prop of result.result.slice(0, 10)) {
          // Limit to first 10 properties
          const value = prop.value?.value !== undefined ? String(prop.value.value) : prop.value?.description || prop.value?.type || '(unknown)';
          console.log(`    ${prop.name}: ${value}`);
        }
        if(result.result.length > 10) {
          console.log(`    ... (${result.result.length - 10} more)`);
        }
      } catch(e) {
        console.log(`    (failed to get properties: ${e.message})`);
      }
    }

    // Single-step
    console.log('\n  [stepping...]');
    await this.#send('Debugger.stepInto');
  }

  async run(host = DEFAULT_HOST, port = DEFAULT_PORT) {
    console.log(`Connecting to CDP at ${host}:${port}...`);

    try {
      const targets = await this.#discoverTargets(host, port);

      if(targets.length === 0) {
        console.error('No debug targets found. Is Chrome running with --remote-debugging-port?');
        return;
      }

      // Pick the first page target
      const target = targets.find(t => t.type === 'page') || targets[0];
      console.log(`Target: ${target.title || target.url}`);
      console.log(`URL: ${target.url}`);

      // Chrome sometimes returns webSocketDebuggerUrl without the port, fix it
      let wsUrl = target.webSocketDebuggerUrl;
      if(wsUrl && !wsUrl.match(/:\d+\//)) {
        // No port in URL, add it
        wsUrl = wsUrl.replace(/^(ws:\/\/[^\/]+)/, `$1:${port}`);
      }
      console.log(`WebSocket: ${wsUrl}\n`);

      await this.#connectToTarget(wsUrl);
      console.log('Connected to debugger.', this.#wsSession);

      // Enable domains
      await this.#send('Debugger.enable');
      console.log('Debugger enabled.');

      await this.#send('Runtime.enable');
      console.log('Runtime enabled.');

      // Pause on exceptions
      await this.#send('Debugger.setPauseOnExceptions', { state: 'all' });
      console.log('Pause on exceptions: enabled.');

      // Set a breakpoint on the first line (optional)
      // await this.#send('Debugger.setBreakpointByUrl', { lineNumber: 0, url: target.url });

      console.log('\nWaiting for debugger events...\n');
      console.log('Use Ctrl+C to stop.\n');

      // Pause immediately
      await this.#send('Debugger.pause');
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
    this.#ctx?.destroy();
    this.#debugFile?.close();
  }
}

// Main
const port = parseInt(process.argv[2] || String(DEFAULT_PORT), 10);
const inspector = new CDPInspector(process.env.DEBUG);

inspector.run(DEFAULT_HOST, port).catch(err => {
  console.error('Fatal error:', err.message);
  inspector.destroy();
});
