#ifndef QJS_LWS_SOCKET_H
#define QJS_LWS_SOCKET_H

#include <quickjs.h>
#include <cutils.h>
#include <list.h>

typedef enum {
  SOCKET_OTHER = 0,
  SOCKET_WS,
  SOCKET_HTTP,
} LWSSocketType;

typedef struct {
  struct list_head link;
  int ref_count;
  struct lws* wsi;
  uint32_t id;
  LWSSocketType type;
  JSObject* obj;
  BOOL client : 1, want_write : 1, completed : 1, closed : 1;
  JSValue headers, write_handler;
  int response_code;
} LWSSocket;

extern JSClassID lwsjs_socket_class_id;

LWSSocket* lwsjs_socket_new(JSContext*, struct lws*);
void lwsjs_socket_destroy(JSContext*, struct lws*);
JSValue lwsjs_socket_wrap(JSContext*, struct lws*);
JSValue lwsjs_socket_get_or_create(JSContext*, struct lws*);
JSValue lwsjs_socket_headers(JSContext*, struct lws*);
int lwsjs_socket_init(JSContext*, JSModuleDef*);
JSValue lwsjs_socket_get_by_fd(JSContext*, int);
LWSSocketType socket_type(struct lws* wsi);
LWSSocket* socket_get(struct lws* wsi);

static inline LWSSocket*
lwsjs_socket_data(JSValueConst value) {
  return JS_GetOpaque(value, lwsjs_socket_class_id);
}

static inline LWSSocket*
lwsjs_socket_data2(JSContext* ctx, JSValueConst value) {
  return JS_GetOpaque2(ctx, value, lwsjs_socket_class_id);
}

#endif
