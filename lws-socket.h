#ifndef QJS_LWS_SOCKET_H
#define QJS_LWS_SOCKET_H

#include <quickjs.h>
#include <cutils.h>
#include <list.h>
#include <libwebsockets.h>

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
  BOOL want_write, completed;
  JSValue headers, write_handler;
} LWSSocket;

extern JSClassID lwsjs_socket_class_id;

LWSSocket* lwsjs_socket_new(JSContext*, struct lws*);
void lwsjs_socket_destroy(JSContext*, struct lws*);
JSValue lwsjs_socket_wrap(JSContext*, struct lws*);
JSValue lwsjs_socket_get_or_create(JSContext*, struct lws*);
JSValue lwsjs_socket_headers(JSContext*, struct lws*);
int lwsjs_socket_init(JSContext*, JSModuleDef*);
JSValue lwsjs_socket_get_by_fd(JSContext*, lws_sockfd_type);

#endif
