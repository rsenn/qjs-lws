#ifndef QJS_LWS_SOCKET_H
#define QJS_LWS_SOCKET_H

#include <quickjs.h>
#include <cutils.h>
#include <list.h>

typedef enum {
  SOCKET_RAW = 0,
  SOCKET_WS,
  SOCKET_HTTP,
} LWSSocketType;

typedef struct {
  struct list_head link;
  int ref_count;
  struct lws* wsi;
  int id;
  LWSSocketType type;
  char *uri, *proto;
  void* obj;
  BOOL client : 1, want_write : 1, redirected_to_get : 1, completed : 1, closed : 1, dispatching : 1;
  int dispatch_reason;
  JSValue headers, write_handler;
  int response_code, body_pending, method;
  struct list_head write_queue; /* pending WriteChunks, FIFO */
  size_t write_buffered;        /* bytes still queued at our layer */
} LWSSocket;

extern JSClassID lwsjs_socket_class_id;

int socket_getid(struct lws* wsi);
LWSSocket* socket_get(struct lws* wsi);
LWSSocket* socket_alloc(JSContext* ctx);
void socket_flush(LWSSocket* s);
struct lws* lwsjs_socket_wsi(JSValueConst);
void lwsjs_socket_destroy(JSContext*, struct lws*);
JSValue lwsjs_socket_wrap(JSContext*, LWSSocket*);
JSValue lwsjs_socket_create(JSContext*, struct lws*);
JSValue lwsjs_socket_get_or_create(JSContext*, struct lws*);
JSValue lwsjs_socket_headers(JSContext*, struct lws*, char**);
int lwsjs_socket_init(JSContext*, JSModuleDef*);
int lwsjs_method_index(const char* method);
const char* lwsjs_method_name(int index);
JSValue lwsjs_socket_fromwsi(JSContext* ctx, struct lws* wsi);

static inline LWSSocket*
lwsjs_socket_data(JSValueConst value) {
  return JS_GetOpaque(value, lwsjs_socket_class_id);
}

static inline LWSSocket*
lwsjs_socket_data2(JSContext* ctx, JSValueConst value) {
  return JS_GetOpaque2(ctx, value, lwsjs_socket_class_id);
}

#endif /* defined QJS_LWS_SOCKET_H */
