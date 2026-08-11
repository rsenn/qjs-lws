/**
 * CDP (Chrome DevTools Protocol) inspector - connects to Chrome/Chromium
 * running with --remote-debugging-port and single-steps through scripts.
 *
 * Usage: qjsm inspector.js [port]
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
import * as std from 'std';
import * as os from 'os';
import { LLL_USER, LLL_WARN, LLL_ERR, logLevel } from 'lws.so';

const DEFAULT_PORT = process.env.CDP_PORT ? +process.env.CDP_PORT : 9222;
const DEFAULT_HOST = process.env.CDP_HOST ? process.env.CDP_HOST : '127.0.0.1';
const DEBUG_LOG_PATH = 'inspector-debug.log';

logLevel((process.env.DEBUG ? LLL_USER : 0) | LLL_WARN | LLL_ERR, (l, m) => console.log(m.replace(/: \w+: /, ': ')));

/**
 * Raw terminal input handler - puts stdin in raw mode and parses key sequences
 */
const HISTORY_MAX = 500;
const HISTORY_PATH = (process.env.HOME || '/tmp') + '/.qjs-inspector-history';

class TerminalInput {
  #fd = 0; // stdin
  #buffer = '';
  #textInput = '';
  #cursorPos = 0; // Current cursor position in textInput
  #onKey = null;
  #onText = null;
  #escapeTimer = null;
  #prompt = '> ';
  #history = [];
  #historyIndex = -1;
  #savedLine = '';

  constructor() {
    if(!os.isatty(this.#fd)) {
      throw new Error('stdin is not a TTY');
    }
    this.#loadHistory();
  }

  #loadHistory() {
    try {
      const f = std.open(HISTORY_PATH, 'r');
      if(f) {
        let line;
        while((line = f.getline()) !== null) {
          line = line.trim();
          if(line) this.#history.push(line);
        }
        f.close();
        if(this.#history.length > HISTORY_MAX) {
          this.#history = this.#history.slice(-HISTORY_MAX);
        }
      }
    } catch(e) {
      // History file doesn't exist yet, start fresh
    }
    this.#historyIndex = this.#history.length;
  }

  saveHistory() {
    try {
      const f = std.open(HISTORY_PATH, 'w');
      if(f) {
        const start = Math.max(0, this.#history.length - HISTORY_MAX);
        for(let i = start; i < this.#history.length; i++) {
          f.puts(this.#history[i] + '\n');
        }
        f.flush();
        f.close();
      }
    } catch(e) {
      // Ignore write errors
    }
  }

  start(onKey, onText) {
    this.#onKey = onKey;
    this.#onText = onText;
    os.ttySetRaw(this.#fd);
    os.setReadHandler(this.#fd, () => this.#onData());
    this.#redrawLine(); // Show initial prompt
  }

  stop() {
    os.setReadHandler(this.#fd, null);
  }

  #onData() {
    const buf = new ArrayBuffer(64);
    const n = os.read(this.#fd, buf, 0, 64);
    if(n <= 0) return;

    const decoder = new TextDecoder();
    const data = decoder.decode(new Uint8Array(buf, 0, n));
    this.#buffer += data;
    this.#processBuffer();
  }

  #processBuffer() {
    while(this.#buffer.length > 0) {
      // Handle escape sequences
      if(this.#buffer[0] === '\x1b') {
        // If buffer is just ESC, wait a bit to see if more comes
        if(this.#buffer.length === 1) {
          if(!this.#escapeTimer) {
            this.#escapeTimer = setTimeout(() => {
              // ESC pressed alone - clear line
              this.#onKey?.('escape');
              this.#buffer = '';
              this.#escapeTimer = null;
            }, 50);
          }
          break;
        }

        // Clear pending ESC timer
        if(this.#escapeTimer) {
          clearTimeout(this.#escapeTimer);
          this.#escapeTimer = null;
        }

        // Parse escape sequence
        const seq = this.#parseEscapeSequence();
        if(seq === null) {
          // Incomplete sequence, wait for more data
          break;
        }
        this.#handleSequence(seq);
        continue;
      }

      // Handle control characters and text input
      const ch = this.#buffer[0];
      this.#buffer = this.#buffer.slice(1);

      if(ch === '\x03') {
        // Ctrl+C
        this.#onKey?.('ctrl-c');
      } else if(ch === '\r' || ch === '\n') {
        // Enter - submit the text
        this.#submitLine();
      } else if(ch === '\x7f' || ch === '\x08') {
        // Backspace - delete character before cursor
        this.#backspace();
      } else if(ch === '\x04') {
        // Ctrl+D - delete character at cursor
        this.#deleteAtCursor();
      } else if(ch === '\x01') {
        // Ctrl+A - move to beginning of line
        this.#moveCursor(0);
      } else if(ch === '\x05') {
        // Ctrl+E - move to end of line
        this.#moveCursor(this.#textInput.length);
      } else if(ch === '\x0b') {
        // Ctrl+K - kill to end of line
        this.#killToEnd();
      } else if(ch === '\x15') {
        // Ctrl+U - kill to beginning of line
        this.#killToStart();
      } else if(ch >= '\x01' && ch <= '\x1a') {
        // Other control characters
        this.#onKey?.(`ctrl-${String.fromCharCode(ch.charCodeAt(0) + 96)}`);
      } else if(this.#textInput === '' && 'gnso'.includes(ch)) {
        // Letter shortcuts only when line is empty (avoid conflict with expression input)
        this.#onKey?.(ch);
      } else {
        // Regular printable character - insert at cursor
        this.#insertChar(ch);
      }
    }
  }

  #insertChar(ch) {
    this.#textInput = this.#textInput.slice(0, this.#cursorPos) + ch + this.#textInput.slice(this.#cursorPos);
    this.#cursorPos++;
    this.#redrawLine();
  }

  #backspace() {
    if(this.#cursorPos > 0) {
      this.#textInput = this.#textInput.slice(0, this.#cursorPos - 1) + this.#textInput.slice(this.#cursorPos);
      this.#cursorPos--;
      this.#redrawLine();
    }
  }

  #deleteAtCursor() {
    if(this.#cursorPos < this.#textInput.length) {
      this.#textInput = this.#textInput.slice(0, this.#cursorPos) + this.#textInput.slice(this.#cursorPos + 1);
      this.#redrawLine();
    }
  }

  #moveCursor(pos) {
    this.#cursorPos = Math.max(0, Math.min(pos, this.#textInput.length));
    this.#redrawLine();
  }

  #killToEnd() {
    this.#textInput = this.#textInput.slice(0, this.#cursorPos);
    this.#redrawLine();
  }

  #killToStart() {
    this.#textInput = this.#textInput.slice(this.#cursorPos);
    this.#cursorPos = 0;
    this.#redrawLine();
  }

  #submitLine() {
    const text = this.#textInput.trim();
    if(text) {
      // Add to history (skip duplicates of last entry)
      if(this.#history.length === 0 || this.#history[this.#history.length - 1] !== text) {
        this.#history.push(text);
      }
      this.#historyIndex = this.#history.length;
      this.#onText?.(text);
    }
    this.#textInput = '';
    this.#cursorPos = 0;
    this.#savedLine = '';
    std.out.puts('\n');
    std.out.flush();
  }

  #redrawLine() {
    // Clear current line and redraw with prompt
    const clearToEol = '\x1b[K'; // Clear from cursor to end of line
    const moveToStart = '\r'; // Carriage return to start of line

    // Move to start, clear line, write prompt and text
    std.out.puts(moveToStart + clearToEol + this.#prompt + this.#textInput);

    // Move cursor back to correct position (accounting for prompt length)
    if(this.#cursorPos < this.#textInput.length) {
      const moveBack = this.#textInput.length - this.#cursorPos;
      std.out.puts(`\x1b[${moveBack}D`); // Move cursor left
    }

    std.out.flush();
  }

  #handleSequence(seq) {
    switch (seq) {
      case 'up':
        this.#historyPrev();
        break;
      case 'down':
        this.#historyNext();
        break;
      case 'left':
        if(this.#cursorPos > 0) {
          this.#cursorPos--;
          this.#redrawLine();
        }
        break;
      case 'right':
        if(this.#cursorPos < this.#textInput.length) {
          this.#cursorPos++;
          this.#redrawLine();
        }
        break;
      case 'home':
        this.#moveCursor(0);
        break;
      case 'end':
        this.#moveCursor(this.#textInput.length);
        break;
      default:
        // Pass through other sequences (function keys, etc.)
        this.#onKey?.(seq);
    }
  }

  #historyPrev() {
    if(this.#history.length === 0) return;
    if(this.#historyIndex > 0) {
      if(this.#historyIndex === this.#history.length) {
        this.#savedLine = this.#textInput;
      }
      this.#historyIndex--;
      this.#textInput = this.#history[this.#historyIndex];
      this.#cursorPos = this.#textInput.length;
      this.#redrawLine();
    }
  }

  #historyNext() {
    if(this.#historyIndex < this.#history.length) {
      this.#historyIndex++;
      if(this.#historyIndex === this.#history.length) {
        this.#textInput = this.#savedLine;
      } else {
        this.#textInput = this.#history[this.#historyIndex];
      }
      this.#cursorPos = this.#textInput.length;
      this.#redrawLine();
    }
  }

  #parseEscapeSequence() {
    // Common escape sequences - multiple variants for different terminals
    // (xterm, screen, tmux, etc. send different sequences)
    const sequences = {
      // Standard xterm sequences
      '\x1b[15~': 'f5',
      '\x1b[17~': 'f6',
      '\x1b[18~': 'f7',
      '\x1b[19~': 'f8',
      '\x1b[20~': 'f9',
      '\x1b[21~': 'f10',
      '\x1b[23~': 'f11',
      '\x1b[24~': 'f12',

      // Screen/tmux variants (often use [25~ and [26~ for F11/F12)
      '\x1b[25~': 'f11',
      '\x1b[26~': 'f12',

      // Shift variants
      '\x1b[23;2~': 'shift-f11',
      '\x1b[24;2~': 'shift-f12',
      '\x1b[25;2~': 'shift-f11',
      '\x1b[26;2~': 'shift-f12',

      // Alternative F11/F12 sequences (some terminals)
      '\x1b[28~': 'f11',
      '\x1b[29~': 'f12',

      // Arrow keys
      '\x1b[A': 'up',
      '\x1b[B': 'down',
      '\x1b[C': 'right',
      '\x1b[D': 'left',

      // Screen-specific sequences (sometimes prefixed with Esc-O)
      '\x1bO15~': 'f5',
      '\x1bO17~': 'f6',
      '\x1bO18~': 'f7',
      '\x1bO19~': 'f8',
      '\x1bO20~': 'f9',
      '\x1bO21~': 'f10',
      '\x1bO23~': 'f11',
      '\x1bO24~': 'f12',
    };

    // Check if we have a complete sequence
    for(const [seq, key] of Object.entries(sequences)) {
      if(this.#buffer.startsWith(seq)) {
        this.#buffer = this.#buffer.slice(seq.length);
        return key;
      }
    }

    // Check if buffer could be start of a sequence
    if(this.#buffer.length < 8) {
      // Might be incomplete, wait for more
      return null;
    }

    // Unknown sequence, consume the ESC and continue
    this.#buffer = this.#buffer.slice(1);
    return 'escape';
  }
}

class CDPInspector {
  #ws;
  #writer;
  #seq = 1;
  #pending = new Map();
  #running = true;
  #debugLog = null;
  #terminal = null;
  #paused = false;
  #currentParams = null;
  #scripts = new Map(); // scriptId -> url

  constructor() {
    if(process.env.DEBUG) {
      try {
        this.#debugLog = std.open(DEBUG_LOG_PATH, 'a');
      } catch(e) {
        console.error(`Failed to open debug log: ${e.message}`);
      }
    }
  }

  #printHelp() {
    console.log('\nDebugger controls:');
    console.log('  F5 / g      - Continue (when paused) or Interrupt (when running)');
    console.log('  F10 / n     - Step Over (next)');
    console.log('  F11 / s     - Step Into');
    console.log('  Shift+F11 / o - Step Out');
    console.log('  ESC         - Stop debugger');
    console.log('  Ctrl+C      - Exit');
    console.log('  Up/Down     - Navigate command history');
    console.log('  Type any expression and press Enter to evaluate in the page context\n');
  }

  async #handleKey(key) {
    // Screen/tmux-friendly letter shortcuts (GDB conventions)
    const keyMap = {
      'g': 'f5',         // go/continue
      'n': 'f10',        // next (step over)
      's': 'f11',        // step into
      'o': 'shift-f11',  // step out
    };

    const mappedKey = keyMap[key] || key;

    switch(mappedKey) {
      case 'f5':
        if(this.#paused) {
          console.log('[continue]');
          this.#paused = false;
          await this.send('Debugger.resume');
        } else {
          console.log('[interrupt]');
          await this.send('Debugger.pause');
        }
        break;

      case 'f10':
        if(this.#paused) {
          console.log('[step over]');
          await this.send('Debugger.stepOver');
        }
        break;

      case 'f11':
        if(this.#paused) {
          console.log('[step into]');
          await this.send('Debugger.stepInto');
        }
        break;

      case 'shift-f11':
        if(this.#paused) {
          console.log('[step out]');
          await this.send('Debugger.stepOut');
        }
        break;

      case 'escape':
        console.log('\n[stopping debugger]');
        await this.send('Debugger.disable');
        this.destroy();
        std.exit(0);
        break;

      case 'ctrl-c':
        console.log('\n[exiting]');
        this.destroy();
        std.exit(0);
        break;
    }
  }

  async #evaluateExpression(text) {
    try {
      const result = await this.send('Runtime.evaluate', {
        expression: text,
        returnByValue: true,
        generatePreview: false,
      });

      if(result.exceptionDetails) {
        const error = result.exceptionDetails;
        if(error.exception?.description) {
          console.error(`\x1b[31m${error.exception.description}\x1b[0m`);
        } else if(error.text) {
          console.error(`\x1b[31m${error.text}\x1b[0m`);
        } else {
          console.error('\x1b[31mUnknown error\x1b[0m');
        }
      } else {
        const value = result.result;
        if(value.value === undefined) {
          console.log('\x1b[90mundefined\x1b[0m');
        } else if(value.value === null) {
          console.log('\x1b[90mnull\x1b[0m');
        } else if(typeof value.value === 'string') {
          console.log(`\x1b[33m"${value.value}"\x1b[0m`);
        } else if(typeof value.value === 'number') {
          console.log(`\x1b[34m${value.value}\x1b[0m`);
        } else if(typeof value.value === 'boolean') {
          console.log(`\x1b[34m${value.value}\x1b[0m`);
        } else {
          console.log(JSON.stringify(value.value, null, 2));
        }
      }
    } catch(e) {
      console.error(`Evaluation error: ${e.message}`);
    }
  }

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

        const rawJson = buf.slice(start, end + 1);
        try {
          const msg = JSON.parse(rawJson);

          // Log received message if debug logging is enabled
          if(this.#debugLog) {
            this.#debugLog.puts(`RX: ${rawJson}\n`);
            this.#debugLog.flush();
          }

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
      if(escape) {
        escape = false;
        continue;
      }
      if(c === '\\' && inString) {
        escape = true;
        continue;
      }
      if(c === '"') {
        inString = !inString;
        continue;
      }
      if(inString) continue;
      if(c === '{') depth++;
      else if(c === '}') {
        depth--;
        if(depth === 0) return i;
      }
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
    const json = JSON.stringify(msg);

    // Log raw write traffic if DEBUG is enabled
    if(this.#debugLog) {
      try {
        this.#debugLog.puts(`TX: ${json}\n`);
        this.#debugLog.flush();
      } catch(e) {
        console.error(`Failed to write debug log: ${e.message}`);
      }
    }

    await this.#writer.write(json);

    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
  }

  #onEvent(method, params) {
    switch (method) {
      case 'Debugger.scriptParsed':
        this.#scripts.set(params.scriptId, params.url || params.scriptId);
        console.log(`[script parsed] ${params.url || params.scriptId}`);
        break;

      case 'Debugger.paused':
        this.#paused = true;
        this.#currentParams = params;
        console.log(`\n[paused] reason: ${params.reason}`);
        if(params.callFrames?.length > 0) {
          this.#printCurrentLocation(params.callFrames[0]);
        }
        this.#handlePaused(params);
        break;

      case 'Debugger.resumed':
        this.#paused = false;
        this.#currentParams = null;
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

  #printCurrentLocation(frame) {
    const loc = frame.location;
    const funcName = frame.functionName || '(anonymous)';
    const url = this.#scripts.get(loc.scriptId) || loc.scriptId;

    console.log(`\n  ► ${url}:${loc.lineNumber}`);
    console.log(`    at ${funcName}`);
  }

  async #handlePaused(params) {
    const frame = params.callFrames?.[0];
    if(!frame) {
      console.log('  (no call frames)');
      this.#printHelp();
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

    // Show location again before help menu
    this.#printCurrentLocation(frame);
    this.#printHelp();
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

      // Initialize terminal input for keyboard controls
      try {
        this.#terminal = new TerminalInput();
        this.#terminal.start(
          key => this.#handleKey(key),
          text => this.#evaluateExpression(text),
        );
        this.#printHelp();
      } catch(e) {
        console.error(`Warning: ${e.message} - keyboard controls disabled`);
      }

      await this.send('Debugger.enable');
      console.log('Debugger enabled.');

      await this.send('Runtime.enable');
      console.log('Runtime enabled.');

      await this.send('Debugger.setPauseOnExceptions', { state: 'all' });
      console.log('Pause on exceptions: enabled.');

      console.log('\nWaiting for debugger events...\n');

      await this.send('Debugger.pause');
      console.log('Paused. Use keyboard controls to debug.\n');

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
    if(this.#terminal) {
      this.#terminal.saveHistory();
      this.#terminal.stop();
      this.#terminal = null;
    }
    this.#ws?.close();
    if(this.#debugLog) {
      try {
        this.#debugLog.close();
      } catch(e) {
        // Ignore close errors
      }
    }
  }
}

// Main
const port = parseInt(process.argv[2] || String(DEFAULT_PORT), 10);
const inspector = new CDPInspector();

inspector.run(DEFAULT_HOST, port).catch(err => {
  console.error('Fatal error:', err.message);
  inspector.destroy();
});
