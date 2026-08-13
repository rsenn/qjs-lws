import { tests, eq, assert } from './tinytest.js';
import { UDPSocket } from '../../lib/udpsocket.js';
import { LWSSockAddr46 } from 'lws.so';

await tests({
  'UDPSocket.send() method exists and accepts multiple signatures'() {
    const socket = new UDPSocket();
    
    // Verify the method exists
    assert(typeof socket.send === 'function', 'send should be a function');
    
    // Verify it has the expected signature (3 parameters)
    // Note: We can't actually call it without a real wsi, but we can verify
    // the method signature accepts the right number of parameters
    eq(3, socket.send.length, 'send should accept up to 3 parameters');
  },

  'UDPSocket.sendTo() method still exists for backward compatibility'() {
    const socket = new UDPSocket();
    
    assert(typeof socket.sendTo === 'function', 'sendTo should still exist');
    eq(2, socket.sendTo.length, 'sendTo should accept 2 parameters (data, peer)');
  },

  'LWSSockAddr46 can be created with IPv4 address and port'() {
    const peer = new LWSSockAddr46('127.0.0.1', 8080);
    
    assert(peer instanceof LWSSockAddr46, 'should create LWSSockAddr46 instance');
    eq('127.0.0.1', peer.host, 'host should match');
    eq(8080, peer.port, 'port should match');
  },

  'LWSSockAddr46 can be created with IPv6 address and port'() {
    const peer = new LWSSockAddr46('::1', 53);
    
    assert(peer instanceof LWSSockAddr46, 'should create LWSSockAddr46 instance');
    eq('::1', peer.host, 'host should match');
    eq(53, peer.port, 'port should match');
  },
});
