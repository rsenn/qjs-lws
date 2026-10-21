#ifndef QJS_LWS_BUFFER_H
#define QJS_LWS_BUFFER_H

/* write ranges as lws takes them, (unsigned char **p, unsigned char *end), and their JS wrapper:
   a 16 byte ArrayBuffer holding the struct, made by View() or handed to lws callbacks */

#include <quickjs.h>
#include <stdint.h>
#include <stddef.h>
#include <libwebsockets.h>

struct lwsjs_view {
  uint8_t* p;   /* write cursor, advanced on write */
  uint8_t* end; /* one past the last writable byte */
};

/* a buffer is the read cursor (start) followed by the write range (p, end): the first two
   pointers are a view of the bytes written and not yet read, [start, p), the last two a view of
   the room left, [p, end). both share p, so writing grows what can be read. a struct lwsjs_buffer*
   is not usable as a struct lwsjs_view*: take lwsjs_buffer_readable() or &b->writable */
struct lwsjs_buffer {
  uint8_t* start;
  struct lwsjs_view writable;
};

_Static_assert(sizeof(struct lwsjs_buffer) == sizeof(struct lwsjs_view) + sizeof(uint8_t*), "lwsjs_buffer layout");

static inline struct lwsjs_view*
lwsjs_buffer_readable(struct lwsjs_buffer* b) {
  return (struct lwsjs_view*)b;
}

JSValue lwsjs_view_wrap(JSContext*, struct lwsjs_view*);
JSValue lwsjs_buffer_wrap(JSContext*, struct lwsjs_buffer*);

/* view of the room left in a process_html_args: from p + len up to p + max_len. returns the
   start of the view, NULL (and an empty view) if args is unusable */
static inline uint8_t*
lwsjs_view_pha(struct lwsjs_view* v, const struct lws_process_html_args* a) {
  if(!a || !a->p || a->max_len < 0) {
    v->p = v->end = NULL;
    return NULL;
  }

  v->p = (uint8_t*)a->p + (a->len < 0 ? 0 : a->len > a->max_len ? a->max_len : a->len);
  v->end = (uint8_t*)a->p + a->max_len;
  return v->p;
}

/* view of a whole buffer, returns its start */
static inline uint8_t*
lwsjs_view_buf(struct lwsjs_view* v, void* buf, size_t len) {
  v->p = buf;
  v->end = (uint8_t*)buf + len;
  return v->p;
}

/* view over a whole buffer, remembering the start */
static inline uint8_t*
lwsjs_buffer_from(struct lwsjs_buffer* b, void* buf, size_t len) {
  return b->start = lwsjs_view_buf(&b->writable, buf, len);
}

/* bytes written and not read yet */
static inline size_t
lwsjs_buffer_len(const struct lwsjs_buffer* b) {
  return b->writable.p - b->start;
}

/* bytes written since start */
static inline size_t
lwsjs_view_len(const struct lwsjs_view* v, const uint8_t* start) {
  return v->p - start;
}

uint8_t* lwsjs_view_args(JSContext*, struct lwsjs_view**, struct lwsjs_view*, int, JSValueConst[]);
void lwsjs_view_commit(JSContext*, JSValueConst[], const struct lwsjs_view*);

struct lwsjs_view* lwsjs_view_data2(JSContext*, JSValueConst);
struct lwsjs_view* lwsjs_view_data(JSContext*, JSValueConst);
void lwsjs_view_detach(JSContext*, JSValueConst);
struct lwsjs_buffer* lwsjs_buffer_data2(JSContext*, JSValueConst);
struct lwsjs_buffer* lwsjs_buffer_data(JSContext*, JSValueConst);

int lwsjs_buffer_init(JSContext*, JSModuleDef*);

#endif /* QJS_LWS_BUFFER_H */
