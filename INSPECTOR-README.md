# CDP Inspector

A command-line Chrome DevTools Protocol inspector that connects to Chrome/Chromium and provides interactive debugging with keyboard controls similar to Turbo Debugger and Qt Creator.

## Features

- **HTTP Discovery**: Uses `fetch()` to discover Chrome debug targets via `/json/list`
- **WebSocket Communication**: Uses `WebSocketStream` for CDP protocol communication
- **Interactive Keyboard Controls**: Raw terminal input with function key and letter-based shortcuts
- **Step Debugging**: Step over, step into, step out, continue, and interrupt
- **Scope Inspection**: Displays local and closure scope variables when paused
- **Debug Logging**: Optional raw CDP message logging to `inspector-debug.log`

## Requirements

- Chrome/Chromium running with `--remote-debugging-port=9222`
- QuickJS with lws support

## Usage

```bash
# Start Chrome with remote debugging
google-chrome --remote-debugging-port=9222

# Run the inspector
qjsm inspector.js [port]
```

## Keyboard Controls

When paused at a breakpoint or exception:

| Key | Action |
|-----|--------|
| **F5** or **r/c/p** | Continue (when paused) or Interrupt (when running) |
| **F10** or **j** | Step Over |
| **F11** or **i** | Step Into |
| **Shift+F11** or **u** | Step Out |
| **ESC** or **q** | Stop debugger and exit |
| **Ctrl+C** | Exit immediately |

## Debug Logging

Set the `DEBUG` environment variable to log all raw CDP messages:

```bash
DEBUG=1 qjsm inspector.js
```

This creates `inspector-debug.log` with all WebSocket messages sent to Chrome.

## Architecture

The inspector uses high-level abstractions:

- **fetch()** from `lib/fetch.js` for HTTP discovery
- **WebSocketStream** from `lib/websocketstream.js` for WebSocket communication
- **TerminalInput** class for raw terminal input with escape sequence parsing

### TerminalInput Class

Puts stdin in raw mode using `os.ttySetRaw()` and parses:
- Function keys (F1-F12) with multiple escape sequence variants
- Shift+function key combinations
- Letter shortcuts for screen/tmux compatibility
- Control characters

Supports escape sequences from xterm, screen, tmux, and xfce4-terminal.

## Troubleshooting

### Function keys not working in screen/tmux

If F10/F11 don't work in GNU screen or tmux, use the letter shortcuts instead:
- **n** for step over (instead of F10)
- **s** for step into (instead of F11)
- **o** for step out (instead of Shift+F11)

The letter shortcuts bypass terminal multiplexer key interception.

### No debug targets found

Make sure Chrome is running with the remote debugging flag:
```bash
google-chrome --remote-debugging-port=9222
```

### Connection timeout

The inspector uses a 30-second timeout for WebSocket connections. If you're debugging a slow-loading page, you may need to wait for it to fully load before connecting.

## Example Session

```
Connecting to CDP at 127.0.0.1:9222...
Target: My Web App
URL: http://localhost:3000
WebSocket: ws://127.0.0.1:9222/devtools/page/ABC123

Connected to debugger.

Debugger controls:
  F5 / c      - Continue (when paused) or Interrupt (when running)
  F10 / n     - Step Over
  F11 / s     - Step Into
  Shift+F11 / o - Step Out
  ESC / q     - Stop debugger
  Ctrl+C      - Exit

Debugger enabled.
Runtime enabled.
Pause on exceptions: enabled.

[paused] reason: other
  at main (app.js:42:10)
  [local scope]
    x: 5
    y: 10
    result: undefined
  [closure scope]
    config: Object

Debugger controls:
  F5 / c      - Continue (when paused) or Interrupt (when running)
  F10 / n     - Step Over
  F11 / s     - Step Into
  Shift+F11 / o - Step Out
  ESC / q     - Stop debugger
  Ctrl+C      - Exit
```

## Implementation Notes

- Uses the `connect()` method added to `WsClientProtocol` for WebSocket connections
- Properly waits for WebSocket handshake before sending messages
- Handles partial JSON messages with brace-depth boundary detection
- Automatically reconnects if the WebSocket connection drops
- Gracefully handles Chrome restarts and page reloads

## License

Part of the qjs-lws project.
