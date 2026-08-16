import { tests, eq, assert } from './tinytest.js';
import { UDPSocket } from '../../lib/udpsocket.js';
import { toString } from 'lws.so';
import * as std from 'std';

// Integration test for UDPSocket.send() with Bun.js signature
// This test requires actual network I/O, so it's slower but verifies real behavior

await tests({
  async 'UDPSocket.send(data, port, address) - Bun.js signature integration'() {
    const server = new UDPSocket();
    let received = null;
    let serverPeer = null;

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server bind timeout')), 2000);
      
      server.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      
      server.bind('127.0.0.1', 0);
    });

    const serverPort = server.localPort;
    
    server.addEventListener('message', event => {
      received = event.data;
      serverPeer = event.peer;
    }, { once: true });

    // Create client and send using Bun.js signature
    const client = new UDPSocket();
    
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Client open timeout')), 2000);
      
      client.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      
      // Bind to any available port
      client.bind('127.0.0.1', 0);
    });

    // Send using Bun.js signature: send(data, port, address)
    client.send('hello from bun.js', serverPort, '127.0.0.1');

    // Wait for message
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Message receive timeout')), 2000);
      
      const check = () => {
        if(received !== null) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });

    assert(received !== null, 'server should have received message');
    eq('hello from bun.js', toString(received), 'message content should match');
    assert(serverPeer !== null, 'server should have received peer info');

    client.close();
    server.close();
  },

  async 'UDPSocket.send(data, peer) - current signature still works'() {
    const server = new UDPSocket();
    let received = null;

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server bind timeout')), 2000);
      
      server.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      
      server.bind('127.0.0.1', 0);
    });

    const serverPort = server.localPort;
    
    server.addEventListener('message', event => {
      received = event.data;
    }, { once: true });

    const client = new UDPSocket();
    
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Client open timeout')), 2000);
      
      client.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      
      client.bind('127.0.0.1', 0);
    });

    // Send using current signature: send(data, peer)
    const { LWSSockAddr46 } = await import('lws.so');
    const peer = new LWSSockAddr46('127.0.0.1', serverPort);
    client.send('hello from peer', peer);

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Message receive timeout')), 2000);
      
      const check = () => {
        if(received !== null) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });

    assert(received !== null, 'server should have received message');
    eq('hello from peer', toString(received), 'message content should match');

    client.close();
    server.close();
  },
});

// UDPSocket keeps a lazily-created LWSContext singleton alive for the life
// of the process (shared across instances by design) - both sockets above
// bind() (server mode), which permanently disables that context's
// auto-destroy (ContextRefCounter#markServer(), lib/lws/context.js), so
// the event loop would otherwise never drain on its own. Same pattern as
// tests/unittests/test-tcpsocket.js.
std.exit(0);
