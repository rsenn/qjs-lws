/**
 * A permessage-deflate message that inflates to many receive buffers must
 * arrive whole. lws used to drop the output of the first drain after the bulk
 * payload path (patches/0009), one lump in five. The compressed payload is
 * made of stored deflate blocks, so no compressor is needed: they inflate to
 * their own bytes, 1024 at a time (the inflater's output buffer).
 */
import { setTimeout } from 'os';
import { exit } from 'std';
import { tests, assertEquals } from './tinytest.js';
import { serve, Response } from '../../lib/serve.js';
import { TCPSocket } from '../../lib/tcpsocket.js';

const SIZE = 12000;
let received = -1;

const server = serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: (req, s) => (s.upgrade(req) ? undefined : new Response('x')),
  websocket: {
    perMessageDeflate: true,
    message(ws, data) {
      received = data.length ?? data.byteLength;
    },
  },
});

/** the text as stored deflate blocks, not final, then the empty block permessage-deflate leaves unsent */
function stored(text, block = 3000) {
  const out = [];

  for(let i = 0; i < text.length; i += block) {
    const part = text.slice(i, i + block);
    const n = part.length;

    out.push(0, n & 255, n >> 8, ~n & 255, (~n >> 8) & 255, ...Array.from(part, c => c.charCodeAt(0)));
  }

  out.push(0); /* the empty stored block's header byte, its 00 00 FF FF trailer is left off */
  return out;
}

/** FIN + RSV1 text frame, masked with zero bytes */
function frame(payload) {
  const n = payload.length;

  return new Uint8Array([0xc1, 0x80 | 126, n >> 8, n & 255, 0, 0, 0, 0, ...payload]).buffer;
}

const HANDSHAKE = 'GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\n';

await tests({
  async 'a deflated message of many receive buffers arrives whole'() {
    const text = Array.from({ length: SIZE }, (_, i) => String.fromCharCode(97 + ((i * 7) % 26))).join('');
    const socket = new TCPSocket('127.0.0.1', server.port);
    let head = '';

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout, got ' + JSON.stringify(head))), 3000);

      socket.addEventListener('message', e => {
        head += String.fromCharCode(...new Uint8Array(e.data));
        if(head.includes('\r\n\r\n')) resolve();
      });
      socket.addEventListener('open', () => socket.send(HANDSHAKE));
    });

    assertEquals(true, /permessage-deflate/i.test(head), 'extension negotiated');

    socket.send(frame(stored(text)));
    await new Promise(r => setTimeout(r, 500));
    socket.close();

    assertEquals(SIZE, received);
  },
});

server.stop();
exit(0);
