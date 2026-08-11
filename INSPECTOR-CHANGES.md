# Inspector Changes Summary

## Overview
This document summarizes all changes made to the Chrome DevTools Protocol inspector (`inspector.js`) during this session.

## Files Modified

### 1. inspector.js
Complete rewrite using high-level abstractions (fetch + WebSocketStream) with interactive debugging features.

### 2. INSPECTOR-README.md
Created comprehensive documentation for the inspector.

### 3. .gitignore
Added `inspector-debug.log` to ignore list.

## Major Changes

### 1. Rewritten Architecture
**Before:** Used low-level lws protocols directly
**After:** Uses high-level abstractions:
- `fetch()` from `lib/fetch.js` for HTTP discovery
- `WebSocketStream` from `lib/websocketstream.js` for CDP communication

### 2. Interactive Keyboard Controls
Added `TerminalInput` class with raw terminal mode support:

#### Function Keys (when available)
- **F5** - Continue/Interrupt
- **F10** - Step Over
- **F11** - Step Into
- **Shift+F11** - Step Out

#### Letter Shortcuts (work in GNU screen/tmux)
- **r/c/p** - Continue (when paused) or Interrupt (when running)
- **j** - Step Over (jump)
- **i** - Step Into
- **u** - Step Out (up)
- **q** - Stop debugger
- **ESC** - Stop debugger
- **Ctrl+C** - Exit

### 3. Expression Evaluation
Type any JavaScript expression and press Enter to evaluate it in the page context:
- Results are displayed with syntax highlighting
- Supports all JavaScript types (objects, arrays, primitives)
- Error handling with detailed messages

### 4. Line Editing Features
Full readline-style editing:
- **Arrow keys** - Move cursor left/right
- **Home/End** - Jump to line start/end
- **Ctrl+A** - Go to beginning of line
- **Ctrl+E** - Go to end of line
- **Ctrl+K** - Delete to end of line
- **Ctrl+U** - Delete to beginning of line
- **Ctrl+D** - Delete character at cursor
- **Backspace** - Delete character before cursor
- All characters echo back with prompt `> `

### 5. Debug Logging
- Set `DEBUG=1` environment variable to enable
- Logs all CDP protocol traffic to `inspector-debug.log`
- Format: `TX:` for transmitted, `RX:` for received messages
- Auto-flushed after each write for real-time monitoring

### 6. Location Display
- Shows current file:line when paused
- Tracks script URLs by scriptId
- Displays format: `► url:line at functionName`
- Shown before help menu for context

## Implementation Details

### TerminalInput Class
```javascript
class TerminalInput {
  // Raw mode with os.ttySetRaw()
  // Line editing with cursor positioning
  // Escape sequence parsing for function keys
  // Echo all typed characters
}
```

### Expression Evaluation
```javascript
async #evaluateExpression(text) {
  // Uses Runtime.evaluate CDP command
  // Color-coded output:
  //   - Red: errors
  //   - Gray: undefined/null
  //   - Yellow: strings (with quotes)
  //   - Blue: numbers/booleans
  //   - JSON: objects
}
```

### Debug Logging
```javascript
// In constructor
if(process.env.DEBUG) {
  this.#debugLog = std.open(DEBUG_LOG_PATH, 'a');
}

// On send
this.#debugLog.puts(`TX: ${json}\n`);
this.#debugLog.flush();

// On receive
this.#debugLog.puts(`RX: ${rawJson}\n`);
this.#debugLog.flush();
```

## Commits Made

1. `07fdfe3` - Replace inspector.js with cleaner WebSocketStream-based implementation
2. `8333f81` - Add CDP inspector using high-level abstractions
3. `ec1773e` - Add debug logging for CDP write traffic when DEBUG env var is set
4. `d1eaa0e` - Add inspector-debug.log to .gitignore
5. `3c5229d` - Add interactive keyboard controls with TerminalInput class
6. `d573790` - Log received messages and show file:line location
7. `b6c3a4f` - Add expression evaluation from console input
8. `6745d01` - Add line editing to TerminalInput
9. `0e31add` - Update keyboard shortcuts to avoid GNU screen conflicts

## Usage Example

```bash
# Start Chrome with remote debugging
google-chrome --remote-debugging-port=9222

# Run inspector
qjsm inspector.js

# With debug logging
DEBUG=1 qjsm inspector.js
```

## Testing Performed

✅ Connected to Chrome DevTools Protocol  
✅ Discovered debug targets via HTTP  
✅ Established WebSocket communication  
✅ Paused execution and stepped through code  
✅ Evaluated JavaScript expressions  
✅ Verified line editing features  
✅ Tested keyboard shortcuts  
✅ Verified debug logging (TX/RX)  
✅ Confirmed location display  

## Known Limitations

- Function keys may not work in GNU screen/tmux (use letter shortcuts instead)
- Requires interactive TTY for keyboard controls (gracefully disables when unavailable)
- Expression evaluation is single-line only (no multi-line support yet)
