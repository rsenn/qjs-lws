/**
 * Tests for UDPSocket socket option methods (Node.js/Bun/Deno compatibility).
 * These are stub implementations - the methods exist and are callable but
 * don't actually configure the socket (pending native lws support).
 */
import { tests, assert } from './tinytest.js';
import { UDPSocket } from '../../lib/udpsocket.js';

await tests({
  'setBroadcast: exists and returns this for chaining'() {
    const socket = new UDPSocket();
    const result = socket.setBroadcast(true);
    assert(result === socket, 'setBroadcast should return this');
  },

  'setBroadcast: accepts boolean parameter'() {
    const socket = new UDPSocket();
    const result = socket.setBroadcast(false);
    assert(result === socket, 'setBroadcast should accept boolean parameter');
  },

  'setTTL: exists and returns this for chaining'() {
    const socket = new UDPSocket();
    const result = socket.setTTL(64);
    assert(result === socket, 'setTTL should return this');
  },

  'setTTL: accepts number parameter'() {
    const socket = new UDPSocket();
    const result = socket.setTTL(128);
    assert(result === socket, 'setTTL should accept number parameter');
  },

  'setMulticastTTL: exists and returns this for chaining'() {
    const socket = new UDPSocket();
    const result = socket.setMulticastTTL(1);
    assert(result === socket, 'setMulticastTTL should return this');
  },

  'setMulticastTTL: accepts number parameter'() {
    const socket = new UDPSocket();
    const result = socket.setMulticastTTL(32);
    assert(result === socket, 'setMulticastTTL should accept number parameter');
  },

  'setMulticastLoopback: exists and returns this for chaining'() {
    const socket = new UDPSocket();
    const result = socket.setMulticastLoopback(true);
    assert(result === socket, 'setMulticastLoopback should return this');
  },

  'setMulticastLoopback: accepts boolean parameter'() {
    const socket = new UDPSocket();
    const result = socket.setMulticastLoopback(false);
    assert(result === socket, 'setMulticastLoopback should accept boolean parameter');
  },

  'setMulticastInterface: exists and returns this for chaining'() {
    const socket = new UDPSocket();
    const result = socket.setMulticastInterface('eth0');
    assert(result === socket, 'setMulticastInterface should return this');
  },

  'setMulticastInterface: accepts string parameter'() {
    const socket = new UDPSocket();
    const result = socket.setMulticastInterface('192.168.1.1');
    assert(result === socket, 'setMulticastInterface should accept string parameter');
  },

  'All socket option methods can be chained together'() {
    const socket = new UDPSocket();
    const result = socket
      .setBroadcast(true)
      .setTTL(64)
      .setMulticastTTL(1)
      .setMulticastLoopback(false)
      .setMulticastInterface('eth0');
    assert(result === socket, 'All socket option methods should be chainable');
  },
});
