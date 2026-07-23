/**
 * Corresponds to libwebsockets' minimal-raw-proxy-fallback example
 * (libwebsockets/minimal-examples-lowlevel/raw/minimal-raw-proxy-fallback/):
 * a normal HTTP server that, if the first bytes of a new connection don't
 * look like HTTP, falls back to transparently proxying the raw TCP
 * connection to another address - here, an SSH server on localhost:22.
 *
 * `LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG` is what makes
 * this work: new connections are provisionally bound to the role/protocol
 * named by listenAcceptRole/listenAcceptProtocol (here 'raw-skt'/'proxy'),
 * and only get reclassified as HTTP if the incoming bytes actually parse
 * as an HTTP request. Everything else (an SSH client's initial banner, for
 * instance) stays on the raw-socket path and gets proxied onward as-is.
 *
 * Unlike the C example (which pulls in the raw-proxy plugin's own lws_ring
 * buffer for flow control), the proxying here is plain JS: wsi.write()
 * already queues and flushes asynchronously (see lws-socket.c's
 * write_queue/socket_flush), so relaying just means writing straight to
 * the peer wsi, buffering anything that arrives before the onward
 * connection is actually up.
 *
 * Run:
 *   qjs server.js
 *   (open http://localhost:7681/)
 *   ssh -p 7681 user@localhost
 */
import { createServer, LWSMPRO_FILE, LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG } from 'lws';

const PORT = 7681;
const ONWARD_ADDRESS = process.env.ONWARD_ADDRESS ?? 'localhost';
const ONWARD_PORT = +(process.env.ONWARD_PORT ?? 22);

// wsi -> { peer: wsi|null, queue: [] }. `peer` is the other leg
// of the proxied connection - null on the incoming side until the onward
// connection actually establishes, so data arriving in the meantime goes
// to `queue` instead of being written to a socket that isn't up yet.
const links = new Map();

function relay(wsi, data) {
  const link = links.get(wsi);
  if(!link) return;

  if(link.peer) link.peer.write(data);
  else link.queue.push(data);
}

function teardown(wsi) {
  const link = links.get(wsi);
  if(!link) return;

  links.delete(wsi);

  if(link.peer && links.has(link.peer)) {
    links.delete(link.peer);
    link.peer.close();
    return;
  }

  // link.peer isn't set yet (this leg closed before the onward connection
  // finished establishing) - find the other leg the reverse way instead.
  for(const [other, otherLink] of links) {
    if(otherLink.peer === wsi) {
      links.delete(other);
      other.close();
      break;
    }
  }
}

const ctx = createServer({
  port: PORT,
  vhostName: 'localhost',
  options: LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG,
  listenAcceptRole: 'raw-skt',
  listenAcceptProtocol: 'proxy',
  errorDocument404: '/404.html',
  mounts: [{ mountpoint: '/', origin: './mount-origin', def: 'index.html', originProtocol: LWSMPRO_FILE, protocol: 'http' }],
  protocols: [
    { name: 'http' },

    // The incoming leg: whatever connected to :7681 without sending
    // something HTTP-shaped (an ssh client, most likely).
    {
      name: 'proxy',
      onRawAdopt(wsi) {
        links.set(wsi, { peer: null, queue: [] });

        console.log('proxying', wsi.peer?.host, '->', `${ONWARD_ADDRESS}:${ONWARD_PORT}`);

        const onward = ctx.clientConnect({
          address: ONWARD_ADDRESS,
          port: ONWARD_PORT,
          method: 'RAW',
          protocol: 'proxy-onward',
        });

        // onward -> wsi is safe to wire up immediately: wsi is already
        // fully adopted, so writing to it is fine any time from here on.
        // wsi -> onward stays unset until onRawConnected below confirms
        // the onward socket actually exists.
        links.set(onward, { peer: wsi, queue: [] });
      },
      onRawRx(wsi, data) {
        relay(wsi, data);
      },
      onRawClose(wsi) {
        teardown(wsi);
      },
    },

    // The onward leg: our own client connection to ONWARD_ADDRESS:ONWARD_PORT.
    {
      name: 'proxy-onward',
      onRawConnected(onward) {
        const wsi = links.get(onward).peer;
        const wsiLink = links.get(wsi);

        wsiLink.peer = onward;

        for(const chunk of wsiLink.queue) onward.write(chunk);
        wsiLink.queue.length = 0;
      },
      onRawRx(wsi, data) {
        relay(wsi, data);
      },
      onRawClose(wsi) {
        teardown(wsi);
      },
      onClientConnectionError(wsi, msg) {
        console.log('onward connection failed:', msg);
        teardown(wsi);
      },
    },
  ],
});

console.log(`listening on http://localhost:${PORT}/  (falls back to proxying raw connections to ${ONWARD_ADDRESS}:${ONWARD_PORT})`);
