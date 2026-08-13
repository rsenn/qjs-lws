import { tests, eq, assert } from './tinytest.js';
import { createServer, LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT } from 'lws.so';
import { WebSocket } from '../../lib/websocket.js';

let PORT = 18765;

async function startServer(callback) {
  PORT++;
  const server = createServer({
    port: PORT,
    options: LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT,
    protocols: [
      WebSocket.protocol('ws', callback),
    ],
  });
  
  // Wait a bit for server to start
  await new Promise(resolve => setTimeout(resolve, 100));
  return { server, port: PORT };
}

await tests({
  async 'ServerWebSocket has remoteAddress property'() {
    let clientAddress;
    
    const { server, port } = await startServer(ws => {
      clientAddress = ws.remoteAddress;
      ws.close();
    });
    
    const client = new WebSocket(`ws://localhost:${port}`, 'ws');
    
    await new Promise(resolve => {
      client.addEventListener('close', resolve, { once: true });
    });
    
    assert(clientAddress, 'remoteAddress should be defined');
    assert(typeof clientAddress === 'string', 'remoteAddress should be a string');
    assert(clientAddress === '127.0.0.1' || clientAddress === '::1', 'remoteAddress should be localhost');
    
    server.destroy();
  },

  async 'ServerWebSocket has remotePort property'() {
    let clientPort;
    
    const { server, port } = await startServer(ws => {
      clientPort = ws.remotePort;
      ws.close();
    });
    
    const client = new WebSocket(`ws://localhost:${port}`, 'ws');
    
    await new Promise(resolve => {
      client.addEventListener('close', resolve, { once: true });
    });
    
    assert(clientPort !== undefined, 'remotePort should be defined');
    assert(typeof clientPort === 'number', 'remotePort should be a number');
    assert(clientPort > 0 && clientPort < 65536, 'remotePort should be a valid port');
    
    server.destroy();
  },

  async 'ServerWebSocket has localAddress property'() {
    let serverLocalAddress;
    
    const { server, port } = await startServer(ws => {
      serverLocalAddress = ws.localAddress;
      ws.close();
    });
    
    const client = new WebSocket(`ws://localhost:${port}`, 'ws');
    
    await new Promise(resolve => {
      client.addEventListener('close', resolve, { once: true });
    });
    
    assert(serverLocalAddress, 'localAddress should be defined');
    assert(typeof serverLocalAddress === 'string', 'localAddress should be a string');
    assert(serverLocalAddress === '127.0.0.1' || serverLocalAddress === '::1' || serverLocalAddress === '0.0.0.0', 
           'localAddress should be a valid address');
    
    server.destroy();
  },

  async 'ServerWebSocket has localPort property'() {
    let serverLocalPort;
    
    const { server, port } = await startServer(ws => {
      serverLocalPort = ws.localPort;
      ws.close();
    });
    
    const client = new WebSocket(`ws://localhost:${port}`, 'ws');
    
    await new Promise(resolve => {
      client.addEventListener('close', resolve, { once: true });
    });
    
    assert(serverLocalPort !== undefined, 'localPort should be defined');
    assert(typeof serverLocalPort === 'number', 'localPort should be a number');
    eq(port, serverLocalPort, 'localPort should match server port');
    
    server.destroy();
  },

  async 'ServerWebSocket has subscriptions property'() {
    let subscriptions;
    
    const { server, port } = await startServer(ws => {
      ws.subscribe('topic1');
      ws.subscribe('topic2');
      subscriptions = ws.subscriptions;
      ws.close();
    });
    
    const client = new WebSocket(`ws://localhost:${port}`, 'ws');
    
    await new Promise(resolve => {
      client.addEventListener('close', resolve, { once: true });
    });
    
    assert(subscriptions, 'subscriptions should be defined');
    assert(Array.isArray(subscriptions), 'subscriptions should be an array');
    eq(2, subscriptions.length, 'subscriptions should have 2 topics');
    assert(subscriptions.includes('topic1'), 'subscriptions should include topic1');
    assert(subscriptions.includes('topic2'), 'subscriptions should include topic2');
    
    server.destroy();
  },

  async 'ServerWebSocket subscriptions updates dynamically'() {
    let subscriptions1, subscriptions2, subscriptions3;
    
    const { server, port } = await startServer(ws => {
      ws.subscribe('topic1');
      subscriptions1 = [...ws.subscriptions];
      
      ws.subscribe('topic2');
      subscriptions2 = [...ws.subscriptions];
      
      ws.unsubscribe('topic1');
      subscriptions3 = [...ws.subscriptions];
      
      ws.close();
    });
    
    const client = new WebSocket(`ws://localhost:${port}`, 'ws');
    
    await new Promise(resolve => {
      client.addEventListener('close', resolve, { once: true });
    });
    
    eq(1, subscriptions1.length, 'should have 1 subscription initially');
    eq(2, subscriptions2.length, 'should have 2 subscriptions after adding');
    eq(1, subscriptions3.length, 'should have 1 subscription after removing');
    assert(subscriptions3.includes('topic2'), 'should still have topic2');
    assert(!subscriptions3.includes('topic1'), 'should not have topic1 anymore');
    
    server.destroy();
  },

  async 'ServerWebSocket cork() batches writes'() {
    let clientMessages = [];
    let serverReceived = false;
    
    const { server, port } = await startServer(ws => {
      ws.addEventListener('message', e => {
        if(e.data === 'trigger') {
          serverReceived = true;
          // Use cork on server side to batch responses
          ws.cork(socket => {
            socket.send('msg1');
            socket.send('msg2');
            socket.send('msg3');
          });
        }
      });
    });
    
    const client = new WebSocket(`ws://localhost:${port}`, 'ws');
    
    await new Promise(resolve => {
      client.addEventListener('open', resolve, { once: true });
    });
    
    // Listen for messages from server
    client.addEventListener('message', e => {
      clientMessages.push(e.data);
    });
    
    // Send trigger message to server
    client.send('trigger');
    
    // Wait for all 3 messages
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for messages')), 2000);
      
      const check = () => {
        if(clientMessages.length === 3) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });
    
    client.close();
    
    await new Promise(resolve => {
      client.addEventListener('close', resolve, { once: true });
    });
    
    assert(serverReceived, 'server should have received trigger message');
    eq(3, clientMessages.length, 'client should receive all 3 messages');
    eq('msg1', clientMessages[0], 'first message should be msg1');
    eq('msg2', clientMessages[1], 'second message should be msg2');
    eq('msg3', clientMessages[2], 'third message should be msg3');
    
    server.destroy();
  },

  async 'ServerWebSocket cork() works with async callback'() {
    let clientMessages = [];
    let serverReceived = false;
    
    const { server, port } = await startServer(async ws => {
      ws.addEventListener('message', async e => {
        if(e.data === 'trigger') {
          serverReceived = true;
          // Use cork with async callback
          await ws.cork(async socket => {
            socket.send('msg1');
            await new Promise(resolve => setTimeout(resolve, 10));
            socket.send('msg2');
          });
        }
      });
    });
    
    const client = new WebSocket(`ws://localhost:${port}`, 'ws');
    
    await new Promise(resolve => {
      client.addEventListener('open', resolve, { once: true });
    });
    
    // Listen for messages from server
    client.addEventListener('message', e => {
      clientMessages.push(e.data);
    });
    
    // Send trigger message to server
    client.send('trigger');
    
    // Wait for both messages
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for messages')), 2000);
      
      const check = () => {
        if(clientMessages.length === 2) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });
    
    client.close();
    
    await new Promise(resolve => {
      client.addEventListener('close', resolve, { once: true });
    });
    
    assert(serverReceived, 'server should have received trigger message');
    eq(2, clientMessages.length, 'client should receive both messages');
    eq('msg1', clientMessages[0], 'first message should be msg1');
    eq('msg2', clientMessages[1], 'second message should be msg2');
    
    server.destroy();
  },
});
