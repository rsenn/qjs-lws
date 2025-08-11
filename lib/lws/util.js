export class ConnectionError extends Error {
  constructor(message) {
    super('ConnectionError: ' + message.replace(/.*fail:\s*/g, ''));
  }
}

export function waitWrite(wsi) {
  return new Promise((resolve, reject) => wsi.wantWrite(resolve));
}

/**
 * @param  {AsyncGenerator} st   Readable stream
 * @return {Array}               an Array of chunks.
 */
export async function readStream(st) {
  const chunks = [];

  for await(let chunk of st) chunks.push(chunk);

  return chunks;
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

export function verbose(name, ...args) {
  console.log('\x1b[2K\r' + (name + '').padEnd(32), console.config({ compact: true }), ...args);
}

export function debug(name, ...args) {
  if(process.env.DEBUG) verbose(name, ...args);
}

export function weakMapper(create, target = new WeakMap()) {
  return (key, ret) => {
    if(ret) target.set(key, ret);
    else if(!(ret = target.get(key))) target.set(key, (ret = create(key)));
    return ret;
  };
}

/**
 * Assigns all objects in @params to @param obj
 *
 * @param  {object}    obj    Object to which we assign
 * @param  {...object} args   Multiple property bags
 * @return {object}           The supplied object with new properties assigned
 */
export function assign(obj, ...args) {
  for(let props of args) for (let prop in props) Object.defineProperty(obj, prop, { value: props[prop], configurable: true, writable: true });
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
  for(let prop in props) Object.defineProperty(obj, prop, { value: props[prop], ...opts });
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
  return (...args) => (args.length > 1 ? target.set(...args) : target.get(...args));
}
