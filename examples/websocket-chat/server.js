import { createServer, LWSMPRO_FILE, LWSMPRO_NO_MOUNT, LWS_WRITE_TEXT, toString } from 'lws';

const clients = new Set();

const ctx = createServer({
  port: 8080,
  vhostName: 'localhost',
  mounts: [
    { mountpoint: '/ws', protocol: 'chat', originProtocol: LWSMPRO_NO_MOUNT },
    { mountpoint: '/', origin: './public', def: 'index.html', originProtocol: LWSMPRO_FILE, protocol: 'http' },
  ],
  protocols: [
    { name: 'http' },
    {
      name: 'chat',
      onEstablished(wsi) {
        clients.add(wsi);
        console.log(`+ client connected (${clients.size} total)`);
      },
      onClosed(wsi) {
        clients.delete(wsi);
        console.log(`- client disconnected (${clients.size} total)`);
      },
      onReceive(wsi, data) {
        const text = typeof data === 'string' ? data : toString(data);
        console.log(`< received: ${text}`);

        for(const client of clients) {
          console.log(`> sending: ${text}`);
          client.write(text, LWS_WRITE_TEXT);
        }
      },
    },
  ],
});

console.log(`listening on http://localhost:8080/  (WebSocket endpoint: ws://localhost:8080/ws)`);
