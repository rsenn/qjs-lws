# qjs-lws

QuickJS module providing network functions using libwebsockets.

### `new LWSContext(options)`: Create a new lws_context.
`options`: an object with following properties:
- `port`: *number*, *optional*
- `vhostName`: *string*, *optional*
- `listenAcceptRole`: *string*, *optional*
- `listenAcceptProtocol`: *string*, *optional*
- `protocols`: *array*
   List of protocols. Syntax:
```javascript
[  
  { name: 'ws', ...callbacks },
]
```
