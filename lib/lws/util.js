import { getpid } from 'os';
import { kill } from 'os';
import { SIGUSR1 } from 'os';
import { LWS_WRITE_HTTP } from 'lws';
import { LWS_WRITE_HTTP_FINAL } from 'lws';

export const CONNECTING = 0;
export const OPEN = 1;
export const CLOSING = 2;
export const CLOSED = 3;

export const states = { CONNECTING, OPEN, CLOSING, CLOSED };

export class ConnectionError extends Error {
  constructor(message) {
    super('ConnectionError: ' + message.replace(/.*fail:\s*/g, ''));
  }
}

export function waitWrite(wsi) {
  return new Promise((resolve, reject) => wsi.wantWrite(resolve));
}

/*export async function writeStream(wsi, stream) {
  const rd = stream.getReader();
  let result;

  while((result = await rd.read())) {
    const { value, done } = result;

    await waitWrite(wsi);
    let r = wsi.write(done ? '\n' : value, done ? 1 : value.byteLength, done ? LWS_WRITE_HTTP_FINAL : LWS_WRITE_HTTP);
    if(done) break;
  }

  rd.releaseLock();
}*/

export function typeIsObject(x) {
  return (typeof x == 'object' && x !== null) || typeof x == 'function';
}

export function isAsyncIterable(obj) {
  return typeof obj == 'object' && obj !== null && typeof obj[Symbol.asyncIterator] == 'function';
}

export function isIterable(obj) {
  return typeof obj == 'object' && obj !== null && typeof obj[Symbol.iterator] == 'function';
}

export function iteratorProperty(obj) {
  if(typeof obj == 'object' && obj !== null) for(let prop of [Symbol.asyncIterator, Symbol.iterator]) if (prop in obj && typeof obj[prop] == 'function') return prop;
}

export function iteratorFunction(obj) {
  if(typeof obj == 'object' && obj !== null) return obj[Symbol.asyncIterator] ?? obj[Symbol.iterator];
}

export function wrapFunction(fn, wrapper = a => a) {
  const { length, name } = fn;
  return define(
    function(...args) {
      return wrapper.call(this, fn.apply(this, args));
    },
    { length, name },
  );
}

/**
 * Checks if @param a is the prototype of @param b
 * @param  {object}  a    Prototype to check
 * @param  {object}  b    Object
 * @return {boolean}
 */
export function isPrototypeOf(a, b) {
  try {
    return Object.prototype.isPrototypeOf.call(a, b);
  } catch(e) {}
}

export function stripAnsi(str) {
  return str.replaceAll(/(.*\r|\x1b\[[^A-Za-z]*[A-Za-z])/g, '');
}

export function padEnd(str, n, s = ' ') {
  const { length } = stripAnsi(str);
  if(length < n) str += s.repeat(n - length);
  return str;
}

export function interactive() {
  kill(getpid(), SIGUSR1);
}

export function verbose(name, ...args) {
  console.log('\x1b[2K\r' + padEnd(name + '', 32), console.config({ compact: true }), ...args);
}

export function debug(name, ...args) {
  if(process.env.DEBUG) verbose(name, ...args);
}

export function weakMapper(create, map = new WeakMap()) {
  return (key, value) => (value !== undefined ? map.set(key, value) : (value = map.get(key)) || map.set(key, (value = create(key))), value);
}

export function setFunctionName(fn, name) {
  try {
    Object.defineProperty(fn, 'name', {
      value: name,
      configurable: true,
    });
  } catch(e) {}
}

/**
 * Assigns all objects in @params to @param obj
 *
 * @param  {object}    obj    Object to which we assign
 * @param  {...object} args   Multiple property bags
 * @return {object}           The supplied object with new properties assigned
 */
export function assign(obj, ...args) {
  for(let props of args)
    for(let prop of [...Object.getOwnPropertyNames(props), ...Object.getOwnPropertySymbols(props)]) Object.defineProperty(obj, prop, { value: props[prop], configurable: true, writable: true });
}

/**
 * Defines properties
 *
 * @param  {object} obj    Destination object on which to define properties
 * @param  {object} props  Source properties
 * @param  {object} opts   Property descriptors
 * @return {object}       The object given in \param obj
 */
export function define(obj, props, opts = { writable: true, configurable: true }) {
  for(let prop of [...Object.getOwnPropertyNames(props), ...Object.getOwnPropertySymbols(props)]) {
    //console.log('prop', prop);
    Object.defineProperty(obj, prop, { value: props[prop], ...opts });
  }
  return obj;
}

/**
 * Creates a function that maps one value to another.
 * If called with 1 argument, the get() method will be invoked,
 * if called with 2 arguments the set() method will be invoked.
 *
 * @param  {Map|WeakMap} target  The map
 * @return {Function}            Mapping function
 */
export function mapper(target = new WeakMap()) {
  return (...args) => (args.length > 1 ? (target.set(...args), undefined) : target.get(...args));
}

export function actor(ws, log) {
  return {
    state(state) {
      ws.readyState = state;
      if(log) log('actor.state', ws, ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][state]);
      return this;
    },
    event(type, props) {
      if(log) log('actor.event', ws, { type, ...props });
      ws.dispatchEvent({ type, target: ws, ...(props ? props : {}) });
      return 0;
    },
  };
}

const TypedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);

export function isView(obj) {
  return isPrototypeOf(TypedArrayPrototype, obj) || isPrototypeOf(DataView.prototype, obj);
}

export function once(fn, thisArg) {
  let ret,
    ran = false;
  return (...args) => (ran ? ret : ((ran = true), (ret = fn.apply(thisArg, args))));
}