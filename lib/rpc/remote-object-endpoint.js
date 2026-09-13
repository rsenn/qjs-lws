import { IdSequencer } from './common.js';

const isFunction = value => typeof value == 'function';

const TypedArrayPrototype = Object.getPrototypeOf(Uint32Array.prototype);

function isTypedArray(value) {
  try {
    return TypedArrayPrototype === Object.getPrototypeOf(Object.getPrototypeOf(value));
  } catch(e) {}
}

function getPrototypeName(proto) {
  return proto[Symbol.toStringTag] ?? proto.constructor?.name;
}

/**
 * Decodes one argument sent by a remote-object-factory.js client:
 * EncodeValue()'s { type: 'instance', key } back into the tracked instance
 * it refers to, { type: 'regexp', ... } back into a RegExp, everything else
 * unwrapped to its plain value.
 */
export function DecodeValue(arg, instances) {
  if(typeof arg == 'object' && arg != null && typeof arg.type == 'string' && 'value' in arg) {
    const { type, value } = arg;

    switch(type) {
      case 'instance':
        return instances[arg.key];
      case 'number':
        return +value;
      case 'regexp': {
        const { source, flags } = arg;
        return new RegExp(source, flags);
      }
      default:
        return value;
    }
  }

  return arg;
}

/**
 * Serializes one value for the wire: enough of a { type, class, value }
 * descriptor for remote-object-factory.js's DeserializeValue() to rebuild
 * it (or, for a function, just its arity) - not full structural cloning,
 * only what property/method inspection needs.
 */
export function SerializeValue(value, source = false) {
  const type = typeof value;
  const desc = { type };

  if(type == 'object' && value != null) {
    desc.class = getPrototypeName(value) ?? getPrototypeName(Object.getPrototypeOf(value));
  } else if(type == 'symbol') {
    desc.description = value.description;
  } else if(type == 'function' && value.length !== undefined) {
    desc.length = value.length;
  }

  if(type == 'object') {
    if(value instanceof ArrayBuffer) {
      value = [...new Uint8Array(value)];
      desc.class = 'ArrayBuffer';
    } else if(isTypedArray(value)) {
      value = [...value].map(n => (typeof n == 'number' ? n : n + ''));
    } else if(value instanceof Set) {
      value = [...value];
    }
  }

  if(isFunction(value)) {
    if(source) desc.source = value + '';
  } else if(type != 'symbol') {
    desc.value = value;
  }

  return desc;
}

/** Walks `obj`'s prototype chain, collecting `method(obj, depth)`'s results (deduped) at each step `pred(obj, depth)` allows. */
function getProperties(obj, method = Object.getOwnPropertyNames, pred = (proto, depth) => proto !== Object.prototype, propPred = () => true) {
  const set = new Set();
  let depth = 0;

  do {
    if(pred(obj, depth)) for(const prop of method(obj, depth)) if(propPred(prop, obj, depth)) set.add(prop);

    const proto = Object.getPrototypeOf(obj);
    if(proto === obj) break;

    obj = proto;
    ++depth;
  } while(typeof obj == 'object' && obj != null);

  return [...set];
}

function getKeys(obj, pred, propPred) {
  return [...getProperties(obj, Object.getOwnPropertyNames, pred, propPred), ...getProperties(obj, Object.getOwnPropertySymbols, pred, propPred)];
}

/** Own-and-inherited property descriptors of `obj`, nearest-in-chain wins on name clashes. */
function getPropertyDescriptors(obj) {
  const chain = [];

  do {
    chain.push(Object.getOwnPropertyDescriptors(obj));
    const proto = Object.getPrototypeOf(obj);
    if(proto === obj) break;
    obj = proto;
  } while(typeof obj == 'object' && obj != null);

  const result = {};
  for(const desc of chain) for(const prop of getKeys(desc)) if(!(prop in result)) result[prop] = desc[prop];

  return result;
}

function removeFalsish(obj) {
  const ret = {};
  for(const prop in obj) if(obj[prop]) ret[prop] = obj[prop];
  return ret;
}

/**
 * Keys the teardown hook createRemoteObjectEndpoint() attaches to its
 * returned methods table (below) - a Symbol, not a string, so it can never
 * be reached as a JSON-RPC method name (json-rpc-handler.js only ever looks
 * up `methods[request.method]` with a string from the wire) and so doesn't
 * need filtering out of `list`/introspection.
 */
export const TEARDOWN = Symbol.for('rpc.remote-object-endpoint.teardown');

/**
 * Creates a JsonRpcHandler `methods` table (./json-rpc-handler.js) that
 * exposes `classes` for remote instantiation, invocation, and inspection -
 * the server-side counterpart to remote-object-factory.js's client. The
 * returned object also carries a `[TEARDOWN]` method, not reachable over
 * JSON-RPC itself - call it when the connection this endpoint is serving
 * closes, to drop every instance it tracked (a client that disconnects
 * without calling `delete` on its instances would otherwise leak them for
 * the endpoint's lifetime):
 *
 *   const methods = createRemoteObjectEndpoint(classes);
 *   const rpc = new JsonRpcHandler({ methods });
 *   // ...construct the protocol with close() { methods[TEARDOWN](); }, ...
 *
 * @param  {object} classes  name -> constructor
 * @return {object}          methods table for `new JsonRpcHandler({ methods })`
 */
export function createRemoteObjectEndpoint(classes) {
  const instances = {};
  const makeId = IdSequencer(0);

  function withInstance(fn) {
    return ([key, ...args]) => {
      if(!(key in instances)) throw new Error(`No such object #${key}`);
      return fn(instances[key], ...args);
    };
  }

  function members(pred) {
    return (obj, keyDescriptor = true, valueDescriptor = true, source = false) => {
      const descriptors = getPropertyDescriptors(obj);

      return getKeys(descriptors).reduce((acc, key) => {
        const { value, ...desc } = descriptors[key];
        const v = value ?? obj[key];

        if(!pred(v)) return acc;

        acc.push([
          keyDescriptor ? SerializeValue(key) : key,
          valueDescriptor ? SerializeValue(v, source) : isFunction(v) ? (source ? v + '' : (v + '').split('\n')[0].replace(/\s*{$/, '')) : v,
          removeFalsish(desc),
        ]);

        return acc;
      }, []);
    };
  }

  return {
    // ([name, args = []]) - instantiates classes[name] with args, tracks the
    // instance, returns { type: 'instance', key } (key identifies it in
    // every other method below)
    new: ([name, args = []]) => {
      const obj = new classes[name](...args.map(a => DecodeValue(a, instances)));
      const instance = makeId();
      instances[instance] = obj;

      return { type: 'instance', key: instance };
    },

    // () - returns the registered class names
    list: () => Object.keys(classes),

    // ([key]) - stops tracking instance #key, returns whether it was tracked
    delete: ([key]) => delete instances[key],

    // ([key, method, params = []]) - calls .method(...params) on instance
    // #key, returns its result
    invoke: withInstance(async (obj, method, params = []) => {
      if(!(method in obj) || !isFunction(obj[method])) throw new Error(`No such method: ${method}`);

      return await obj[method](...params.map(a => DecodeValue(a, instances)));
    }),

    // ([key, enumerable = true]) - returns instance #key's own property
    // names (or, if it has a .keys() method and enumerable is true, that
    // instead)
    keys: withInstance((obj, enumerable = true) => getProperties(obj, enumerable ? o => ('keys' in o && isFunction(o.keys) ? [...o.keys()] : Object.keys(o)) : Object.getOwnPropertyNames)),

    // ([key]) - returns instance #key's own, non-numeric property names
    // across its whole prototype chain
    names: withInstance(obj =>
      getProperties(
        obj,
        Object.getOwnPropertyNames,
        proto => proto != Object.prototype,
        prop => isNaN(+prop),
      ),
    ),

    // ([key]) - returns descriptions of instance #key's own symbol properties
    symbols: withInstance(obj => getProperties(obj, Object.getOwnPropertySymbols).map(sym => sym.description)),

    // ([key, keyDescriptor = true, valueDescriptor = true, source = false]) -
    // returns instance #key's non-function properties as
    // [key, value, descriptor] triples
    properties: withInstance(members(v => !isFunction(v))),

    // ([key, keyDescriptor = true, valueDescriptor = true, source = false]) -
    // same as properties(), but for function properties
    methods: withInstance(members(v => isFunction(v))),

    // ([key, property]) - returns instance #key's `property`
    get: withInstance((obj, property) => {
      if(!(property in obj)) throw new Error(`No such property: ${property}`);
      return SerializeValue(obj[property]);
    }),

    // ([key, property, value]) - assigns instance #key's `property`,
    // returns the assigned value
    set: withInstance((obj, property, value) => (obj[property] = value)),

    // not a JSON-RPC method (see TEARDOWN above) - drops every tracked instance
    [TEARDOWN]: () => {
      for(const key of Object.keys(instances)) delete instances[key];
    },
  };
}
