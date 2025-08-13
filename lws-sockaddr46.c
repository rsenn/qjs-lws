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

static inline LWSSocket*
lwsjs_sockaddr46_data(JSValueConst value) {
  return JS_GetOpaque(value, lwsjs_sockaddr46_class_id);
}

static inline LWSSocket*
lwsjs_sockaddr46_data2(JSContext* ctx, JSValueConst value) {
  return JS_GetOpaque2(ctx, value, lwsjs_sockaddr46_class_id);
}

static JSValue
lwsjs_sockaddr46_constructor(JSContext* ctx, JSValueConst new_target, int argc, JSValueConst argv[]) {
  lws_sockaddr46 sa = {0};
  uint8_t* p;
  size_t len;

  if((p = get_buffer(ctx, argc, argv, &len))) {
    if(len == 4) {
      sa.sa4.sin_family = AF_INET;
      memcpy(&sa.sa4.sin_addr, p, len);
    } else if(len == 16) {
      sa.sa6.sin6_family = AF_INET6;
      memcpy(&sa.sa6.sin6_addr, p, len);
    } else
      memcpy(&sa, p, MIN(len, sizeof(sa)));
  }

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
      ret = JS_NewInt32(ctx, sa->sa4.sin_family);
      break;
    }
    case PROP_ADDRESS: {
      switch(sa->sa4.sin_family) {
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

static const JSClassDef lws_sockaddr46_class = {"LWSSocket"};

static const JSCFunctionListEntry lws_sockaddr46_proto_funcs[] = {
    JS_CGETSET_MAGIC_FLAGS_DEF("family", lwsjs_sockaddr46_get, 0, PROP_FAMILY, JS_PROP_ENUMERABLE),
    JS_CGETSET_MAGIC_FLAGS_DEF("address", lwsjs_sockaddr46_get, 0, PROP_ADDRESS, JS_PROP_ENUMERABLE),

    JS_PROP_STRING_DEF("[Symbol.toStringTag]", "LWSSockAddr46", JS_PROP_CONFIGURABLE),
};

int
lwsjs_sockaddr46_init(JSContext* ctx, JSModuleDef* m) {
  JS_NewClassID(&lwsjs_sockaddr46_class_id);
  JS_NewClass(JS_GetRuntime(ctx), lwsjs_sockaddr46_class_id, &lws_sockaddr46_class);
  lwsjs_sockaddr46_proto = JS_NewObjectProto(ctx, JS_NULL);
  JS_SetPropertyFunctionList(ctx, lwsjs_sockaddr46_proto, lws_sockaddr46_proto_funcs, countof(lws_sockaddr46_proto_funcs));

  lwsjs_sockaddr46_ctor = JS_NewCFunction2(ctx, lwsjs_sockaddr46_constructor, "LWSSockAddr46", 0, JS_CFUNC_constructor, 0);
  JS_SetConstructor(ctx, lwsjs_sockaddr46_ctor, lwsjs_sockaddr46_proto);

  if(m) {
    JS_SetModuleExport(ctx, m, "LWSSockAddr46", lwsjs_sockaddr46_ctor);
  }

  return 0;
}
