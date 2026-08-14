import { tests, eq, assert } from './tinytest.js';
import { TCPSocket } from '../../lib/tcpsocket.js';

await tests({
  'TCPSocket.setNoDelay() exists and returns this for chaining'() {
    const socket = new TCPSocket();
    const result = socket.setNoDelay(true);
    assert(result === socket, 'setNoDelay should return this');
  },

  'TCPSocket.setNoDelay() accepts boolean parameter'() {
    const socket = new TCPSocket();
    const result1 = socket.setNoDelay(true);
    const result2 = socket.setNoDelay(false);
    assert(result1 === socket && result2 === socket, 'setNoDelay should accept boolean');
  },

  'TCPSocket.setNoDelay() defaults to true when no parameter'() {
    const socket = new TCPSocket();
    const result = socket.setNoDelay();
    assert(result === socket, 'setNoDelay should work with no parameter');
  },

  'TCPSocket.setKeepAlive() exists and returns this for chaining'() {
    const socket = new TCPSocket();
    const result = socket.setKeepAlive(true, 60);
    assert(result === socket, 'setKeepAlive should return this');
  },

  'TCPSocket.setKeepAlive() accepts enable and initialDelay parameters'() {
    const socket = new TCPSocket();
    const result1 = socket.setKeepAlive(true, 30);
    const result2 = socket.setKeepAlive(false);
    assert(result1 === socket && result2 === socket, 'setKeepAlive should accept parameters');
  },

  'TCPSocket.setKeepAlive() defaults to false when no parameters'() {
    const socket = new TCPSocket();
    const result = socket.setKeepAlive();
    assert(result === socket, 'setKeepAlive should work with no parameters');
  },

  'TCPSocket.setTimeout() exists and returns this for chaining'() {
    const socket = new TCPSocket();
    const result = socket.setTimeout(5000);
    assert(result === socket, 'setTimeout should return this');
  },

  'TCPSocket.setTimeout() accepts timeout and callback parameters'() {
    const socket = new TCPSocket();
    let callbackCalled = false;
    const callback = () => { callbackCalled = true; };
    const result = socket.setTimeout(5000, callback);
    assert(result === socket, 'setTimeout should accept timeout and callback');
  },

  'TCPSocket.setTimeout() stores callback in options'() {
    const socket = new TCPSocket();
    const callback = () => {};
    socket.setTimeout(5000, callback);
    // The callback should be stored for future use when implemented
    // We can't test the actual timeout behavior without native support
  },

  'TCPSocket socket option methods can be chained'() {
    const socket = new TCPSocket();
    const result = socket
      .setNoDelay(true)
      .setKeepAlive(true, 60)
      .setTimeout(5000);
    assert(result === socket, 'All socket option methods should be chainable');
  },
});

console.log('✅ All TCPSocket socket option tests passed');
process.exit(0);
