#ifndef QJS_LWS_SOCKET_H
#define QJS_LWS_SOCKET_H

#include <quickjs.h>
#include <cutils.h>
#include <list.h>
#include <libwebsockets.h>

typedef struct {
  struct list_head link;
  struct lws* wsi;
  JSObject* obj;
  BOOL want_write : 8;
  BOOL completed : 8;
  JSValue headers;
  JSValue write_handler;
} LWSSocket;

extern JSClassID lws_socket_class_id;

LWSSocket* socket_get_by_fd(lws_sockfd_type);
LWSSocket* socket_new(JSContext*, struct lws*);
void socket_destroy(struct lws*, JSContext*);
JSValue js_socket_wrap(JSContext*, struct lws*);
JSValue js_socket_get_or_create(JSContext*, struct lws*);
JSValue js_socket_headers(JSContext*, struct lws*);
int lws_socket_init(JSContext*, JSModuleDef*);

#endif
