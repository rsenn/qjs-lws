import { fetch } from '../fetch.js';
import { IdSequencer, codecs } from './common.js';

/**
 * HTTP transport for JSON-RPC 2.0 calls. Returns a `call(method, params)`
 * function that POSTs a JsonRpcRequest to `url` and resolves with the
 * result (or rejects with the JSON-RPC error). Pairs with the server-side
 * createHttpHandler() (./http-server.js).
 *
 * @param  {string} url
 * @param  {{ codec?: object }} [options]  wire codec (./common.js's
 *   `codecs`); defaults to `codecs.json()`
 * @return {(method: string, params?: any) => Promise<any>}
 */
export function createHttpClient(url, options = null) {
  const seq = IdSequencer();
  const codec = options?.codec ?? codecs.json();

  return async function call(method, params) {
    const request = { jsonrpc: '2.0', method, params, id: seq() };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': codec.name === 'json' ? 'application/json' : 'application/octet-stream' },
      body: codec.encode(request),
    });

    if(response.status === 204) return undefined;

    const raw = codec.binary ? await response.arrayBuffer() : await response.text();
    const rpcResponse = codec.decode(raw);

    if(rpcResponse.error) {
      const error = new Error(rpcResponse.error.message);
      error.code = rpcResponse.error.code;
      error.data = rpcResponse.error.data;
      throw error;
    }

    return rpcResponse.result;
  };
}
