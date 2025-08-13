#include "lws-socket.h"
#include "lws-context.h"
#include "lws.h"
#include "js-utils.h"
#include <assert.h>

JSClassID lwsjs_sockaddr46_class_id;
static JSValue lwsjs_sockaddr46_proto, lwsjs_sockaddr46_ctor;

enum {
  PROP_FAMILY = 0,
  PROP_ADDRESS,
};

static JSValue
lwsjs_sockaddr46_constructor(JSContext* ctx, JSValueConst new_target, int argc, JSValueConst argv[]) {
  lws_sockaddr46 sa = {};
  JSValue obj = JS_NewArrayBufferCopy(ctx, (uint8_t*)&sa, sizeof(sa));

  if(JS_IsException(obj))
    goto fail;

  /* using new_target to get the prototype is necessary when the class is extended. */
  JSValue proto = JS_GetPropertyStr(ctx, new_target, "prototype");
  if(JS_IsException(proto))
    proto = JS_DupValue(ctx, lwsjs_sockaddr46_proto);

  JS_SetPrototype(ctx, obj, proto);

  JS_FreeValue(ctx, proto);

  return obj;

fail:
  JS_FreeValue(ctx, obj);
  return JS_EXCEPTION;
}

static JSValue
lwsjs_sockaddr46_get(JSContext* ctx, JSValueConst this_val, int magic) {
  size_t len;
  lws_sockaddr46* sa;
  JSValue ret = JS_UNDEFINED;

  if(!(sa = (lws_sockaddr46*)JS_GetArrayBuffer(ctx, &len, this_val)))
    return JS_EXCEPTION;

  if(len < sizeof(*sa))
    return JS_ThrowRangeError(ctx, "SockAddr64 must have legnth %zu", sizeof(*sa));

  switch(magic) {
    case PROP_FAMILY: {
      ret = JS_NewInt32(ctx, sa->sa4.sa_family);
      break;
    }
    case PROP_ADDRESS: {
      switch(sa->sa4.sa_family) {
        case AF_INET: {
          ret = JS_NewArrayBufferCopy(ctx, (uint8_t*)&sa->sa4.sin_addr, sizeof(sa->sa4.sin_addr));
          break;
        }
        case AF_INET6: {
          ret = JS_NewArrayBufferCopy(ctx, (uint8_t*)&sa->sa6.sin6_addr, sizeof(sa->sa6.sin6_addr));
          break;
        }
        default: break;
      }
      break;
    }
  }

  return ret;
}

static void
lwsjs_sockaddr46_finalizer(JSRuntime* rt, JSValue val) {
  LWSSocket* s;

  if((s = lwsjs_sockaddr46_data(val)))
    socket_free(s, rt);
}

static const JSClassDef lws_sockaddr46_class = {
    "LWSSocket",
    .finalizer = lwsjs_sockaddr46_finalizer,
};

static const JSCFunctionListEntry lws_sockaddr46_proto_funcs[] = {
    JS_CGETSET_MAGIC_FLAGS_DEF("family", lwsjs_sockaddr46_get, 0, PROP_FAMILY, JS_PROP_ENUMERABLE),
    JS_CGETSET_MAGIC_FLAGS_DEF("address", lwsjs_sockaddr46_get, 0, PROP_ADDRESS, JS_PROP_ENUMERABLE),

    JS_PROP_STRING_DEF("[Symbol.toStringTag]", "LWSSockAddr46", JS_PROP_CONFIGURABLE),
};

int
lwsjs_sockaddr46_init(JSContext* ctx, JSModuleDef* m) {
  init_list_head(&socket_list);

  JS_NewClassID(&lwsjs_sockaddr46_class_id);
  JS_NewClass(JS_GetRuntime(ctx), lwsjs_sockaddr46_class_id, &lws_sockaddr46_class);
  lwsjs_sockaddr46_proto = JS_NewObjectProto(ctx, JS_NULL);
  JS_SetPropertyFunctionList(ctx, lwsjs_sockaddr46_proto, lws_sockaddr46_proto_funcs, countof(lws_sockaddr46_proto_funcs));

  lwsjs_sockaddr46_ctor = JS_NewObjectProto(ctx, JS_NULL);
  JS_SetPropertyFunctionList(ctx, lwsjs_sockaddr46_ctor, lws_sockaddr46_static_funcs, countof(lws_sockaddr46_static_funcs));
  JS_SetConstructor(ctx, lwsjs_sockaddr46_ctor, lwsjs_sockaddr46_proto);

  if(m) {
    JS_SetModuleExport(ctx, m, "LWSSockAddr46", lwsjs_sockaddr46_ctor);
  }

  return 0;
}
