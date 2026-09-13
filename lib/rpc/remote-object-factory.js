const idSymbol = Symbol.for('rpcid');

/**
 * Encodes one argument for the wire: a RegExp or a remote-instance proxy
 * (tagged with idSymbol) gets a { type, ... } descriptor the server-side
 * endpoint decodes back into the real value/instance reference; everything
 * else is wrapped as { type: typeof arg, value: arg }.
 */
export function EncodeValue(arg) {
  if(typeof arg == 'object' && arg != null) {
    if(arg instanceof RegExp) return { type: 'regexp', source: arg.source, flags: arg.flags };
    if(arg[idSymbol]) return { type: 'instance', key: arg[idSymbol] };
    if(typeof arg.instance == 'number') return { type: 'instance', key: arg.instance };
    if(typeof arg.type == 'string' && 'value' in arg) return arg;
  }

  return { type: typeof arg, value: arg };
}

/**
 * Decodes one { type, class, value } descriptor (as produced by the
 * server-side endpoint's SerializeValue()) back into a plain JS value.
 */
export function DeserializeValue(desc) {
  if(desc.type == 'symbol') return Symbol.for(desc.description);
  if(desc.type == 'object' && 'class' in desc) {
    const ctor = globalThis[desc.class];

    if(ctor && ctor !== Array) desc.value = new ctor(desc.value);
  }

  return desc.value;
}

/**
 * Remote-object factory: given a transport-agnostic `call(method, params)`
 * (the shape createHttpClient/createWsClientProtocol return - see
 * ./http-client.js / ./ws-client.js), returns methods for instantiating,
 * using, and disposing of server-side JS class instances through a matching
 * RPC endpoint exposing `new`/`methods`/`properties`/`invoke`/`get`/`list`/
 * `delete`.
 *
 * `new(className, ...args)` resolves to a Proxy standing in for the remote
 * instance: its methods/properties are discovered once at creation time,
 * and every subsequent property access or method call round-trips over
 * `call`.
 *
 * @param  {(method: string, params?: any) => Promise<any>} call
 * @return {{ new: Function, list: Function, delete: Function, id: Function }}
 */
export function createRemoteObjectFactory(call) {
  async function create(className, ...args) {
    const { key: instance } = await call('new', [className, args.map(EncodeValue)]);

    const methodList = await call('methods', [instance, true, false]);
    const propertyList = await call('properties', [instance, true, false]);

    const methods = methodList.map(([key]) => DeserializeValue(key));
    const properties = propertyList.map(([key]) => DeserializeValue(key));
    const descriptors = Object.fromEntries([...methodList, ...propertyList].map(([key, value, desc]) => [DeserializeValue(key), desc]));

    const handler = {
      get(target, prop) {
        if(prop == idSymbol) return instance;

        if(methods.includes(prop)) return (...args) => call('invoke', [instance, prop, args.map(EncodeValue)]);
        if(properties.includes(prop)) return call('get', [instance, prop]).then(DeserializeValue);
      },
      ownKeys: () => [...methods, ...properties],
      getOwnPropertyDescriptor(target, prop) {
        return {
          configurable: true,
          ...(descriptors[prop] ?? {}),
          value: handler.get(target, prop),
        };
      },
    };

    return new Proxy({}, handler);
  }

  return {
    new: create,
    list: () => call('list', []),
    delete: proxy => call('delete', [proxy[idSymbol]]),
    id: proxy => proxy[idSymbol],
  };
}
