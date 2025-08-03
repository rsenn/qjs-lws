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
  BOOL client, want_write, completed, closed, post;
  JSValue headers, write_handler;
  int response_code, body_pending, method;
} LWSSocket;

extern JSClassID lwsjs_socket_class_id;

LWSSocketType socket_type(struct lws* wsi);
LWSSocket* socket_get(struct lws* wsi);
LWSSocket* lwsjs_socket_new(JSContext*, struct lws*);
void lwsjs_socket_destroy(JSContext*, struct lws*);
JSValue lwsjs_socket_wrap(JSContext*, struct lws*);
JSValue lwsjs_socket_get_or_create(JSContext*, struct lws*);
JSValue lwsjs_socket_headers(JSContext*, struct lws*);
int lwsjs_socket_init(JSContext*, JSModuleDef*);
JSValue lwsjs_socket_get_by_fd(JSContext*, int);
int lwsjs_method_index(const char* method);
const char* lwsjs_method_name(int index);

static inline LWSSocket*
lwsjs_socket_data(JSValueConst value) {
  return JS_GetOpaque(value, lwsjs_socket_class_id);
}

static inline LWSSocket*
lwsjs_socket_data2(JSContext* ctx, JSValueConst value) {
  return JS_GetOpaque2(ctx, value, lwsjs_socket_class_id);
}

#endif
