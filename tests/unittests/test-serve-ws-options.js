/**
 * serve()'s websocket.maxPayloadLength (close with 1009 above it) and
 * websocket.publishToSelf (ws.publish() also reaches the sender), the way
 * Bun does them.
 */
import { setTimeout } from 'os';
import { exit } from 'std';
import { tests, assertEquals } from './tinytest.js';
import { serve, Response } from '../../lib/serve.js';
import { TCPSocket } from '../../lib/tcpsocket.js';

const bytes = data => Array.from(new Uint8Array(data));
const HANDSHAKE = 'GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n';

/** a masked text frame (mask bytes all zero) */
function frame(text) {
  const n = text.length;
  const head = n < 126 ? [0x81, 0x80 | n] : [0x81, 0x80 | 126, n >> 8, n & 255];

  return new Uint8Array([...head, 0, 0, 0, 0, ...Array.from(text, c => c.charCodeAt(0))]).buffer;
}

/** connects, upgrades, then collects every byte the server sends for `ms` */
async function session(port, messages, ms = 400) {
  const socket = new TCPSocket('127.0.0.1', port);
  const got = [];
  let upgraded = false;

  socket.addEventListener('message', e => {
    const b = bytes(e.data);

    if(!upgraded) {
      upgraded = true;
      /* the first read is the 101 reply */
      for(const m of messages) socket.send(frame(m));
      return;
    }

    got.push(...b);
  });
  socket.addEventListener('open', () => socket.send(HANDSHAKE));
  await new Promise(r => setTimeout(r, ms));
  socket.close();
  return got;
}

const limited = serve({ port: 0, hostname: '127.0.0.1', fetch: (req, s) => (s.upgrade(req) ? undefined : new Response('x')), websocket: { maxPayloadLength: 100, message(ws) { ws.send('ok'); } } });
const selfish = serve({ port: 0, hostname: '127.0.0.1', fetch: (req, s) => (s.upgrade(req) ? undefined : new Response('x')), websocket: { publishToSelf: true, open(ws) { ws.subscribe('t'); }, message(ws) { ws.publish('t', 'pub'); } } });
const polite = serve({ port: 0, hostname: '127.0.0.1', fetch: (req, s) => (s.upgrade(req) ? undefined : new Response('x')), websocket: { open(ws) { ws.subscribe('t'); }, message(ws) { ws.publish('t', 'pub'); } } });

await tests({
  async 'a message within maxPayloadLength is delivered'() {
    const got = await session(limited.port, ['a'.repeat(50)]);

    assertEquals('0x81,0x2,0x6f,0x6b', got.map(x => '0x' + x.toString(16)).join(','));
  },

  async 'a message above maxPayloadLength closes the connection with 1009'() {
    const got = await session(limited.port, ['a'.repeat(101)]);

    /* close frame: 0x88, length, code 1009 = 0x03f1 */
    assertEquals(0x88, got[0]);
    assertEquals(0x03f1, (got[2] << 8) | got[3]);
  },

  async 'publishToSelf: ws.publish() reaches the sender'() {
    const got = await session(selfish.port, ['go']);

    assertEquals('pub', String.fromCharCode(...got.slice(2)));
  },

  async 'without publishToSelf the sender does not get its own publish'() {
    const got = await session(polite.port, ['go']);

    assertEquals(0, got.length);
  },
});

limited.stop();
selfish.stop();
polite.stop();
exit(0);
