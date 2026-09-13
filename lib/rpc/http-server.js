import { Response } from '../lws/response.js';
import { codecs } from './common.js';

/**
 * Binds a transport-agnostic JsonRpcHandler (./json-rpc-handler.js) to HTTP.
 * Returns a fetch-style handler: `(request) => Promise<Response>`, usable
 * directly as a serve()/app() route handler (see lib/serve.js).
 *
 * @param  {JsonRpcHandler} rpc
 * @param  {{ codec?: object }} [options]  wire codec (./common.js's
 *   `codecs`); defaults to `codecs.json()`
 * @return {(request: Request) => Promise<Response>}
 */
export function createHttpHandler(rpc, options = null) {
  const codec = options?.codec ?? codecs.json();
  const contentType = codec.name === 'json' ? 'application/json' : 'application/octet-stream';

  const respond = (value, init) => new Response(codec.encode(value), { ...init, headers: { 'content-type': contentType, ...init?.headers } });

  return async request => {
    let rpcRequest;

    try {
      const raw = codec.binary ? await request.arrayBuffer() : await request.text();
      rpcRequest = codec.decode(raw);
    } catch(error) {
      return respond(
        {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        },
        { status: 400 },
      );
    }

    const rpcResponse = await rpc.handleRequest(rpcRequest);

    if(rpcResponse === undefined) return new Response(null, { status: 204 });

    return respond(rpcResponse);
  };
}
