#ifndef QJS_LWS_CONTEXT_H
#define QJS_LWS_CONTEXT_H

#include <quickjs.h>
#include <cutils.h>
#include <list.h>
#include <libwebsockets.h>

typedef struct {
  struct lws_context* ctx;
  struct lws_context_creation_info info;
  JSContext* js;
} LWSContext;

typedef struct {
  JSContext* ctx;
  JSObject* obj;
  JSValue callback, callbacks[LWS_CALLBACK_MQTT_SHADOW_TIMEOUT + 1];
} LWSProtocol;

extern JSClassID lwsjs_context_class_id;

int lwsjs_context_init(JSContext*, JSModuleDef*);

static inline LWSContext*
lwsjs_context_data(JSValueConst value) {
  return JS_GetOpaque(value, lwsjs_context_class_id);
}

static inline LWSContext*
lwsjs_context_data2(JSContext* ctx, JSValueConst value) {
  return JS_GetOpaque2(ctx, value, lwsjs_context_class_id);
}

static inline struct lws_context*
lws_context_data(JSValueConst value) {
  LWSContext* lwsctx;

  if((lwsctx = lwsjs_context_data(value)))
    return lwsctx->ctx;

  return 0;
}

#endif
