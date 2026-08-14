/**
 * Tests for Server lifecycle methods (Bun/Deno compatibility).
 */
import { tests, assert, assertEquals } from './tinytest.js';
import { serve } from '../../lib/serve.js';
import { URL } from '../../lib/lws/url.js';

await tests({
  async 'Server.stop() returns a Promise'() {
    const server = serve({ port: 0 }, req => new Response('test'));
    const result = server.stop();
    assert(result instanceof Promise, 'stop() should return a Promise');
    await result;
  },

  async 'Server.stop() Promise resolves'() {
    const server = serve({ port: 0 }, req => new Response('test'));
    let resolved = false;
    await server.stop().then(() => { resolved = true; });
    assert(resolved, 'stop() Promise should resolve');
  },

  'Server.id exists and is a string'() {
    const server = serve({ port: 0 }, req => new Response('test'));
    assert(typeof server.id === 'string', 'id should be a string');
    assert(server.id.length > 0, 'id should not be empty');
    server.stop();
  },

  'Server.id is unique per server'() {
    const server1 = serve({ port: 0 }, req => new Response('test1'));
    const server2 = serve({ port: 0 }, req => new Response('test2'));
    assert(server1.id !== server2.id, 'each server should have a unique id');
    server1.stop();
    server2.stop();
  },

  'Server.pendingRequests exists and is a number'() {
    const server = serve({ port: 0 }, req => new Response('test'));
    assert(typeof server.pendingRequests === 'number', 'pendingRequests should be a number');
    assertEquals(0, server.pendingRequests, 'pendingRequests should start at 0');
    server.stop();
  },

  'Server.pendingWebSockets exists and is a number'() {
    const server = serve({ port: 0 }, req => new Response('test'));
    assert(typeof server.pendingWebSockets === 'number', 'pendingWebSockets should be a number');
    assertEquals(0, server.pendingWebSockets, 'pendingWebSockets should start at 0');
    server.stop();
  },

  'Server.url exists and is a URL object'() {
    const server = serve({ port: 0, hostname: 'localhost' }, req => new Response('test'));
    assert(server.url instanceof URL, 'url should be a URL object');
    assert(server.url.hostname === 'localhost', 'url hostname should match');
    assert(server.url.port === String(server.port), 'url port should match server port');
    server.stop();
  },

  'Server.development exists and is a boolean'() {
    const server = serve({ port: 0, development: true }, req => new Response('test'));
    assert(typeof server.development === 'boolean', 'development should be a boolean');
    assertEquals(true, server.development, 'development should be true when set');
    server.stop();

    const server2 = serve({ port: 0 }, req => new Response('test'));
    assertEquals(false, server2.development, 'development should default to false');
    server2.stop();
  },

  async 'Server.stop() can be awaited'() {
    const server = serve({ port: 0 }, req => new Response('test'));
    await server.stop();
    // If we get here, the Promise resolved successfully
    assert(true, 'stop() Promise resolved when awaited');
  },

  'Server methods can be chained with await'() {
    const server = serve({ port: 0 }, req => new Response('test'));
    // Test that we can access properties and then stop
    const id = server.id;
    const pending = server.pendingRequests;
    server.stop();
    assert(typeof id === 'string', 'should be able to read id before stop');
    assert(typeof pending === 'number', 'should be able to read pendingRequests before stop');
  },
});
