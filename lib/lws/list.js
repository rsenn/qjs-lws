import { assert_default } from './assert.js';
/**
 * Creates a list node
 *
 * @param  {Object}  el   associated data
 */
export function list_node(el) {
  el ??= Object.create(null);
  el.prev = null;
  el.next = null;
  return el;
}

/**
 * Initializes a list head
 *
 * @param  {Object}  el   list head
 */
export function LIST_HEAD_INIT(el = {}) {
  el.next = el;
  el.prev = el;
  return el;
}

/**
 * return the pointer of type 'type *' containing 'el' as field 'member'
 */
export function list_entry(el, member = 'data') {
  return el[member];
}

/**
 * Initializes a  list head
 *
 * @param  {Object} head   list head
 */
export function init_list_head(head) {
  head.prev = head;
  head.next = head;
}

/**
 * Insert 'el' between 'prev' and 'next'
 *
 * @param  {Object}   el    element to add
 * @param  {Object}   prev  previous element
 * @param  {Object}   next  next element
 */
export function __list_add(el, prev, next) {
  prev.next = el;
  el.prev = prev;
  el.next = next;
  next.prev = el;
}

/**
 * Add 'el' at the head of the list 'head' (= after element head)
 *
 * @param  {Object}   el    element to add
 * @param  {Object}   head  list head
 */
export function list_add(el, head) {
  __list_add(el, head, head.next);
}

/**
 * Add 'el' at the end of the list 'head' (= before element head)
 *
 * @param  {Object}   el    element to add
 * @param  {Object}   head  list head
 */
export function list_add_tail(el, head) {
  __list_add(el, head.prev, head);
}

/**
 * Remove a list element.
 *
 * @param  {Object}   el  element
 */
export function list_del(el) {
  const { prev, next } = el;

  next.prev = prev;
  prev.next = next;

  el.prev = null; /* fail safe */
  el.next = null; /* fail safe */
}

/**
 * Check whether list is empty
 *
 * @param  {Object}   el  list head
 *
 * @return  true if empty, false otherwise
 */
export function list_empty(head) {
  return head.next == head;
}

/**
 * Join two lists
 *
 * @param  {Object}   src   source list
 * @param  {Object}   dest  destination list
 */
export function list_splice(src, dest) {
  if(list_empty(src)) return;

  __list_splice(src, dest);
}

export function __list_splice(src, dest) {
  const { next, prev } = src;
  const at = dest.next;

  next.prev = dest;
  dest.next = next;

  prev.next = at;
  at.prev = prev;
}

/**
 * Sort list elements
 *
 * @param  {Object}   head  the list
 * @param  {Function} cmp   comparision function
 */
export function list_sort(head, cmp) {
  if(list_empty(head)) return;

  __list_sort(head, cmp);
}

export function __list_sort(head, cmp) {
  let list = head.next;

  list_del(head);

  for(let insize = 1; ; insize *= 2) {
    let nmerges = 0,
      oldhead = list;
    let p = oldhead,
      tail = null;
    list = tail;

    while(p) {
      let q = p,
        psize = 0,
        qsize = insize;

      nmerges++;

      for(let i = 0; i < insize; i++) {
        psize++;

        if(!(q = q.next == oldhead ? null : q.next)) break;
      }

      while(psize > 0 || (qsize > 0 && q)) {
        let e;

        if(!psize) {
          e = q;
          q = q.next;
          qsize--;
          if(q == oldhead) q = null;
        } else if(!qsize || !q) {
          e = p;
          p = p.next;
          psize--;
          if(p == oldhead) p = null;
        } else if(cmp(p, q) <= 0) {
          e = p;
          p = p.next;
          psize--;
          if(p == oldhead) p = null;
        } else {
          e = q;
          q = q.next;
          qsize--;
          if(q == oldhead) q = null;
        }

        if(tail) tail.next = e;
        else list = e;
        e.prev = tail;
        tail = e;
      }

      p = q;
    }

    tail.next = list;
    list.prev = tail;

    if(nmerges <= 1) break;
  }

  head.next = list;
  head.prev = list.prev;
  list.prev.next = head;
  list.prev = head;
}

/**
 * Reverse order of list elements
 *
 * @param  {Object}   head  the list
 */
export function list_reverse(head) {
  if(list_empty(head)) return;

  __list_reverse(head);
}

export function __list_reverse(head) {
  const { next, prev } = head;

  list_del(head);
  init_list_head(head);

  for(let q, p = next; (q = p.next); p = q) {
    __list_add(p, head, head.next);

    if(p == prev) break;
  }
}

/**
 * Delete from one list and add as another's head
 *
 * @param  {Object}   el    the element to move
 * @param  {Object}   head  the head that will precede our element
 */
export function list_move(el, head) {
  list_del(el);
  list_add(el, head);
}

/**
 * Delete from one el and add as another's tail
 *
 * @param  {Object}   el    the element to move
 * @param  {Object}   head  the head that will follow our element
 */
export function list_move_tail(el, head) {
  list_del(el);
  list_add_tail(el, head);
}

/**
 * Replace old element by new one
 *
 * @param  {Object}   old   the element to be replaced
 * @param  {Object}   el    the new element to insert
 *
 * If @old was empty, it will be overwritten.
 */
export function list_replace(old, el) {
  el.next = old.next;
  el.next.prev = el;
  el.prev = old.prev;
  el.prev.next = el;
}

/**
 * Merge two lists
 *
 * @param  {Object}   dprev  destination list previous
 * @param  {Object}   shead  source list head
 * @param  {Object}   stail  source list tail
 * @param  {Object}   dnext  destination list next
 *
 * merge result: dprev <-> (shead <-> ... <-> stail) <-> dnext
 */
export function __list_merge(dprev, shead, stail, dnext) {
  dprev.next = shead;
  shead.prev = dprev;
  stail.next = dnext;
  dnext.prev = stail;
}

/**
 * Add list to another list at the head
 *
 * @param  {Object}   dest  destination list
 * @param  {Object}   src   source list
 */
export function list_merge(dest, src) {
  if(list_empty(src)) return;

  __list_merge(dest, src.next, src.prev, dest.next);
}

/**
 * Add list @param src to @param dest at the tail
 *
 * @param  {Object}   dest  destination list
 * @param  {Object}   src   source list
 */
export function list_merge_tail(dest, src) {
  if(list_empty(src)) return;

  __list_merge(dest.prev, src.next, src.prev, dest);
}

/**
 * Forward iterates through a list
 *
 * @param  {Object}   head   the list
 */
export function* list_for_each(head, t = a => a) {
  for(let el = head.next; el != head; el = el.next) yield t(el);
}

/**
 * Forward iterates through a list
 *
 * @param  {Object}   head   the list
 */
export function* list_for_each_safe(head, t = a => a) {
  for(let el = head.next, el1 = el.next; el != head; el = el1, el1 = el.next) yield t(el);
}

/**
 * Reverse iterates through a list
 *
 * @param  {Object}   head   the list
 */
export function* list_for_each_prev(head, t = a => a) {
  for(let el = head.prev; el != head; el = el.prev) yield t(el);
}

/**
 * Reverse iterates through a list
 *
 * @param  {Object}   head   the list
 */
export function* list_for_each_prev_safe(head, t = a => a) {
  for(let el = head.prev, el1 = el.prev; el != head; el = el1, el1 = el.prev) yield t(el);
}

/**
 * Linked list class
 *
 * @class
 */
export class LinkedList {
  #head = LIST_HEAD_INIT();

  constructor(iterable) {
    if(iterable != null && typeof iterable == 'object' && Symbol.iterator in iterable) this.appendRange(iterable);
  }

  /**
   * Checks whether list is empty
   *
   * @return {Boolean}  true when empty, false otherwise
   */
  get empty() {
    return list_empty(this.#head);
  }

  /**
   * Get the first object in list
   *
   * @return {*}  first object in list
   */
  get front() {
    return this.#head.next.data;
  }

  /**
   * Get the last object in list
   *
   * @return {*}  last object in list
   */
  get back() {
    return this.#head.prev.data;
  }

  /**
   * Pushes a new value to the list head
   *
   * @param {*}  data  the value to push
   */
  pushFront(data) {
    __list_add({ data }, this.#head, this.#head.next);
  }

  /**
   * Pushes a new value to the list tail
   *
   * @param {*}  data  the value to push
   */
  pushBack(data) {
    __list_add({ data }, this.#head.prev, this.#head);
  }

  /**
   * Pops a value from the list head
   *
   * @return {*}  the value popped
   */
  popFront() {
    assert_default(!list_empty(this.#head));

    const { next } = this.#head;
    list_del(next);
    return next.data;
  }

  /**
   * Pops a value from the list tail
   *
   * @return {*}  the value popped
   */
  popBack() {
    assert_default(!list_empty(this.#head));

    const { prev } = this.#head;
    list_del(prev);
    return prev.data;
  }

  /**
   * Prepends a range of values to the list head
   *
   * @param {Iterator}  rng   range of values
   */
  prependRange(rng) {
    let head = this.#head;

    for(let data of rng) {
      const el = { data };
      __list_add(el, head, head.next);
      head = el;
    }
  }

  /**
   * Appends a range of values to the list tail
   *
   * @param {Iterator}  rng   range of values
   */
  appendRange(rng) {
    const head = this.#head;

    for(let data of rng) __list_add({ data }, head.prev, head);
  }

  /**
   * Reverses the list elements
   */
  reverse() {
    list_reverse(this.#head);
    return this;
  }

  /**
   * Sorts the list elements
   *
   * @param {Function}  cmp   element comparision function
   */
  sort(cmp = (a, b) => a - b) {
    list_sort(this.#head, (a, b) => cmp(a.data, b.data));
    return this;
  }

  /**
   * Clones the whole list
   *
   * @return {Object}  new list
   */
  clone() {
    return new this.constructor(this);
  }

  /**
   * Iterates through the list
   */
  [Symbol.iterator]() {
    return list_for_each_safe(this.#head, list_entry);
  }
}

LinkedList.prototype[Symbol.toStringTag] = 'LinkedList';