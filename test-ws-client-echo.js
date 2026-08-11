#!/usr/bin/env qjsm
/**
 * Simple WebSocket echo server and client test
 * Demonstrates WsClientProtocol.connect() working end-to-end
 */

import { createServer, LWSContext, LWSMPRO_NO_MOUNT, LWS_WRITE_TEXT } from 'lws.so';
import { client } from './lib/lws/protocols.js';
import { TextDecoder } from 'textcode';

const PORT = 9999;

// Start echo server
const echoServer = createServer({
  port: PORT,
  vhostName: 'localhost',
  mounts: [{ mountpoint: '/echo', protocol: 'echo', originProtocol: LWSMPRO_NO_MOUNT }],
  protocols: [
    {
      name: 'echo',
      onEstablished(wsi) {
        console.log('[SERVER] Client connected');
      },
      onReceive(wsi, data) {
        const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
        console.log('[SERVER] Received:', text);
        console.log('[SERVER] Echoing back...');
        wsi.write(text, LWS_WRITE_TEXT);
      },
      onClosed(wsi, code, reason) {
        console.log('[SERVER] Client disconnected:', code, reason);
      },
    },
  ],
});

console.log(`Echo server started on port ${PORT}\n`);

// Wait a bit for server to start
setTimeout(() => {
  // Create client
  const wsClient = client({
    name: 'echo',
    open(wsi) {
      console.log('[CLIENT] Connected to server');
      console.log('[CLIENT] Sending: Hello, WebSocket!');
      wsi.write('Hello, WebSocket!', LWS_WRITE_TEXT);
    },
    message(wsi, data) {
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
      console.log('[CLIENT] Received echo:', text);
      console.log('[CLIENT] Test passed! Closing...');
      wsi.close();
    },
    close(wsi, code, reason) {
      console.log('[CLIENT] Connection closed:', code, reason);
      console.log('\n✓ WebSocket client test completed successfully');
      echoServer.destroy();
      clientCtx.destroy();
    },
    error(wsi, msg) {
      console.error('[CLIENT] Error:', msg);
      echoServer.destroy();
      clientCtx.destroy();
    },
  });

  const clientCtx = new LWSContext({
    protocols: [{ name: 'echo', ...wsClient }],
  });

  console.log('[CLIENT] Connecting to echo server...');
  const { wsi } = wsClient.connect(clientCtx, `ws://127.0.0.1:${PORT}/echo`, { protocol: 'echo', localProtocolName: 'echo' });
  console.log('[CLIENT] Connection initiated, wsi:', wsi.fd);
  console.log('[CLIENT] Waiting for callbacks...\n');
}, 500);
