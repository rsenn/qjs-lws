/**
 * WHATWG FormData implementation
 * 
 * A collection of key/value pairs representing form fields and their values.
 * Supports both string values and File objects (for multipart/form-data).
 * 
 * @see https://xhr.spec.whatwg.org/#interface-formdata
 */

export class FormData {
  #entries = [];

  /**
   * Creates a new FormData object
   * 
   * @param {HTMLFormElement} [form] - Not supported in this implementation (server-side)
   */
  constructor(form) {
    if(form !== undefined && form !== null) {
      throw new TypeError('FormData constructor does not support form element parameter in server-side environment');
    }
  }

  /**
   * Appends a new value onto an existing key, or adds the key if it doesn't exist
   * 
   * @param {string} name - The name of the field
   * @param {string|Blob|File} value - The value (string or File/Blob)
   * @param {string} [filename] - Optional filename for File values
   */
  append(name, value, filename) {
    name = String(name);
    
    if(typeof value !== 'string') {
      // If it's a Blob/File-like object
      if(value && typeof value === 'object') {
        if(filename !== undefined) {
          // Create a copy with the new filename if possible
          value = { ...value, name: String(filename) };
        }
      } else {
        value = String(value);
      }
    }
    
    this.#entries.push([name, value]);
  }

  /**
   * Deletes a key and its value(s)
   * 
   * @param {string} name - The name of the field to delete
   */
  delete(name) {
    name = String(name);
    this.#entries = this.#entries.filter(([key]) => key !== name);
  }

  /**
   * Returns the first value associated with a given key
   * 
   * @param {string} name - The name of the field
   * @returns {string|File|null} The first value, or null if not found
   */
  get(name) {
    name = String(name);
    const entry = this.#entries.find(([key]) => key === name);
    return entry ? entry[1] : null;
  }

  /**
   * Returns all values associated with a given key
   * 
   * @param {string} name - The name of the field
   * @returns {Array<string|File>} Array of values
   */
  getAll(name) {
    name = String(name);
    return this.#entries.filter(([key]) => key === name).map(([, value]) => value);
  }

  /**
   * Returns whether a FormData object contains a certain key
   * 
   * @param {string} name - The name of the field
   * @returns {boolean} True if the key exists
   */
  has(name) {
    name = String(name);
    return this.#entries.some(([key]) => key === name);
  }

  /**
   * Sets a new value for an existing key, or adds the key/value if it doesn't exist
   * 
   * @param {string} name - The name of the field
   * @param {string|Blob|File} value - The value
   * @param {string} [filename] - Optional filename for File values
   */
  set(name, value, filename) {
    name = String(name);
    
    if(typeof value !== 'string') {
      if(value && typeof value === 'object') {
        if(filename !== undefined) {
          value = { ...value, name: String(filename) };
        }
      } else {
        value = String(value);
      }
    }
    
    // Remove all existing entries with this name
    this.#entries = this.#entries.filter(([key]) => key !== name);
    
    // Add the new entry
    this.#entries.push([name, value]);
  }

  /**
   * Returns an iterator allowing to go through all key/value pairs
   * 
   * @returns {Iterator} Iterator of [name, value] pairs
   */
  entries() {
    return this.#entries[Symbol.iterator]();
  }

  /**
   * Returns an iterator allowing to go through all keys
   * 
   * @returns {Iterator} Iterator of keys
   */
  keys() {
    return this.#entries.map(([key]) => key)[Symbol.iterator]();
  }

  /**
   * Returns an iterator allowing to go through all values
   * 
   * @returns {Iterator} Iterator of values
   */
  values() {
    return this.#entries.map(([, value]) => value)[Symbol.iterator]();
  }

  /**
   * Executes a provided function once for each key/value pair
   * 
   * @param {Function} callback - Function to execute for each entry
   * @param {*} [thisArg] - Value to use as this when executing callback
   */
  forEach(callback, thisArg) {
    for(const [name, value] of this.#entries) {
      callback.call(thisArg, value, name, this);
    }
  }

  /**
   * Default iterator - same as entries()
   * 
   * @returns {Iterator} Iterator of [name, value] pairs
   */
  [Symbol.iterator]() {
    return this.entries();
  }
}

Object.defineProperty(FormData.prototype, Symbol.toStringTag, {
  value: 'FormData',
  configurable: true
});
