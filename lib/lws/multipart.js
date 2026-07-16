import { LWSSPA, toString, toArrayBuffer } from 'lws';
import { ReadableStream, ByteLengthQueuingStrategy } from './streams.js';
import { concatArrayBuffer, readWholeStream } from './stream-utils.js';
import { weakMapper, debug } from './util.js';

export class MultipartStream extends ReadableStream {
  constructor(cb, props = {}) {
    super({ start: cb });

    Object.assign(this, props);
  }
}

MultipartStream.prototype[Symbol.toStringTag] = 'MultipartStream';

/**
 * Compatible subset of the W3C `File` API (https://w3c.github.io/FileAPI/).
 * Deliberately *not* `Blob`-backed: a real `Blob` buffers its whole content
 * up front, which defeats the point of a streamed multipart upload. Wraps
 * whatever `ReadableStream` it's given directly - `.stream()` returns that
 * exact instance, unwrapped and unpiped, so it can only be read once (same
 * one-shot rule as any other stream), unlike a spec `File`'s `.slice()`-
 * able, re-readable `Blob` backing.
 */
export class File {
  #stream;

  constructor(stream, name, options = {}) {
    this.#stream = stream;
    this.name = name;
    this.type = options.type || '';
    this.lastModified = options.lastModified ?? Date.now();
  }

  /** The original stream (e.g. the `MultipartStream` `onOpen()` created) - not a copy. */
  stream() {
    return this.#stream;
  }

  async arrayBuffer() {
    return concatArrayBuffer((await readWholeStream(this.#stream)).map(chunk => (typeof chunk == 'string' ? toArrayBuffer(chunk) : chunk)));
  }

  async text() {
    return toString(await this.arrayBuffer());
  }
}

File.prototype[Symbol.toStringTag] = 'File';

/**
 * Compatible subset of the W3C `FormData` API
 * (https://xhr.spec.whatwg.org/#interface-formdata). A plain ordered list
 * of `[name, value]` pairs - `value` is a string for a text field, a
 * `File` for a file field.
 */
export class FormData {
  #entries = [];

  append(name, value, filename) {
    this.#entries.push([String(name), toFormValue(value, filename)]);
  }

  set(name, value, filename) {
    this.delete(name);
    this.append(name, value, filename);
  }

  get(name) {
    const entry = this.#entries.find(([k]) => k === name);
    return entry ? entry[1] : null;
  }

  getAll(name) {
    return this.#entries.filter(([k]) => k === name).map(([, v]) => v);
  }

  has(name) {
    return this.#entries.some(([k]) => k === name);
  }

  delete(name) {
    this.#entries = this.#entries.filter(([k]) => k !== name);
  }

  forEach(fn, thisArg) {
    for(const [k, v] of this.#entries) fn.call(thisArg, v, k, this);
  }

  *entries() {
    yield* this.#entries;
  }
  *keys() {
    for(const [k] of this.#entries) yield k;
  }
  *values() {
    for(const [, v] of this.#entries) yield v;
  }
  [Symbol.iterator]() {
    return this.entries();
  }
}

FormData.prototype[Symbol.toStringTag] = 'FormData';

function toFormValue(value, filename) {
  if(value instanceof File) return filename !== undefined ? new File(value.stream(), filename, { type: value.type, lastModified: value.lastModified }) : value;

  return String(value);
}

export class MultipartParser {
  #spa;
  #stream;

  constructor(wsi) {
    let controller;

    this.#stream = new ReadableStream({
      start: c => (controller = c),
    });

    this.#spa = new LWSSPA(wsi, {
      onOpen(name, filename) {
        debug(2, 'LWSSPA.onOpen', { name, filename });

        controller.enqueue(new MultipartStream(c => (this.controller = c), { name, filename }));
      },
      onContent(name, filename, chunk) {
        debug(2, 'LWSSPA.onContent', { name, filename, chunkSize: chunk?.byteLength });
        if(chunk) this.controller.enqueue(chunk);
      },
      onFinalContent(name, filename, chunk) {
        debug(2, 'LWSSPA.onFinalContent', { name, filename, chunkSize: chunk?.byteLength });
        if(chunk) this.controller.enqueue(chunk);
        this.controller.close();
        delete this.controller;
      },
      onClose(name, filename) {
        debug(2, 'LWSSPA.onClose', { name, filename });
        controller.close();
      },
    });
  }

  /** Escape hatch onto the underlying `LWSSPA` - e.g. for `formData()`'s own use, reading plain-field values once `close()` has run. */
  get spa() {
    return this.#spa;
  }

  write(buf) {
    debug(3, 'MultipartParser.write', buf);
    this.#spa.process(buf);
  }

  close() {
    debug(3, 'MultipartParser.close');
    this.#spa.finalize();
  }

  [Symbol.asyncIterator]() {
    return this.#stream[Symbol.asyncIterator]();
  }

  static protocol(callback = () => {}) {
    const wsi2multipart = weakMapper(wsi => {
      const parser = new MultipartParser(wsi);
      callback?.(parser);
      return parser;
    });

    debug('MultipartParser.protocol');

    return {
      onHttpBody: (wsi, buf) => wsi2multipart(wsi).write(buf),
      onHttpBodyCompletion: wsi => (wsi2multipart(wsi).close(), wsi2multipart(wsi, null)),
    };
  }
}

MultipartParser.prototype[Symbol.toStringTag] = 'MultipartParser';

/**
 * Drains a `MultipartParser` into a `FormData`.
 *
 * lws only invokes the `onOpen`/`onContent`/`onFinalContent` callbacks
 * `MultipartParser`'s async iterator is built on for parts that carry a
 * `filename` (real file uploads) - see `lws_urldecode_spa_cb()` in the
 * vendored `lws-spa.c`: `if (final == LWS_UFS_CLOSE ||
 * content_disp_filename[0]) { opt_cb(...); return 0; }`. Plain text fields
 * (no filename) skip that callback entirely and are captured instead via
 * `LWSSPA`'s own indexed/named value storage (`spa.paramNames`/`spa[name]`)
 * - populated dynamically as they arrive, readable once `close()` /
 * `finalize()` has run. So this reads both sources: the stream for file
 * fields (wrapped as `File`, its `MultipartStream` used directly - not
 * copied), and `parser.spa` for everything else.
 *
 * Awaiting this to completion requires the parser to actually finish -
 * i.e. call it after (or overlapping with) whatever feeds `write()`/
 * `close()`, same as consuming the parser's async iterator directly.
 *
 * @param  {MultipartParser} parser
 * @return {Promise<FormData>}
 */
export async function formData(parser) {
  const fd = new FormData();

  for await(const stream of parser) fd.append(stream.name, new File(stream, stream.filename));

  const spa = parser.spa;

  /* Dynamic field-name discovery (no `paramNames` declared upfront) also
     reserves a slot for file-upload fields - whose content arrives via the
     onOpen/onContent/onFinalContent callbacks above, not spa[name] - but
     leaves that slot's name empty rather than the field's actual name. */
  for(const name of spa.paramNames) if(name) fd.append(name, spa[name]);

  return fd;
}
