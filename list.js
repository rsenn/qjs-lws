export const list_head = {
  prev: null,
  next: null,
};

export function LIST_HEAD_INIT(el = {}) {
  el.next = el;
  el.prev = el;
  return el;
}

/* return the pointer of type 'type *' containing 'el' as field 'member' */
//#define list_entry(el, type, member) container_of(el, type, member)

export function init_list_head(head) {
  head.prev = head;
  head.next = head;
}

/* insert 'el' between 'prev' and 'next' */
export function __list_add(el, prev, next) {
  prev.next = el;
  el.prev = prev;
  el.next = next;
  next.prev = el;
}

/* add 'el' at the head of the list 'head' (= after element head) */
export function list_add(el, head) {
  __list_add(el, head, head.next);
}

/* add 'el' at the end of the list 'head' (= before element head) */
export function list_add_tail(el, head) {
  __list_add(el, head.prev, head);
}

export function list_del(el) {
  const prev = el.prev;
  const next = el.next;
  prev.next = next;
  next.prev = prev;
  el.prev = null; /* fail safe */
  el.next = null; /* fail safe */
}

export function list_empty(el) {
  return el.next == el;
}

export function* list_for_each(  head) {
  for(let el = head.next; el != head; el = el.next) yield el;
}

export function* list_for_each_safe(head) {
  for(let el = head.next, el1 = el.next; el != head; el = el1, el1 = el.next) yield el;
}

export function* list_for_each_prev(head) {
  for(let el = head.prev; el != head; el = el.prev) yield el;
}

export function* list_for_each_prev_safe(  head) {
  for(let el = head.prev, el1 = el.prev; el != head; el = el1, el1 = el.prev) yield el;
}
