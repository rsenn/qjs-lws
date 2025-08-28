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
          this.append(name, headers[name]);
        } catch(e) {}
      });
    }
  }

  /**
   * The append() method of the Headers interface appends a new value onto an existing header,
   *   or adds the header if it does not already exist.
   *
   * @param  {string} name  The name of the HTTP header you want to add
   * @param  {string} value The value of the HTTP header you want to add
   */
  append(name, value) {
    name = normalizeName(name);
    value = normalizeValue(value);
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
   * @param  {string} name  The name of the HTTP header, case-insensitive.
   * @return {string}       the values of the retrieved header or null if this header is not set.
   */
  get(name) {
    name = normalizeName(name);

    return this.has(name) ? this.#map[name] : null;
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
   * @param  {string} name  The name of the HTTP header, case-insensitive.
   * @param  {string} value The value of the HTTP header you want to add
   */
  set(name, value) {
    this.#map[normalizeName(name)] = normalizeValue(value);
  }

  /**
   * Executes a callback function once per each key/value pair.
   *
   * @param  {Function} callback  Function to execute for each entry in the map.
   * @param  {object}   thisArg   Value to use as this when executing callback.
   */
  forEach(callback, thisArg) {
    for(const name in this.#map) if(Object.prototype.hasOwnProperty.call(this.#map, name)) callback.call(thisArg, this.#map[name], name, this);
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

/**
 * Normalizes a value (conversion to string)
 *
 * @returns {string}
 */
export function normalizeValue(value) {
  if(typeof value != 'string') value = String(value);

  return value;
}
