import { UDPSocketStream } from './lib/udpsocketstream.js';
import { TYPE, decodeMessage, buildQuery } from './examples/dns-server/dns-message.js';
import { toArrayBuffer } from './examples/dns-server/bytes.js';

// DNS Resolver using UDPSocketStream
async function resolve(domain) {
  const id = Math.floor(Math.random() * 65536);
  const type = TYPE.A;

  // buildQuery creates the complete DNS packet (Header + Question section)
  const questionBuffer = buildQuery(domain, type, id, { rd: 1 });

  const socket = new UDPSocketStream({
    host: '4.2.2.1',
    port: 53,
  });

  const { writable, readable } = await socket.opened;

  // 1. Send the DNS query
  const writer = writable.getWriter();
  await writer.write(toArrayBuffer(questionBuffer));
  writer.releaseLock();

  // 2. Read single datagram response from UDP readable stream
  const reader = readable.getReader();
  const { value } = await reader.read();
  reader.releaseLock();

  // 3. Clean up socket
  socket.close();

  if(value) {
    const decoded = decodeMessage(value);
    return decoded;
  }

  return null;
}

// Example usage
try {
  const result = await resolve(scriptArgs[1] ?? 'transistorisiert.ch');
  console.log('DNS Answer:', result);
} catch(error) {
  console.error('DNS Resolve Error:', error);
}
