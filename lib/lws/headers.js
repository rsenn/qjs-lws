export class Headers {
  #map = Object.setPrototypeOf({}, null);

  /**
   * Constructs a Headers object
   *
   * @param  {Headers|Array|object}   headers   Header name/value pairs
   */
  constructor(headers) {
    if(headers instanceof Headers) {
      headers.forEach((value, name) => this.append(name, value));
    } else if(Array.isArray(headers)) {
      headers.forEach(header => {
        if(header.length != 2) throw new TypeError('Expected name/value pair to be length 2, found' + header.length);

        this.append(header[0], header[1]);
      });
    } else if(headers) {
      Object.getOwnPropertyNames(headers).forEach(name => {
        try {
          const v = headers[name];

          if(Array.isArray(v)) for(const item of v) this.append(name, item);
          else this.append(name, v);
        } catch(e) {}
      });
    }
  }

  /**
   * The append() method of the Headers interface appends a new value onto an existing header,
   *   or adds the header if it does not already exist.
   *
   * For `set-cookie`, each call appends a new entry to an internal array rather than
   * comma-folding — RFC 6265 forbids comma-merging that header.
   *
   * @param  {string} name  The name of the HTTP header you want to add
   * @param  {string} value The value of the HTTP header you want to add
   */
  append(name, value) {
    name = normalizeName(name);
    value = normalizeValue(value);

    if(name === 'set-cookie') {
      const cur = this.#map[name];

      this.#map[name] = Array.isArray(cur) ? (cur.push(value), cur) : cur != null ? [cur, value] : [value];
      return;
    }

    const oldValue = this.#map[name];

    this.#map[name] = oldValue ? oldValue + ', ' + value : value;
  }

  /**
   * The delete() method of the Headers interface deletes a header from the current Headers object.
   *
   * @param  {string} name  The name of the HTTP header you want to delete
   */
  delete(name) {
    delete this.#map[normalizeName(name)];
  }

  /**
   * The get() method of the Headers interface returns a byte string of all the values of a header
   * with a given name. If the requested header doesn't exist in the Headers object, it returns null.
   *
   * For `set-cookie`, the WHATWG spec says `get()` returns the values joined with `", "`; use
   * `getSetCookie()` to get the values as a list.
   *
   * @param  {string} name  The name of the HTTP header, case-insensitive.
   * @return {string}       the values of the retrieved header or null if this header is not set.
   */
  get(name) {
    name = normalizeName(name);

    if(!this.has(name)) return null;

    const v = this.#map[name];

    return Array.isArray(v) ? v.join(', ') : v;
  }

  /**
   * Returns every `Set-Cookie` value as a fresh array of strings (empty array when there are none).
   * Matches the WHATWG `Headers.getSetCookie()` extension.
   *
   * @return {string[]}
   */
  getSetCookie() {
    const v = this.#map['set-cookie'];

    if(v == null) return [];

    return Array.isArray(v) ? [...v] : [v];
  }

  /**
   * The has() method returns a boolean stating whether a Headers object contains a certain header.
   *
   * @param  {string} name  The name of the HTTP header, case-insensitive.
   * @return {boolean}
   */
  has(name) {
    return Object.prototype.hasOwnProperty.call(this.#map, normalizeName(name));
  }

  /**
   * Sets a new value for an existing header, or adds the header if it does not already exist.
   *
   * For `set-cookie`, the prior array is replaced with `[value]`.
   *
   * @param  {string} name  The name of the HTTP header, case-insensitive.
   * @param  {string} value The value of the HTTP header you want to add
   */
  set(name, value) {
    name = normalizeName(name);
    value = normalizeValue(value);
    this.#map[name] = name === 'set-cookie' ? [value] : value;
  }

  /**
   * Executes a callback function once per each key/value pair.
   *
   * For `set-cookie`, the callback runs once per stored value with `name === 'set-cookie'`,
   * matching what's needed when emitting headers on the wire.
   *
   * @param  {Function} callback  Function to execute for each entry in the map.
   * @param  {object}   thisArg   Value to use as this when executing callback.
   */
  forEach(callback, thisArg) {
    for(const name in this.#map)
      if(Object.prototype.hasOwnProperty.call(this.#map, name)) {
        const v = this.#map[name];

        if(Array.isArray(v)) for(const item of v) callback.call(thisArg, item, name, this);
        else callback.call(thisArg, v, name, this);
      }
  }

  /**
   * Returns a plain object representation suitable for passing to `wsi.respond(code, headers)`.
   * Keeps `set-cookie` as an array — the C binding emits one header line per element.
   *
   * @return {object}
   */
  toObject() {
    const out = {};

    for(const name in this.#map)
      if(Object.prototype.hasOwnProperty.call(this.#map, name)) {
        const v = this.#map[name];

        out[name] = Array.isArray(v) ? [...v] : v;
      }

    return out;
  }

  /**
   * Returns an iterator allowing to go through all keys. The keys are String objects.
   */
  keys() {
    const items = [];

    this.forEach((_, name) => items.push(name));

    return items.values();
  }

  /**
   * Returns an iterator allowing to go through all values. The values are String objects.
   */
  values() {
    const items = [];

    this.forEach(value => items.push(value));

    return items.values();
  }

  /**
   * Returns an iterator allowing to go through all key/value pairs.
   * Both the key and value of each pair are String objects.
   */
  entries() {
    const items = [];

    this.forEach((value, name) => items.push([name, value]));

    return items.values();
  }

  [Symbol.iterator]() {
    return this.entries();
  }
}

Headers.prototype[Symbol.toStringTag] = 'Headers';

/**
 * Normalizes a name (to lowercase)
 *
 * @returns {string}
 */
export function normalizeName(name) {
  if(typeof name != 'string') name = String(name);

  if(/[^a-z0-9\-#$%&'*+.^_`|~!]/i.test(name) || name === '') throw new TypeError('Invalid character in header field name: "' + name + '"');

  return name.toLowerCase();
}

const HTTP_WHITESPACE = /^[\t\n\r\x0c ]+|[\t\n\r\x0c ]+$/g;

/**
 * Normalizes a value: trims leading/trailing HTTP whitespace and rejects
 * NUL/CR/LF bytes, per the Fetch spec's header value validity rules. Without
 * this, a caller-controlled value containing "\r\n" could inject arbitrary
 * extra headers into the raw HTTP request written on the wire.
 *
 * @returns {string}
 */
export function normalizeValue(value) {
  if(typeof value != 'string') value = String(value);

  value = value.replace(HTTP_WHITESPACE, '');

  if(/[\x00\r\n]/.test(value)) throw new TypeError('Invalid character in header field value: "' + value + '"');

  return value;
}
