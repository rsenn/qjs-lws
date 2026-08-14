/**
 * Tests for WebSocket handler options (Bun compatibility).
 * These options are accepted but not fully implemented (pending native lws support).
 */
import { tests, assert } from './tinytest.js';
import { serve } from '../../lib/serve.js';

await tests({
  'WebSocket handler accepts ping/pong handlers'() {
    const server = serve({
      port: 0,
      websocket: {
        ping: (ws, data) => {},
        pong: (ws, data) => {},
      },
    }, req => new Response('test'));
    
    assert(server !== null, 'server should be created with ping/pong handlers');
    server.stop();
  },

  'WebSocket handler accepts idleTimeout option'() {
    const server = serve({
      port: 0,
      websocket: {
        idleTimeout: 120,
      },
    }, req => new Response('test'));
    
    assert(server !== null, 'server should accept idleTimeout option');
    server.stop();
  },

  'WebSocket handler accepts maxPayloadLength option'() {
    const server = serve({
      port: 0,
      websocket: {
        maxPayloadLength: 16 * 1024 * 1024,
      },
    }, req => new Response('test'));
    
    assert(server !== null, 'server should accept maxPayloadLength option');
    server.stop();
  },

  'WebSocket handler accepts perMessageDeflate option'() {
    const server = serve({
      port: 0,
      websocket: {
        perMessageDeflate: true,
      },
    }, req => new Response('test'));
    
    assert(server !== null, 'server should accept perMessageDeflate option');
    server.stop();
  },

  'WebSocket handler accepts backpressureLimit option'() {
    const server = serve({
      port: 0,
      websocket: {
        backpressureLimit: 16 * 1024 * 1024,
      },
    }, req => new Response('test'));
    
    assert(server !== null, 'server should accept backpressureLimit option');
    server.stop();
  },

  'WebSocket handler accepts closeOnBackpressureLimit option'() {
    const server = serve({
      port: 0,
      websocket: {
        closeOnBackpressureLimit: true,
      },
    }, req => new Response('test'));
    
    assert(server !== null, 'server should accept closeOnBackpressureLimit option');
    server.stop();
  },

  'WebSocket handler accepts sendPings option'() {
    const server = serve({
      port: 0,
      websocket: {
        sendPings: true,
      },
    }, req => new Response('test'));
    
    assert(server !== null, 'server should accept sendPings option');
    server.stop();
  },

  'WebSocket handler accepts publishToSelf option'() {
    const server = serve({
      port: 0,
      websocket: {
        publishToSelf: true,
      },
    }, req => new Response('test'));
    
    assert(server !== null, 'server should accept publishToSelf option');
    server.stop();
  },

  'WebSocket handler accepts drain handler'() {
    const server = serve({
      port: 0,
      websocket: {
        drain: (ws) => {},
      },
    }, req => new Response('test'));
    
    assert(server !== null, 'server should accept drain handler');
    server.stop();
  },

  'WebSocket handler accepts all options together'() {
    const server = serve({
      port: 0,
      websocket: {
        ping: (ws, data) => {},
        pong: (ws, data) => {},
        idleTimeout: 120,
        maxPayloadLength: 16 * 1024 * 1024,
        perMessageDeflate: true,
        backpressureLimit: 16 * 1024 * 1024,
        closeOnBackpressureLimit: false,
        sendPings: true,
        publishToSelf: false,
        drain: (ws) => {},
      },
    }, req => new Response('test'));
    
    assert(server !== null, 'server should accept all WebSocket handler options');
    server.stop();
  },
});
