# CDP Inspector - Summary

## What Was Created

A complete Chrome DevTools Protocol (CDP) inspector that connects to Chrome/Chromium and single-steps through JavaScript code using the Debugger domain.

## Files Created

### Core Implementation
- **`inspector.js`** - Main inspector script (361 lines)
  - Uses `httpClient` from `lib/lws/protocols.js` for HTTP discovery
  - Uses `client` (WsClientProtocol) for WebSocket CDP communication
  - Implements CDP protocol for debugging and stepping
  - Includes comprehensive error handling with headers and body on HTTP failures

### Test & Documentation
- **`inspector-test.html`** - Test HTML page with JavaScript to step through
  - Contains `fibonacci()`, `processData()`, and `main()` functions
  - Demonstrates loops, function calls, and variable scoping

- **`inspector-README.md`** - Complete usage documentation
  - Prerequisites and setup instructions
  - Usage examples
  - Architecture overview
  - CDP protocol details

- **`test-inspector.sh`** - Automated test script
  - Starts Chrome with remote debugging
  - Opens test page
  - Runs inspector
  - Cleans up

## Key Features

### 1. Target Discovery
```javascript
const targets = await this.#discoverTargets(host, port);
// HTTP GET /json/list
// Returns array of debuggable targets
```

### 2. WebSocket Connection
```javascript
await this.#connectToTarget(target.webSocketDebuggerUrl);
// ws://127.0.0.1:9222/devtools/page/ABC123
```

### 3. CDP Command Protocol
```javascript
await this.#send('Debugger.enable');
await this.#send('Debugger.pause');
await this.#send('Debugger.stepInto');
await this.#send('Runtime.getProperties', { objectId: '...' });
```

### 4. Event Handling
- `Debugger.scriptParsed` - Script loaded
- `Debugger.paused` - Execution paused (breakpoint, step, exception)
- `Debugger.resumed` - Execution resumed
- `Runtime.consoleAPICalled` - Console output
- `Runtime.exceptionThrown` - Exceptions

### 5. Enhanced Error Messages
Following the pattern from recent improvements to `gemini-client.js`, `ollama-client.js`, and `openai-client.js`:
```javascript
if(resp.status < 200 || resp.status >= 300) {
  const headers = {};
  resp.headers?.forEach((v, k) => headers[k] = v);
  const body = await resp.text().catch(() => '');
  throw new Error(`CDP HTTP ${resp.status}\nheaders: ${JSON.stringify(headers, null, 2)}\nbody: ${body}`);
}
```

## Usage

### Manual Testing
```bash
# 1. Start Chrome with remote debugging
google-chrome --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1

# 2. Open test page in Chrome
chrome file:///path/to/inspector-test.html

# 3. Run inspector
qjsm inspector.js

# 4. Enable debug logging
DEBUG=1 qjsm inspector.js
```

### Automated Testing
```bash
./test-inspector.sh
```

## Architecture

### Components
1. **HTTP Client** - Discovers targets via `/json/list`
2. **WebSocket Client** - CDP communication
3. **CDP Protocol Handler** - Parses responses and events
4. **Debugger UI** - Prints call frames, variables, and steps

### Data Flow
```
inspector.js
  ↓
httpClient → HTTP GET /json/list
  ↓
Parse targets, select first page
  ↓
client → WebSocket connect to webSocketDebuggerUrl
  ↓
Send CDP commands (Debugger.enable, etc.)
  ↓
Receive responses and events
  ↓
Print debugging information and step
```

## CDP Domains Used

### Debugger
- `enable` - Enable debugger
- `pause` - Pause execution
- `resume` - Resume execution
- `stepInto` - Step into function calls
- `stepOver` - Step over function calls
- `stepOut` - Step out of current function
- `setBreakpointByUrl` - Set breakpoint by URL
- `setPauseOnExceptions` - Pause on exceptions

### Runtime
- `enable` - Enable runtime events
- `evaluate` - Evaluate expression
- `getProperties` - Get object properties
- `consoleAPICalled` - Console output event
- `exceptionThrown` - Exception event

## Testing Results

### Without Chrome Running
```
Connecting to CDP at 127.0.0.1:9222...
Error: CDP connection failed: conn fail: ECONNREFUSED
```

### With Chrome Running (Expected)
```
Connecting to CDP at 127.0.0.1:9222...
Target: CDP Inspector Test Target
URL: file:///path/to/inspector-test.html
WebSocket: ws://127.0.0.1:9222/devtools/page/ABC123

Connected to debugger.

Debugger enabled.
Runtime enabled.
Pause on exceptions: enabled.

[script parsed] 12
[execution context] 1: 
[paused] reason: other
  at (anonymous) (12:2:2)
  [local scope]
    numbers: [1,2,3,4,5]
    processed: undefined
  [closure scope]

  [stepping...]
```

## Implementation Details

### HTTP Client Pattern
Matches the pattern used in `gemini-client.js`, `ollama-client.js`, and `openai-client.js`:
- Uses `httpClient` adapter from `lib/lws/protocols.js`
- Promise-based request/response with `#settled` Map
- Timeout handling (30 seconds)
- Enhanced error messages with headers and body

### WebSocket Client Pattern
Uses `WsClientProtocol` (exported as `client()`):
- `{ open, message, close, error }` callbacks
- JSON message parsing
- Request/response correlation by ID
- Event dispatching

### Context Management
- LWS context with SSL support
- Timeout configuration (30 seconds)
- Graceful cleanup on errors

## Next Steps

To test with Chrome running:
1. Install Chrome/Chromium if not present
2. Run `./test-inspector.sh` for automated testing
3. Or manually start Chrome and run `qjsm inspector.js`

The inspector will:
- Connect to Chrome
- Pause on first statement
- Single-step through the test HTML's JavaScript
- Print call frames and variables at each pause
- Continue until the script completes or you press Ctrl+C
