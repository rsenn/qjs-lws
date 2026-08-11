# CDP Inspector

A Chrome DevTools Protocol (CDP) inspector that connects to Chrome/Chromium and single-steps through scripts using the Debugger domain.

## Prerequisites

Start Chrome/Chromium with remote debugging enabled:

```bash
# Linux
google-chrome --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1

# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1

# Windows
chrome.exe --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
```

Open a test page in Chrome, e.g.:
```bash
# Open the test HTML file
chrome file:///path/to/qjs-lws/inspector-test.html
```

## Usage

```bash
# Connect to default port 9222
qjsm inspector.js

# Connect to custom port
qjsm inspector.js 9223

# Enable debug logging
DEBUG=1 qjsm inspector.js
```

## What it does

1. **Discovers targets** - HTTP GET `/json/list` to find available debug targets
2. **Connects via WebSocket** - Connects to the target's `webSocketDebuggerUrl`
3. **Enables debugging** - Enables `Debugger` and `Runtime` domains
4. **Pauses execution** - Pauses on the first statement
5. **Single-steps** - Steps through the script, printing:
   - Current location (file, line, column)
   - Call stack
   - Local variables in each scope
6. **Handles events** - Prints script parsing, console output, exceptions

## Example Output

```
Connecting to CDP at 127.0.0.1:9222...
Target: CDP Inspector Test Target
URL: file:///path/to/inspector-test.html
WebSocket: ws://127.0.0.1:9222/devtools/page/ABC123

Connected to debugger.

Debugger enabled.
Runtime enabled.
Pause on exceptions: enabled.

Waiting for debugger events...

[script parsed] 12
[execution context] 1: 
[paused] reason: other
  at (anonymous) (12:2:2)
  [local scope]
    numbers: [1,2,3,4,5]
    processed: undefined
    i: 0
  [closure scope]

  [stepping...]
```

## Architecture

The inspector uses:
- **`httpClient`** (from `lib/lws/protocols.js`) for HTTP discovery requests
- **`client`** (WsClientProtocol) for WebSocket CDP communication
- **LWS context** with SSL support for secure connections

CDP wire format:
- **Requests**: `{"id":N,"method":"Domain.method","params":{...}}`
- **Responses**: `{"id":N,"result":{...}}` or `{"id":N,"error":{...}}`
- **Events**: `{"method":"Domain.event","params":{...}}`

## CDP Domains Used

- **Debugger**: enable, pause, resume, stepInto, stepOver, stepOut, setBreakpointByUrl, setPauseOnExceptions
- **Runtime**: enable, evaluate, getProperties, consoleAPICalled, exceptionThrown

## Files

- `inspector.js` - Main inspector script
- `inspector-test.html` - Simple test page with JavaScript to step through
- `inspector-debug.log` - Debug log (when DEBUG=1)

## Implementation Notes

- Uses the same HTTP/WebSocket client pattern as `gemini-client.js` and `ollama-client.js`
- Error handling includes response headers and body on HTTP failures (matching recent improvements)
- Graceful shutdown on Ctrl+C
- 30-second timeout on CDP requests
- Skips global scope variables (too verbose)
- Limits property display to first 10 items per scope
