# WsClientProtocol.connect() Implementation

## Summary

Implemented the `connect()` method for `WsClientProtocol` in `lib/lws/protocols.js`, following the same pattern as `HttpClientProtocol.connect()`.

## Changes Made

### 1. lib/lws/protocols.js

Added `connect()` method to `WsClientProtocol` class:

```javascript
connect(ctx, url, options = {}) {
  const wsi = ctx.clientConnect(url, {
    method: 'GET',
    protocol: 'ws',
    localProtocolName: 'ws',
    ...options,
  });

  return { wsi };
}
```

Key design decisions:
- Returns immediately (synchronous), like `HttpClientProtocol.connect()`
- Does NOT wait for WebSocket handshake to complete
- Uses `onClientEstablished` callback to know when connection is ready
- Passes sensible defaults: `protocol: 'ws'`, `localProtocolName: 'ws'`
- Allows options to override defaults via spread operator

### 2. inspector.js

Updated to use the new `connect()` method:
- Changed `this.#wsSession.send()` to `this.#wsSession.write()` (LWSSocket API)
- Removed `await` from `connect()` call (it's now synchronous)
- Added explicit `protocol` and `localProtocolName` options

## Testing

Created comprehensive tests demonstrating the implementation:

### test-ws-client-simple.js
Basic connection test showing:
- Client creation with `client()` factory
- Context creation with `createContext()`
- Connection initiation with `connect()`
- Callback handling (open, message, close, error)

### test-ws-client-echo.js
End-to-end test with local echo server:
- Creates WebSocket server using `createServer()`
- Creates WebSocket client using `client()`
- Demonstrates full request/response cycle
- Shows proper cleanup with `destroy()`

## Usage Pattern

```javascript
import createContext from './lib/lws/context.js';
import { client } from './lib/lws/protocols.js';

// Create client protocol handler
const wsClient = client({
  name: 'myProtocol',
  open(wsi) {
    console.log('Connected!');
    wsi.write('Hello', LWS_WRITE_TEXT);
  },
  message(wsi, data) {
    console.log('Received:', data);
  },
  close(wsi, code, reason) {
    console.log('Closed:', code, reason);
  },
  error(wsi, msg) {
    console.error('Error:', msg);
  }
});

// Create context
const ctx = createContext({
  protocols: [{ name: 'myProtocol', ...wsClient }]
});

// Connect (returns immediately, use callbacks for events)
const { wsi } = wsClient.connect(ctx, 'ws://example.com/ws', {
  protocol: 'myProtocol',
  localProtocolName: 'myProtocol'
});
```

## Key Differences from HttpClientProtocol

| Aspect | HttpClientProtocol | WsClientProtocol |
|--------|-------------------|------------------|
| Handshake | HTTP request/response | WebSocket upgrade |
| Connection ready | When response headers arrive | When `onClientEstablished` fires |
| Data format | Request/Response objects | Raw frames (text/binary) |
| Protocol option | `protocol: 'http'` | `protocol: 'ws'` |

## Implementation Notes

1. **Synchronous Return**: Both `HttpClientProtocol.connect()` and `WsClientProtocol.connect()` return immediately after initiating the connection. The actual connection establishment happens asynchronously.

2. **Protocol Names**: The `protocol` option specifies which protocol to use for the connection, while `localProtocolName` specifies which local protocol handler to use. Both should typically match the protocol name registered in the context.

3. **Event Handling**: Use the callbacks provided to the `client()` factory to handle connection events:
   - `open(wsi)` - Connection established
   - `message(wsi, data)` - Data received
   - `close(wsi, code, reason)` - Connection closed
   - `error(wsi, msg)` - Connection error

4. **Cleanup**: Always call `ctx.destroy()` when done to clean up resources.
