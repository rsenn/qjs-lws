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
  BOOL client : 1, want_write : 1, redirected_to_get : 1, completed : 1, closed : 1, dispatching : 1, close_code_set : 1;
  int dispatch_reason;
  JSValue headers;
  int response_code, body_pending, method;
  /* Our own copy of the code/reason a local .close() call was given,
     stashed here (not read back from lws's own ping_payload_buf via
     lws_get_close_length()/lws_get_close_payload()) because that buffer
     gets reused - and mutated (WS frame masking is applied in place for
     client-originated frames, including the close frame itself) - by the
     time LWS_CALLBACK_CLOSED/CLIENT_CLOSED actually fires. See
     lwsjs_socket_close() (lws-socket.c) and its use in
     lwsjs_callback_protocol() (lws-protocol.c). */
  uint16_t close_code;
  uint8_t* close_reason;
  uint32_t close_reason_len;
  /* Owns the retry/idle policy given to a `.clientConnect()` call's
     `retry` option, if any (see retry_bo_fromobj(), lws-context.c): lws
     stores this pointer directly on the wsi for its whole life
     (wsi->retry_policy), so it can't be freed alongside the stack-local
     lws_client_connect_info it was parsed into - this socket's lifetime is
     the right one instead. Freed in socket_free() (lws-socket.c). */
  struct lws_retry_bo* retry;
  struct list_head write_queue; /* pending WriteChunks, FIFO */
  size_t write_buffered;        /* bytes still queued at our layer */
} LWSSocket;

extern JSClassID lwsjs_socket_class_id;

int socket_getid(struct lws* wsi);
LWSSocket* socket_get(struct lws* wsi);
LWSSocket* socket_alloc(JSContext* ctx);
int socket_flush(LWSSocket* s);
BOOL socket_write_queue_front_is_callback(LWSSocket* s);
JSValue socket_pop_callback(LWSSocket* s, JSContext** pctx);
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
