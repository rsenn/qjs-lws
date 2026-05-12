# qjs-lws Reference

libwebsockets bindings for QuickJS.

Import: `import { LWSContext } from 'lws';`

## `LWSContext`

### Constructor

```js
const ctx = new LWSContext(options);
```

`options` object:

| Property | Type | Description |
|----------|------|-------------|
| `port` | number | TCP port to listen on |
| `vhostName` | string | Virtual host name |
| `listenAcceptRole` | string | Role string (optional) |
| `listenAcceptProtocol` | string | Protocol name to accept (optional) |
| `protocols` | array | List of protocol handler objects |

### Protocol Handler Object

```js
{
  name: 'protocol-name',
  callback(wsi, reason, user, buf) {
    // wsi    — connection handle
    // reason — LWS_CALLBACK_* integer constant
    // user   — per-connection user data
    // buf    — incoming data (ArrayBuffer or string, reason-dependent)
  }
}
```

Common `reason` constants (available as `cv.*` on the lws namespace or as raw integers):

| Constant | Value | When |
|----------|-------|------|
| `LWS_CALLBACK_ESTABLISHED` | 0 | New WS connection established (server) |
| `LWS_CALLBACK_CLOSED` | 1 | Connection closed |
| `LWS_CALLBACK_RECEIVE` | 6 | Data received |
| `LWS_CALLBACK_SERVER_WRITEABLE` | 11 | Ready to write |
| `LWS_CALLBACK_HTTP` | 12 | HTTP request arrived |
| `LWS_CALLBACK_CLIENT_ESTABLISHED` | 3 | Client connected to server |
| `LWS_CALLBACK_CLIENT_RECEIVE` | 8 | Client received data |

## Minimal WebSocket Server Example

```js
import { LWSContext } from 'lws.so';

const ESTABLISHED = 0;
const RECEIVE     = 6;
const CLOSED      = 1;

const ctx = new LWSContext({
  port: 8080,
  vhostName: 'localhost',
  protocols: [{
    name: 'chat',
    callback(wsi, reason, user, buf) {
      if (reason === ESTABLISHED) {
        console.log('client connected');
      } else if (reason === RECEIVE) {
        const msg = typeof buf === 'string' ? buf : new TextDecoder().decode(buf);
        console.log('received:', msg);
        // echo back — wsi.write(data)
        wsi.write(msg);
      } else if (reason === CLOSED) {
        console.log('client disconnected');
      }
    }
  }]
});

console.log('Listening on ws://localhost:8080');
```

## Minimal HTTP Server Example

```js
import { LWSContext } from 'lws.so';

const ctx = new LWSContext({
  port: 3000,
  protocols: [{
    name: 'http',
    callback(wsi, reason, user, buf) {
      if (reason === 12 /* LWS_CALLBACK_HTTP */) {
        const uri = typeof buf === 'string' ? buf : '/';
        console.log('HTTP request:', uri);
        // Respond with headers + body via wsi methods
      }
    }
  }]
});
```

## Notes

- qjs-lws drives its own internal event loop — the script does not need a manual `while(true)` poll.
- For heavier HTTP/WebSocket use, also consider `qjs-net` which wraps the same libwebsockets but with a slightly different API surface.
