#include "lws-vhost-option.h"

struct lws_protocol_vhost_options*
lwsjs_vhost_option_from(JSContext* ctx, JSValueConst obj) {
  struct lws_protocol_vhost_options* vho;
  JSValue name = JS_UNDEFINED, value = JS_UNDEFINED, options = JS_UNDEFINED, next = JS_UNDEFINED;

  if(JS_IsArray(ctx, obj)) {
    name = JS_GetPropertyUint32(ctx, obj, 0);
    value = JS_GetPropertyUint32(ctx, obj, 1);
    options = JS_GetPropertyUint32(ctx, obj, 2);
  } else if(JS_IsObject(obj)) {
    name = JS_GetPropertyStr(ctx, obj, "name");
    value = JS_GetPropertyStr(ctx, obj, "value");
    options = JS_GetPropertyStr(ctx, obj, "options");

    if(js_has_property(ctx, obj, "next"))
      next = JS_GetPropertyStr(ctx, obj, "next");
  }

  if((vho = js_mallocz(ctx, sizeof(struct lws_protocol_vhost_options)))) {
    vho->name = to_string(ctx, name);
    vho->value = to_string(ctx, value);
    vho->options = lwsjs_vhost_options_from(ctx, options);
    vho->next = JS_IsObject(next) ? lwsjs_vhost_option_from(ctx, next) : NULL;
  }

  JS_FreeValue(ctx, name);
  JS_FreeValue(ctx, value);
  JS_FreeValue(ctx, options);
  JS_FreeValue(ctx, next);
  return vho;
}

struct lws_protocol_vhost_options*
lwsjs_vhost_options_from(JSContext* ctx, JSValueConst value) {
  struct lws_protocol_vhost_options *vho = 0, **ptr = &vho, *tmp;
  JSValue first = JS_UNDEFINED;

  if(JS_IsArray(ctx, value) && ((first = JS_GetPropertyUint32(ctx, value, 0)), JS_IsObject(first))) {
    int32_t len = to_int32free(ctx, JS_GetPropertyStr(ctx, value, "length"));

    if(len > 0) {
      for(int32_t i = 0; i < len; i++) {
        JSValue option = JS_GetPropertyUint32(ctx, value, i);

        if((*ptr = tmp = lwsjs_vhost_option_from(ctx, option)))
          do
            ptr = (struct lws_protocol_vhost_options**)&(*ptr)->next;
          while(*ptr);

        JS_FreeValue(ctx, option);

        if(!tmp)
          break;
      }
    }
  } else if(JS_IsObject(value)) {
    vho = lwsjs_vhost_option_from(ctx, value);
  }

  JS_FreeValue(ctx, first);

  return vho;
}

struct lws_protocol_vhost_options*
lwsjs_vhost_options_fromfree(JSContext* ctx, JSValue value) {
  struct lws_protocol_vhost_options* vho = lwsjs_vhost_options_from(ctx, value);

  JS_FreeValue(ctx, value);
  return vho;
}

void
lwsjs_vhost_options_free(JSRuntime* rt, struct lws_protocol_vhost_options* vho) {
  do {
    js_free_rt(rt, (char*)vho->name);
    vho->name = 0;

    js_free_rt(rt, (char*)vho->value);
    vho->value = 0;

    lwsjs_vhost_options_free(rt, (struct lws_protocol_vhost_options*)vho->options);
    vho->options = 0;

  } while((vho = (struct lws_protocol_vhost_options*)vho->next));
}
