import { tests, eq, assert } from './tinytest.js';
import { UDPSocket } from '../../lib/udpsocket.js';
import { LWSSockAddr46 } from 'lws.so';

await tests({
  async 'UDPSocket.send(data, port, address) - Bun.js signature'() {
    const server = new UDPSocket();
    let received = null;

    await new Promise(resolve => {
      server.bind('127.0.0.1', 0);
      server.addEventListener('open', resolve, { once: true });
    });

    const port = server.localPort;
    
    const client = new UDPSocket();
    await new Promise(resolve => {
      client.bind('127.0.0.1', 0);
      client.addEventListener('open', resolve, { once: true });
    });

    server.addEventListener('message', event => {
      received = event.data;
    }, { once: true });

    // Bun.js signature: send(data, port, address)
    client.send('hello from bun', port, '127.0.0.1');

    await new Promise(resolve => setTimeout(resolve, 100));

    assert(received !== null, 'server should have received message');
    eq('hello from bun', new TextDecoder().decode(received), 'message content should match');

    client.close();
    server.close();
  },

  async 'UDPSocket.send(data, peer) - current signature still works'() {
    const server = new UDPSocket();
    let received = null;

    await new Promise(resolve => {
      server.bind('127.0.0.1', 0);
      server.addEventListener('open', resolve, { once: true });
    });

    const port = server.localPort;
    
    const client = new UDPSocket();
    await new Promise(resolve => {
      client.bind('127.0.0.1', 0);
      client.addEventListener('open', resolve, { once: true });
    });

    server.addEventListener('message', event => {
      received = event.data;
    }, { once: true });

    // Current signature: send(data, peer)
    const peer = new LWSSockAddr46('127.0.0.1', port);
    client.send('hello from peer', peer);

    await new Promise(resolve => setTimeout(resolve, 100));

    assert(received !== null, 'server should have received message');
    eq('hello from peer', new TextDecoder().decode(received), 'message content should match');

    client.close();
    server.close();
  },

  async 'UDPSocket.send(data) - connected socket signature'() {
    const server = new UDPSocket();
    let received = null;

    await new Promise(resolve => {
      server.bind('127.0.0.1', 0);
      server.addEventListener('open', resolve, { once: true });
    });

    const port = server.localPort;
    
    // Connected socket (one fixed peer)
    const client = new UDPSocket('127.0.0.1', port);
    await new Promise(resolve => {
      client.addEventListener('open', resolve, { once: true });
    });

    server.addEventListener('message', event => {
      received = event.data;
    }, { once: true });

    // Connected socket signature: send(data)
    client.send('hello from connected');

    await new Promise(resolve => setTimeout(resolve, 100));

    assert(received !== null, 'server should have received message');
    eq('hello from connected', new TextDecoder().decode(received), 'message content should match');

    client.close();
    server.close();
  },

  async 'UDPSocket.send() with IPv6 address'() {
    const server = new UDPSocket();
    let received = null;

    await new Promise(resolve => {
      server.bind('::1', 0);
      server.addEventListener('open', resolve, { once: true });
    });

    const port = server.localPort;
    
    const client = new UDPSocket();
    await new Promise(resolve => {
      client.bind('::1', 0);
      client.addEventListener('open', resolve, { once: true });
    });

    server.addEventListener('message', event => {
      received = event.data;
    }, { once: true });

    // Bun.js signature with IPv6
    client.send('hello ipv6', port, '::1');

    await new Promise(resolve => setTimeout(resolve, 100));

    assert(received !== null, 'server should have received message');
    eq('hello ipv6', new TextDecoder().decode(received), 'message content should match');

    client.close();
    server.close();
  },
});
