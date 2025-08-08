export class EventTarget {
  #listeners = {};

  addEventListener(type, listener) {
    checkType(type);
    checkListener(listener);

    (this.#listeners[type] ??= []).push(listener);
  }

  removeEventListener(type, listener) {
    checkType(type);
    checkListener(listener);

    if (!(type in this.#listeners)) return;

    removeAll(this.#listeners[type], listener);

    if (this.#listeners[type].length == 0) delete this.#listeners[type];
  }

  dispatchEvent(event) {
    const { type } = event;

    if (!(type in this.#listeners)) return;

    const queue = [...this.#listeners[type]];

    if (event != null && typeof event == 'object') if ('target' in event || 'detail' in event) event.target = this;

    for (let listener of queue) listener(event);

    /* Also fire if this EventTarget has an `on${EVENT_TYPE}` property that's a function */
    if (typeof this['on' + type] == 'function') this['on' + type](event);
  }
}

EventTarget.prototype[Symbol.toStringTag] = 'EventTarget';

/*export class EventEmitter {
  #listeners = {};

  on(type, listener) {
    checkType(type);
    checkListener(listener);

    (this.#listeners[type] ??= []).push(listener);
  }

  removeListener(type, listener) {
    checkType(type);
    checkListener(listener);

    if(!(type in this.#listeners)) return;

    const handlers = this.#listeners[type];

    removeAll(handlers, listener);

    if(handlers.length == 0) delete this.#listeners[type];
  }

  removeAllListeners(type) {
    if(!type) {
      for(let key in events) delete events[key];
      return;
    }

    checkType(type);

    if(!(type in this.#listeners)) return;

    delete this.#listeners[type];
  }

  rawListeners(type) {
    checkType(type);

    if(!(type in this.#listeners)) return;

    return [...this.#listeners[type]];
  }

  emit(type, ...args) {
    if(!(type in this.#listeners)) return;

    for(let handler of this.#listeners[type]) handler.apply(this, args);
  }

  once(type, listener) {
    const callback = (...args) => {
      this.removeListener(type, callback);
      listener.apply(this, args);
    };

    callback.listener = listener;

    this.on(type, callback);
  }
}

EventEmitter.prototype[Symbol.toStringTag] = 'EventEmitter';*/

function checkType(type) {
  if (typeof type != 'string') throw new TypeError('`type` must be a string');
}

function checkListener(listener) {
  if (typeof listener != 'function') throw new TypeError('`listener` must be a function');
}

function removeAll(arr, elem) {
  for (let i = arr.length; i >= 0; i--) if (arr[i] === elem) arr.splice(i, 1);
}

export function once(emitter, ...events) {
  if (events.length == 1 && Array.isArray(events[0])) events = events[0];
  return waitOne(emitter, events);
}

export function waitOne(emitter, events, options = { passive: true, capture: false }) {
  return new Promise(resolve => {
    events.forEach(type => emitter.addEventListener(type, handler, options));

    function handler(event) {
      events.forEach(type => emitter.removeEventListener(type, handler, options));
      resolve(event);
    }
  });
}
