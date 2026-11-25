/**
 * serve()'s websocket.backpressureLimit (ws.send() drops a message that would
 * take the bytes queued for the peer past it and returns 0),
 * closeOnBackpressureLimit (closes with 1009 instead) and sendPings (a ping
 * frame every half of idleTimeout).
 */
import { setTimeout } from 'os';
import { exit } from 'std';
import { tests, assert, assertEquals } from './tinytest.js';
import { serve, Response } from '../../lib/serve.js';
import { TCPSocket } from '../../lib/tcpsocket.js';

const bytes = data => Array.from(new Uint8Array(data));
const HANDSHAKE = 'GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n';
const frame = text => new Uint8Array([0x81, 0x80 | text.length, 0, 0, 0, 0, ...Array.from(text, c => c.charCodeAt(0))]).buffer;

/** connects, upgrades, sends `message`, then collects what the server sends for `ms` (the 101 reply excluded) */
async function session(port, message, ms) {
  const socket = new TCPSocket('127.0.0.1', port);
  const got = [];
  let upgraded = false;

  socket.addEventListener('message', e => {
    if(!upgraded) {
      upgraded = true;
      if(message) socket.send(frame(message));
      return;
    }
    for(const b of bytes(e.data)) got.push(b);
  });
  socket.addEventListener('open', () => socket.send(HANDSHAKE));
  await new Promise(r => setTimeout(r, ms));
  socket.close();
  return got;
}

const chunk = new Uint8Array(1 << 20).buffer;
const fetch = (req, s) => (s.upgrade(req) ? undefined : new Response('x'));

/** sends 1 MiB messages until one is dropped (or 64 went out) and records the results */
function flood(results) {
  return ws => {
    for(let i = 0; i < 64; i++) {
      const r = ws.send(chunk);

      results.sent.push(r);
      if(r === 0) break;
    }
    results.buffered = ws.bufferedAmount;
  };
}

const limited = { sent: [] };
const closing = { sent: [] };
const servers = {
  limited: serve({ port: 0, hostname: '127.0.0.1', fetch, websocket: { backpressureLimit: 1572864, message: flood(limited) } }),
  closing: serve({ port: 0, hostname: '127.0.0.1', fetch, websocket: { backpressureLimit: 1572864, closeOnBackpressureLimit: true, message: flood(closing) } }),
  pinging: serve({ port: 0, hostname: '127.0.0.1', fetch, websocket: { sendPings: true, idleTimeout: 2, message() {} } }),
  quiet: serve({ port: 0, hostname: '127.0.0.1', fetch, websocket: { idleTimeout: 2, message() {} } }),
};

const hasPing = got => got.some((b, i) => b === 0x89 && got[i + 1] === 0);

await tests({
  async 'backpressureLimit drops what would exceed it'() {
    await session(servers.limited.port, 'go', 1500);
    assert(limited.sent.length > 1, 'the server never sent');
    assertEquals(0, limited.sent[limited.sent.length - 1]);
    assert(limited.buffered <= 1572864, `buffered ${limited.buffered} bytes, over the limit`);
  },

  async 'closeOnBackpressureLimit closes with 1009'() {
    const got = await session(servers.closing.port, 'go', 1500);
    const i = got.lastIndexOf(0x88);

    assertEquals(0, closing.sent[closing.sent.length - 1]);
    assert(i >= 0 && got[i + 2] === 0x03 && got[i + 3] === 0xf1, 'no close frame with code 1009 at the end of the stream');
  },

  async 'sendPings sends a ping frame'() {
    assert(hasPing(await session(servers.pinging.port, '', 1600)), 'no ping frame within 1.6 s');
  },

  async 'no ping frame without sendPings'() {
    assert(!hasPing(await session(servers.quiet.port, '', 1600)), 'unexpected ping frame');
  },
});

for(const s of Object.values(servers)) s.stop();
setTimeout(() => exit(0), 0);
