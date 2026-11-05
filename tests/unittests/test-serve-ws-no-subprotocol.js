/**
 * A WebSocket client that sends no Sec-WebSocket-Protocol (Bun, browsers,
 * python websockets, ws) must reach serve()'s open/message handlers, after
 * fetch() has been asked to server.upgrade() it. It used to get the 101
 * reply and then nothing: the connection was bound to the http protocol.
 */
import { setTimeout } from 'os';
import { exit } from 'std';
import { tests, assertEquals } from './tinytest.js';
import { serve, Response } from '../../lib/serve.js';
import { TCPSocket } from '../../lib/tcpsocket.js';

/** bytes as latin1, frames are not valid UTF-8 */
const toString = data => String.fromCharCode(...new Uint8Array(data));

const seen = [];
const server = serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req, srv) {
    seen.push('fetch');
    if(srv.upgrade(req)) return;
    return new Response('plain');
  },
  websocket: {
    open() {
      seen.push('open');
    },
    message(ws, data) {
      seen.push('message');
      ws.send('len=' + data.length);
    },
  },
});

/** reads from a raw socket until `done(text)` says the bytes seen so far are enough */
const exchange = (socket, send, done) =>
  new Promise((resolve, reject) => {
    let got = '';
    const timer = setTimeout(() => reject(new Error('timeout, got ' + JSON.stringify(got))), 3000);

    socket.addEventListener('message', e => {
      got += toString(e.data);
      if(done(got)) resolve(got);
    });
    socket.addEventListener('open', () => socket.send(send));
  });

await tests({
  async 'handshake without Sec-WebSocket-Protocol reaches fetch and open, and messages flow'() {
    const socket = new TCPSocket('127.0.0.1', server.port);
    const head = await exchange(
      socket,
      'GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      t => t.includes('\r\n\r\n'),
    );

    assertEquals(true, head.startsWith('HTTP/1.1 101'), '101 reply');

    /* masked text frame "hi", all mask bytes zero */
    const frame = new Uint8Array([0x81, 0x82, 0, 0, 0, 0, 0x68, 0x69]);
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no reply to the message')), 3000);
      socket.addEventListener('message', e => resolve(toString(e.data)));
      socket.send(frame.buffer);
    });

    assertEquals(true, reply.includes('len=2'), 'echo reply');
    assertEquals('fetch,open,message', seen.join(','));
    socket.close();
  },
});

server.stop();
exit(0);
