import { fetch } from './lib/fetch.js';
import { WebSocketStream } from './lib/websocketstream.js';
import { TCPSocket, TCPSocketStream } from './lib/tcpSocket.js';
import { WebSocket } from './lib/websocket.js';
import { URLSearchParams, URL } from './lib/lws/url.js';
import { Headers } from './lib/lws/headers.js';
import { EventTarget, EventTargetProperties } from './lib/lws/events.js';
import { AbortSignal, AbortController } from './lib/lws/abort.js';

/*
 Hands the real values back to lws.c's lwsjs_load_precompiled(), which set
 this up on globalThis before evaluating this module - lws.so has no other
 way to read an evaluated module's exports back out (this quickjs build
 doesn't expose JS_GetModuleNamespace()).
*/

__lwsPrecompiledReady(
  @EXPORTS@
)
