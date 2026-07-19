import { LWSSPA, toString, toArrayBuffer } from 'lws.so';
import { ReadableStream } from './streams.js';
import { concatArrayBuffer, readWholeStream } from './stream-utils.js';
import { debug } from './util.js';

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

function randomBoundary() {
  let s = '';

  for(let i = 0; i < 32; i++) s += ((Math.random() * 16) | 0).toString(16);

  return s;
}

/* Content-Disposition's name="..."/filename="..." are quoted-strings inside
   a header line - backslash/quote need escaping, and a raw CR/LF would
   inject an extra header line, so it's rejected outright rather than
   silently mangled (same posture as normalizeValue() in headers.js). */
function quotedString(s, label) {
  s = String(s);

  if(/[\r\n]/.test(s)) throw new TypeError(`MultipartFormData: ${label} must not contain CR/LF`);

  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Encodes a plain object of `{ name: string | File }` pairs as a
 * `multipart/form-data` request body - a `ReadableStream` that generates
 * the MIME boilerplate and each part's content lazily, as it's read,
 * rather than buffering the whole encoded body up front. A `File` field's
 * own stream (`.stream()`) is read straight through, chunk by chunk.
 *
 * Pluggable directly into `Request`/`fetch()` as `body` - `Request`'s
 * constructor (./request.js) picks up `.contentType` on its own and sets
 * the `Content-Type` header for you when the caller didn't already set
 * one:
 *
 *   const body = new MultipartFormData({
 *     username: 'alice',
 *     avatar: new File(fileStream, 'photo.png', { type: 'image/png' }),
 *   });
 *   await fetch(url, { method: 'POST', body });
 */
export class MultipartFormData extends ReadableStream {
  boundary;

  constructor(fields = {}) {
    const boundary = '----FormBoundary' + randomBoundary();

    async function* generate() {
      for(const name in fields) {
        const value = fields[name];

        yield `--${boundary}\r\n`;

        if(value instanceof File) {
          yield `Content-Disposition: form-data; name="${quotedString(name, 'field name')}"; filename="${quotedString(value.name, 'file name')}"\r\nContent-Type: ${value.type || 'application/octet-stream'}\r\n\r\n`;
          yield* value.stream();
        } else if(typeof value === 'string') {
          yield `Content-Disposition: form-data; name="${quotedString(name, 'field name')}"\r\n\r\n`;
          yield value;
        } else {
          throw new TypeError(`MultipartFormData: field "${name}" must be a string or File, got ${typeof value}`);
        }

        yield '\r\n';
      }

      yield `--${boundary}--\r\n`;
    }

    let iterator;

    super({
      start: () => (iterator = generate()),
      pull: async controller => {
        const { value, done } = await iterator.next();

        done ? controller.close() : controller.enqueue(value);
      },
      cancel: () => iterator.return?.(),
    });

    this.boundary = boundary;
  }

  /** The `Content-Type` header value for a request carrying this body. */
  get contentType() {
    return `multipart/form-data; boundary=${this.boundary}`;
  }
}

MultipartFormData.prototype[Symbol.toStringTag] = 'MultipartFormData';

/**
 * Mixin adding streaming multipart/form-data *parsing* to a class - the
 * server-side, wsi-driven counterpart of `MultipartFormData` above. Wraps
 * `LWSSPA` directly: `onOpen`/`onContent`/`onFinalContent` enqueue
 * `MultipartStream` parts as they arrive, `onClose` closes the part queue.
 *
 * Meant to sit on `ServerRequest` (./request.js), so multipart parsing is
 * just part of what a request *is* rather than a separate object it has to
 * carry around - `HttpProtocol` (./protocols.js) drives it directly off
 * `onHttp`/`onHttpBody`/`onHttpBodyCompletion`:
 *
 *   class ServerRequest extends MultipartMixin(Body) { ... }
 *   ...
 *   if(isMultipart(req.headers)) req._startMultipart(wsi);   // onHttp
 *   req._writeMultipart(buf);                                // onHttpBody - always safe, no-ops when not multipart
 *   req._closeMultipart();                                   // onHttpBodyCompletion - ditto
 *   await req.formData();                                    // overrides Body.formData() - drains the LWSSPA parse instead of urlencoded parsing
 *
 * lws only invokes `onOpen`/`onContent`/`onFinalContent` for parts that
 * carry a `filename` (real file uploads) - see `lws_urldecode_spa_cb()` in
 * the vendored `lws-spa.c`: `if (final == LWS_UFS_CLOSE ||
 * content_disp_filename[0]) { opt_cb(...); return 0; }`. Plain text fields
 * (no filename) skip that callback entirely and are captured instead via
 * `LWSSPA`'s own indexed/named value storage (`spa.paramNames`/`spa[name]`)
 * - populated dynamically as they arrive, readable once `_closeMultipart()`
 * has run. `formData()` below reads both sources.
 */
export const MultipartMixin = Base =>
  class extends Base {
    #spa;
    #parts;

    /** True once `_startMultipart()` has run - this request actually is multipart/form-data. */
    get isMultipart() {
      return !!this.#spa;
    }

    /** Escape hatch onto the underlying `LWSSPA` - e.g. for `.paramNames`/`.length`. */
    get spa() {
      return this.#spa;
    }

    _startMultipart(wsi) {
      let controller;

      this.#parts = new ReadableStream({ start: c => (controller = c) });

      this.#spa = new LWSSPA(wsi, {
        onOpen(name, filename) {
          debug(2, 'MultipartMixin.onOpen', { name, filename });

          controller.enqueue(new MultipartStream(c => (this.controller = c), { name, filename }));
        },
        onContent(name, filename, chunk) {
          debug(2, 'MultipartMixin.onContent', { name, filename, chunkSize: chunk?.byteLength });
          if(chunk) this.controller.enqueue(chunk);
        },
        onFinalContent(name, filename, chunk) {
          debug(2, 'MultipartMixin.onFinalContent', { name, filename, chunkSize: chunk?.byteLength });
          if(chunk) this.controller.enqueue(chunk);
          this.controller.close();
          delete this.controller;
        },
        onClose(name, filename) {
          debug(2, 'MultipartMixin.onClose', { name, filename });
          controller.close();
        },
      });
    }

    _writeMultipart(buf) {
      debug(3, 'MultipartMixin._writeMultipart', buf);
      this.#spa?.process(buf);
    }

    _closeMultipart() {
      debug(3, 'MultipartMixin._closeMultipart');
      this.#spa?.finalize();
    }

    /** Async-iterates the raw parts (`MultipartStream`s), in arrival order. */
    [Symbol.asyncIterator]() {
      return this.#parts[Symbol.asyncIterator]();
    }

    /**
     * Drains the multipart parse into a plain, null-prototype object of
     * name -> value pairs - `value` is a string for a text field, a `File`
     * for a file field, or an array of either if a name repeats. Falls
     * back to the base class's own `formData()` (`Body`'s urlencoded
     * parsing) when `_startMultipart()` was never called.
     *
     * Awaiting this to completion requires the parse to actually finish -
     * i.e. call it after (or overlapping with) whatever feeds
     * `_writeMultipart()`/`_closeMultipart()`.
     */
    async formData() {
      if(!this.#spa) return super.formData();

      this.bodyUsed = true;

      const out = Object.setPrototypeOf({}, null);

      const append = (name, value) => {
        if(name in out) out[name] = [].concat(out[name], value);
        else out[name] = value;
      };

      for await(const stream of this) append(stream.name, new File(stream, stream.filename));

      /* Dynamic field-name discovery (no `paramNames` declared upfront)
         also reserves a slot for file-upload fields - whose content
         arrives via the callbacks above, not spa[name] - but leaves that
         slot's name empty rather than the field's actual name. */
      for(const name of this.#spa.paramNames) if(name) append(name, this.#spa[name]);

      return out;
    }
  };
