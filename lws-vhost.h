#ifndef QJS_LWS_VHOST_H
#define QJS_LWS_VHOST_H

#include "lws-context.h"

typedef struct {
  struct lws_vhost* vho;
  struct lws_context_creation_info info;
} LWSVhost;

extern JSClassID lwsjs_vhost_class_id;

int lwsjs_vhost_init(JSContext*, JSModuleDef*);
JSValue lws_vhost_object(JSContext*, struct lws_vhost*);

static inline LWSVhost*
lwsjs_vhost_data(JSValueConst value) {
  return JS_GetOpaque(value, lwsjs_vhost_class_id);
}

static inline LWSVhost*
lwsjs_vhost_data2(JSContext* ctx, JSValueConst value) {
  return JS_GetOpaque2(ctx, value, lwsjs_vhost_class_id);
}

static inline struct lws_vhost*
lws_vhost_data(JSValueConst value) {
  LWSVhost* lws;

  if((lws = lwsjs_vhost_data(value)))
    return lws->vho;

  return 0;
}
#endif
