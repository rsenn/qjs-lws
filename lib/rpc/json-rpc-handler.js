/*
 * Implemented after https://github.com/kesompochy/bunson/blob/master/src/json-rpc-handler.ts
 *
 * bunson has unknown/no license..?
 */

/*
interface Options {
  methods: { [key: string]: (parmas: any) => any; };
}

interface JsonRpcResponse {
  jsonrpc: string;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
  id: number | string | null;
}

interface JsonRpcRequest {
  jsonrpc: string;
  method: string;
  params: any;
  id?: number | string | null;
}
*/

function JsonRpcRequest(obj) {
  return Object.setPrototypeOf({ jsonrpc: '2.0', ...obj }, JsonRpcRequest.prototype);
}

Object.assign(JsonRpcRequest.prototype, { [Symbol.toStringTag]: 'JsonRpcRequest', jsonrpc: '2.0' });

function JsonRpcResponse(obj) {
  return Object.setPrototypeOf({ jsonrpc: '2.0', ...obj }, JsonRpcResponse.prototype);
}

Object.assign(JsonRpcResponse.prototype, { [Symbol.toStringTag]: 'JsonRpcResponse', jsonrpc: '2.0' });

export class JsonRpcHandler {
  #methods = {};

  constructor(options) {
    if(!options) return;

    this.#methods = options.methods;
  }

  /**
   * Handle one or more requests
   *
   * @param  {object|object[]} request  A request object or an Array thereof
   * @return {Promise<object|void>}     Resolves to a response object (or Array thereof, if the input was an Array) or void on error
   */
  async handleRequest(request) {
    if(Array.isArray(request)) {
      if(request.length === 0)
        return JsonRpcResponse({
          id: null,
          error: {
            code: -32600,
            message: 'Invalid Request',
          },
        });

      const responses = await this.#handleBatchRequest(request);

      if(responses.length === 0) return;

      return responses;
    }

    return this.#handleSingleRequest(request);
  }

  /**
   * Handle a single request
   *
   * @param  {object} request        A request object
   * @return {Promise<object|void>}  Resolves to a response object or void on error
   */
  async #handleSingleRequest(request) {
    const { jsonrpc, method, params, id = null } = request;

    if(jsonrpc !== '2.0' || params === null || (!Array.isArray(params) && typeof params !== 'object')) {
      return JsonRpcResponse({
        id,
        error: {
          code: -32600,
          message: 'Invalid Request',
        },
      });
    }

    if(!id && id !== 0 && id !== null) return;

    const func = this.#methods[method];

    if(!func)
      return JsonRpcResponse({
        id,
        error: {
          code: -32601,
          message: 'Method not found',
        },
      });

    try {
      const result = await func.call(this.#methods, params);

      return JsonRpcResponse({ id, result });
    } catch(error) {
      return JsonRpcResponse({
        id,
        error: {
          code: -32000,
          message: 'Server error',
          data: error,
        },
      });
    }
  }

  /**
   * Handles a batch request
   *
   * @param {object[]} requests   Array of requests
   * @return {Promise<object[]>}  Array of responses
   */
  async #handleBatchRequest(requests) {
    const responses = await Promise.all(requests.map(request => this.handleRequest(request)));
    return responses.filter(response => response !== undefined);
  }
}

JsonRpcHandler.prototype[Symbol.toStringTag] = 'JsonRpcHandler';
