# Quick Start Guide - CDP Inspector

## Prerequisites
- Chrome/Chromium installed
- QuickJS with lws support (`qjsm` command)

## Quick Test

### Option 1: Automated (Recommended)
```bash
./test-inspector.sh
```

### Option 2: Manual
```bash
# Terminal 1: Start Chrome
google-chrome --remote-debugging-port=9222

# Terminal 2: Open test page
chrome file://$(pwd)/inspector-test.html

# Terminal 3: Run inspector
qjsm inspector.js
```

## What You'll See

The inspector will:
1. Connect to Chrome's debug port
2. Discover available targets
3. Connect to the test page via WebSocket
4. Enable debugging and pause execution
5. Single-step through the JavaScript code
6. Print call frames, variables, and source locations

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

[script parsed] 12
[paused] reason: other
  at (anonymous) (12:2:2)
  [local scope]
    numbers: [1,2,3,4,5]
    processed: undefined
  [stepping...]
```

## Troubleshooting

### "ECONNREFUSED" error
Chrome isn't running with remote debugging. Start it with:
```bash
google-chrome --remote-debugging-port=9222
```

### "No debug targets found"
No pages are open in Chrome. Open the test page:
```bash
chrome file://$(pwd)/inspector-test.html
```

### Script hangs
The inspector waits for events. Press Ctrl+C to stop.

## Files Reference

| File | Purpose |
|------|---------|
| `inspector.js` | Main inspector script |
| `inspector-test.html` | Test page with JavaScript |
| `test-inspector.sh` | Automated test script |
| `inspector-README.md` | Full documentation |
| `INSPECTOR-SUMMARY.md` | Implementation details |
| `inspector-debug.log` | Debug log (when DEBUG=1) |

## Debug Mode
```bash
DEBUG=1 qjsm inspector.js
```
Creates `inspector-debug.log` with detailed protocol messages.
