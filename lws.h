#ifndef QJS_LWS_H
#define QJS_LWS_H

#include <quickjs.h>
#include <cutils.h>
#include <list.h>
#include <ctype.h>
#include <libwebsockets.h>

#if __SIZEOF_POINTER__ == 8
#define intptr int64_t
#elif __SIZEOF_POINTER__ == 4
#define intptr int32_t
#endif

#ifdef DEBUG_OUTPUT
#define DEBUG(fmt, x...) lwsl_user("\x1b[0m" fmt, x)
#define DEBUG_WSI(wsi, fmt, x...) lwsl_user("wsi#%d " fmt, socket_getid(wsi), x)
#else
#define DEBUG(fmt, x...)
#define DEBUG_WSI(wsi, fmt, x...)
#endif

#define VISIBLE __attribute__((visibility("default")))

#define JS_ATOM_MAX_INT ((1u << 31) - 1)

size_t camelize(char*, size_t, const char*);
size_t decamelize(char*, size_t, const char*);
int lwsjs_html_process_args(JSContext*, struct lws_process_html_args*, int, JSValueConst[]);
int lwsjs_spa_init(JSContext*, JSModuleDef*);
void lwsjs_uri_toconnectinfo(JSContext*, char*, struct lws_client_connect_info*);
char* lwsjs_connectinfo_to_uri(JSContext*, const struct lws_client_connect_info*);
enum lws_callback_reasons lwsjs_callback_find(const char*);
const char* lwsjs_callback_name(enum lws_callback_reasons);
void lwsjs_get_lws_callbacks(JSContext*, JSValueConst, JSValue[], size_t);

int lwsjs_init(JSContext*, JSModuleDef*);
JSModuleDef* js_init_module(JSContext*, const char*);

static inline int
clz(uint32_t i) {
  int ret = 0;

  for(ret = 0; !(i & 0x80000000); ++ret)
    i <<= 1;

  return ret;
}

static inline size_t
find_charset(const char* s, const char* set, size_t setlen) {
  size_t i, j;

  for(i = 0; s[i]; ++i)
    for(j = 0; j < setlen; ++j)
      if(s[i] == set[j])
        return i;

  return i;
}

static inline size_t
findb_charset(const char* s, size_t len, const char* set, size_t setlen) {
  size_t i, j;

  for(i = 0; i < len; ++i)
    for(j = 0; j < setlen; ++j)
      if(s[i] == set[j])
        return i;

  return i;
}

static inline int
list_size(struct list_head* list) {
  struct list_head* el;
  int i = 0;

  list_for_each(el, list) { ++i; }

  return i;
}

/* Renders up to the first 40 bytes of `data` into `out` (must be >= 41
   bytes) as a single-line, terminal-safe preview for TX/RX logging: every
   non-printable byte becomes '.', nothing else is escaped. Truncation past
   40 bytes is the caller's job to flag (compare `len` against 40). */
static inline void
log_preview(char* out, size_t outsz, const void* data, size_t len) {
  const uint8_t* p = data;
  size_t max = len < outsz - 1 ? len : outsz - 1;
  size_t i;

  for(i = 0; i < max; ++i)
    out[i] = isprint(p[i]) ? (char)p[i] : '.';

  out[i] = '\0';
}

#endif /* defined QJS_LWS_H */
