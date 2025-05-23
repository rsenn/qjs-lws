#ifndef QJS_LWS_CONTEXT_H
#define QJS_LWS_CONTEXT_H

#include <quickjs.h>
#include <cutils.h>
#include <list.h>
#include <libwebsockets.h>

typedef struct {
  struct lws_context* ctx;
  struct lws_context_creation_info info;
} LWSContext;

typedef struct {
  JSContext* ctx;
  JSObject* obj;
  JSValue callback;
  JSValue callbacks[LWS_CALLBACK_MQTT_SHADOW_TIMEOUT + 1];
} LWSProtocol;

extern JSClassID lws_context_class_id;

int lws_context_init(JSContext*, JSModuleDef*);

#endif
