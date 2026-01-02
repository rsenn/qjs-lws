import { ReadableStream, WritableStream } from './streams.js';
import { define, iteratorProperty, wrapFunction } from './util.js';

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
      } catch(error) {
        return { done: true, error };
      }
    },
    return: () => st.close(),
    throw: error => st.abort(error),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

/**
 * @param  {AsyncIterable}   iterable
 * @return {ReadableStream}  A readable stream.
 */
export function streamFromIterable(iterable) {
  let prop, iterator;

  if((prop = iteratorProperty(iterable)))
    return new ReadableStream({
      start() {
        iterator ??= iterable[prop]();
      },
      pull: async controller => {
        const { value, done } = await iterator.next();

        done ? controller.close() : controller.enqueue(value);
      },
      cancel: () => iterator.return?.(),
    });
}

/**
 * @param  {ReadableStream}  st
 * @return {ReadableStream}  A readable stream.
 */
export function readableStreamCallback(st, startCallback) {
  return define(st, {
    getReader: wrapFunction(st.getReader, reader =>
      define(reader, {
        read: wrapFunction(reader.read, result => {
          if(startCallback) {
            startCallback();
            startCallback = undefined;
          }
          return result;
        }),
      }),
    ),
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
        start: controller => (writeController = controller),
        write: chunk => controller.enqueue(chunk),
        close: () => controller.close(),
        abort: reason => controller.error(reason),
      })),
    cancel: reason => writeController.error(reason),
  });

  return obj;
}
