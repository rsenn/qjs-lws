/**
 * Test WebSocket static methods:
 * - WebSocket.connect(url, protocols?) - returns Promise<WebSocket>
 * - WebSocket.isWebSocket(obj) - type guard
 */
import { tests, eq, assert, fail } from './tinytest.js';
import { WebSocket } from '../../lib/websocket.js';
import { serve, Response } from '../../lib/serve.js';
import { freePort } from './subprocess-utils.js';

await tests({
  'WebSocket.isWebSocket() returns false for non-WebSocket objects'() {
    const notWs = { send: function() {}, close: function() {} };
    assert(WebSocket.isWebSocket(notWs) === false, 'isWebSocket should return false for non-WebSocket object');
  },

  'WebSocket.isWebSocket() returns false for primitive types'() {
    assert(WebSocket.isWebSocket(null) === false, 'isWebSocket should return false for null');
    assert(WebSocket.isWebSocket(undefined) === false, 'isWebSocket should return false for undefined');
    assert(WebSocket.isWebSocket('string') === false, 'isWebSocket should return false for string');
    assert(WebSocket.isWebSocket(123) === false, 'isWebSocket should return false for number');
  },

  async 'WebSocket.connect() returns a connected WebSocket'() {
    const port = freePort();
    const server = serve({
      port,
      hostname: 'localhost',
      websocket: {
        open(ws) {
          // Server-side WebSocket opened
        },
        message(ws, data) {
          ws.send(data); // echo
        }
      },
      fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response('Not Found', { status: 404 })),
    });

    try {
      const ws = await WebSocket.connect(`ws://localhost:${port}`);
      
      assert(ws instanceof WebSocket, 'connect should return a WebSocket instance');
      assert(WebSocket.isWebSocket(ws), 'isWebSocket should return true for connected WebSocket');
      eq(WebSocket.OPEN, ws.readyState, 'WebSocket should be OPEN after connect resolves');
      eq(`ws://localhost:${port}`, ws.url, 'WebSocket url should match');
      
      // Test sending a message
      ws.send('hello');
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Clean up
      ws.close();
      await new Promise(resolve => setTimeout(resolve, 100));
    } finally {
      server.stop();
    }
  },

  async 'WebSocket.connect() rejects on connection failure'() {
    try {
      await WebSocket.connect('ws://localhost:99999');
      fail('connect should reject for invalid port');
    } catch (err) {
      assert(err instanceof Error, 'connect should reject with Error');
    }
  },
});

console.log('✅ All WebSocket static method tests passed');
process.exit(0);
