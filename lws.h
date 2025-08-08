#ifndef QJS_LWS_H
#define QJS_LWS_H

#include <quickjs.h>
#include <cutils.h>
#include <list.h>
#include <ctype.h>

typedef struct lws_protocols LWSProtocols;
typedef struct lws_protocol_vhost_options LWSProtocolVHostOptions;
typedef struct lws_context_creation_info LWSContextCreationInfo;
typedef struct lws_client_connect_info LWSClientConnectInfo;

#if __SIZEOF_POINTER__ == 8
#define intptr int64_t
#elif __SIZEOF_POINTER__ == 4
#define intptr int32_t
#endif

#ifdef DEBUG_OUTPUT
#define DEBUG(x...) lwsl_user("\x1b[0m" x)
#define DEBUG_WSI(wsi, x...) lwsl_wsi_user(wsi, x)
#else
#define DEBUG(x...)
#define DEBUG_WSI(wsi, x...)
#endif

#define VISIBLE __attribute__((visibility("default")))

#define JS_ATOM_MAX_INT ((1u << 31) - 1)

size_t camelize(char*, size_t, const char*);
size_t decamelize(char*, size_t, const char*);
int lwsjs_spa_init(JSContext*, JSModuleDef*);
void lwsjs_uri_toconnectinfo(JSContext*, char*, LWSClientConnectInfo*);
// void lwsjs_uri_toobj(JSContext*, char*, JSValueConst);
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

static inline int
list_size(struct list_head* list) {
  struct list_head* el;
  int i = 0;

  list_for_each(el, list) { ++i; }

  return i;
}

#endif
