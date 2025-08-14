import { LWS_WRITE_HTTP, LWS_WRITE_HTTP_FINAL } from 'lws';
import { ReadableStream, WritableStream } from './streams.js';

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

/**
 * @param  {AsyncGenerator} st   Readable stream
 * @return {Array}               an Array of chunks.
 */
export async function readWholeStream(st) {
  const chunks = [];

  for await(let chunk of st) chunks.push(chunk);

  return chunks;
}

/**
 * @param   {ReadableStream} st    Readable stream
 * @returns {ArrayBuffer}         Data
 */
export async function readStream(st) {
  const rd = st.getReader();

  const { value, done } = await rd.read();

  rd.releaseLock();

  return value;
}

/**
 * @param  {WritableStream} st     Writable stream
 * @param  {ArrayBuffer}    chunk  Data
 */
export function writeStream(st, chunk) {
  if(chunk === undefined) return chunk => writeStream(st, chunk);

  const wr = st.getWriter();

  //if(wr.closed) throw new Error(`Stream closed`);

  const result = wr.write(chunk);

  wr.releaseLock();

  return result;
}

/**
 * @param  {WritableStream} st     Writable stream
 * @param  {AsyncIterator}         Iterator
 */
export function writeStreamIterator(st) {
  return {
    next: async chunk => {
      try {
        return { done: false, value: await writeStream(st, chunk) };
      } catch(e) {
        return { done: true, error: e.message };
      }
    },
    return: () => st.close(),
    throw: error => st.abort(error),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
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

/**
 * @param  {AsyncIterable}   iterable
 * @return {ReadableStream}  A readable stream.
 */
export function streamFromIterable(iterable) {
  let prop, iterator;

  if((prop = iteratorProperty(iterable)))
    return new ReadableStream({
      start: controller => (iterator = iterable[prop]()),
      pull: async controller => {
        const { value, done } = await iterator.next();

        if(done) controller.close();
        else controller.enqueue(value);
      },
      cancel: () => iterator.return(),
    });
}

/**
 * @return {Object}
 */
export function streamPipe() {
  const obj = {};
  let writeController;

  obj.readable = new ReadableStream({
    start: controller =>
      (obj.writable = new WritableStream({
        start: controller2 => (writeController = controller2),
        write: chunk => controller.enqueue(chunk),
        close: () => controller.close(),
        abort: reason => controller.error(reason),
      })),
    cancel: reason => writeController.error(reason),
  });

  return obj;
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
