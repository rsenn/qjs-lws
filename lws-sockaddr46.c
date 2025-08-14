#include "lws-socket.h"
#include "lws-context.h"
#include "lws.h"
#include "js-utils.h"
#include <assert.h>

JSClassID lwsjs_sockaddr46_class_id;
static JSValue lwsjs_sockaddr46_proto, lwsjs_sockaddr46_ctor;

static JSValue
lwsjs_sockaddr46_constructor(JSContext* ctx, JSValueConst new_target, int argc, JSValueConst argv[]) {
  lws_sockaddr46 sa = {0};
  int argi = 0;

  if(argc > argi && JS_IsNumber(argv[argi])) {
    sa.sa4.sin_family = to_uint32(ctx, argv[argi]);
    argi++;
  }

  if(argc > argi && JS_IsNumber(argv[argi])) {
    sa.sa4.sin_port = htons(to_uint32(ctx, argv[argi]));
    argi++;
  }

  if(argc > argi) {
    uint8_t* p;
    size_t len;
    const char* str;

    if((p = get_buffer(ctx, argc - argi, argv - argi, &len))) {
      if(len == 4 && (sa.sa4.sin_family == 0 || sa.sa4.sin_family == AF_INET)) {
        sa.sa4.sin_family = AF_INET;
        memcpy(&sa.sa4.sin_addr, p, len);
      } else if(len == 16 && (sa.sa6.sin6_family == 0 || sa.sa6.sin6_family == AF_INET6)) {
        sa.sa6.sin6_family = AF_INET6;
        memcpy(&sa.sa6.sin6_addr, p, len);
      } else if(argi == 0)
        memcpy(&sa, p, MIN(len, sizeof(sa)));
    } else if((str = JS_ToCString(ctx, argv[0]))) {
      lws_sa46_parse_numeric_address(str, &sa);
      JS_FreeCString(ctx, str);
    }
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

enum {
  METHOD_TO_STRING = 0,
  METHOD_COMPARE,
  METHOD_ON_NET,
};

static JSValue
lwsjs_sockaddr46_methods(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[], int magic) {
  size_t len;
  lws_sockaddr46* sa;
  JSValue ret = JS_UNDEFINED;

  if(!(sa = (lws_sockaddr46*)JS_GetArrayBuffer(ctx, &len, this_val)))
    return JS_EXCEPTION;

  if(len < sizeof(*sa))
    return JS_ThrowRangeError(ctx, "SockAddr64 must have length %zu", sizeof(*sa));

  switch(magic) {
    case METHOD_TO_STRING: {
      char buf[64];
      int r = 0;

      if(sa->sa6.sin6_family == AF_INET6 && sa->sa4.sin_port)
        buf[r++] = '[';

      r += lws_sa46_write_numeric_address(sa, &buf[r], sizeof(buf) - r);

      if(sa->sa4.sin_port) {
        if(sa->sa6.sin6_family == AF_INET6)
          buf[r++] = ']';

        r += snprintf(&buf[r], sizeof(buf) - r, ":%u", ntohs(sa->sa4.sin_port));
      }

      ret = JS_NewStringLen(ctx, buf, r);
      break;
    }

    case METHOD_COMPARE: {
      size_t len2;
      lws_sockaddr46* sa2;

      if(!(sa2 = (lws_sockaddr46*)JS_GetArrayBuffer(ctx, &len, argv[0])))
        return JS_EXCEPTION;

      if(len2 < sizeof(*sa2))
        return JS_ThrowRangeError(ctx, "SockAddr64 must have length %zu", sizeof(*sa));

      ret = JS_NewInt32(ctx, lws_sa46_compare_ads(sa, sa2));
      break;
    }

    case METHOD_ON_NET: {
      size_t len2;
      lws_sockaddr46* sa2;

      if(!(sa2 = (lws_sockaddr46*)JS_GetArrayBuffer(ctx, &len, argv[0])))
        return JS_EXCEPTION;

      if(len2 < sizeof(*sa2))
        return JS_ThrowRangeError(ctx, "SockAddr64 must have length %zu", sizeof(*sa));

      ret = JS_NewBool(ctx, !lws_sa46_on_net(sa, sa2, to_uint32(ctx, argv[1])));
      break;
    }
  }

  return ret;
}

enum {
  PROP_FAMILY = 0,
  PROP_PORT,
  PROP_ADDRESS,
  PROP_HOST,
};

static JSValue
lwsjs_sockaddr46_get(JSContext* ctx, JSValueConst this_val, int magic) {
  size_t len;
  lws_sockaddr46* sa;
  JSValue ret = JS_UNDEFINED;

  if(!(sa = (lws_sockaddr46*)JS_GetArrayBuffer(ctx, &len, this_val)))
    return JS_EXCEPTION;

  if(len < sizeof(*sa))
    return JS_ThrowRangeError(ctx, "SockAddr64 must have length %zu", sizeof(*sa));

  switch(magic) {
    case PROP_FAMILY: {
      ret = JS_NewInt32(ctx, sa->sa4.sin_family);
      break;
    }
    case PROP_PORT: {
      switch(sa->sa4.sin_family) {
        case AF_INET: ret = JS_NewUint32(ctx, ntohs(sa->sa4.sin_port)); break;
        case AF_INET6: ret = JS_NewUint32(ctx, ntohs(sa->sa6.sin6_port)); break;
      }
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
    case PROP_HOST: {
      char buf[64];
      int r = lws_sa46_write_numeric_address(sa, buf, sizeof(buf));

      ret = JS_NewStringLen(ctx, buf, r);
      break;
    }
  }

  return ret;
}

static JSValue
lwsjs_sockaddr46_set(JSContext* ctx, JSValueConst this_val, JSValueConst value, int magic) {
  size_t len;
  lws_sockaddr46* sa;
  JSValue ret = JS_UNDEFINED;

  if(!(sa = (lws_sockaddr46*)JS_GetArrayBuffer(ctx, &len, this_val)))
    return JS_EXCEPTION;

  if(len < sizeof(*sa))
    return JS_ThrowRangeError(ctx, "SockAddr64 must have length %zu", sizeof(*sa));

  switch(magic) {
    case PROP_PORT: {
      switch(sa->sa4.sin_family) {
        case AF_INET: sa->sa4.sin_port = htons(to_uint32(ctx, value)); break;
        case AF_INET6: sa->sa6.sin6_port = htons(to_uint32(ctx, value)); break;
      }
    }
    case PROP_ADDRESS: {
      uint8_t* p;
      size_t len;

      if((p = JS_GetArrayBuffer(ctx, &len, value))) {
        if(len == sizeof(sa->sa4.sin_addr)) {
          sa->sa4.sin_family = AF_INET;
          memcpy(&sa->sa4.sin_addr, p, len);
        } else if(len == sizeof(sa->sa6.sin6_addr)) {
          sa->sa6.sin6_family = AF_INET6;
          memcpy(&sa->sa6.sin6_addr, p, len);
        }
      }

      break;
    }
  }

  return ret;
}

static const JSClassDef lws_sockaddr46_class = {
    "LWSSocket",
};

static const JSCFunctionListEntry lws_sockaddr46_proto_funcs[] = {
    JS_CGETSET_MAGIC_FLAGS_DEF("family", lwsjs_sockaddr46_get, 0, PROP_FAMILY, JS_PROP_ENUMERABLE),
    JS_CGETSET_MAGIC_FLAGS_DEF("port", lwsjs_sockaddr46_get, lwsjs_sockaddr46_set, PROP_PORT, 0),
    JS_CGETSET_MAGIC_DEF("address", lwsjs_sockaddr46_get, lwsjs_sockaddr46_set, PROP_ADDRESS),
    JS_CGETSET_MAGIC_FLAGS_DEF("host", lwsjs_sockaddr46_get, lwsjs_sockaddr46_set, PROP_HOST, JS_PROP_ENUMERABLE),
    JS_CFUNC_MAGIC_DEF("toString", 0, lwsjs_sockaddr46_methods, METHOD_TO_STRING),
    JS_CFUNC_MAGIC_DEF("compare", 1, lwsjs_sockaddr46_methods, METHOD_COMPARE),
    JS_CFUNC_MAGIC_DEF("onNet", 2, lwsjs_sockaddr46_methods, METHOD_ON_NET),

    JS_PROP_STRING_DEF("[Symbol.toStringTag]", "LWSSockAddr46", JS_PROP_CONFIGURABLE),
};

static JSValue
js_arraybuffer_prototype(JSContext* ctx) {
  uint8_t buf[4];
  JSValue obj = JS_NewArrayBufferCopy(ctx, buf, sizeof(buf));
  JSValue proto = JS_GetPrototype(ctx, obj);
  JS_FreeValue(ctx, obj);
  return proto;
}

int
lwsjs_sockaddr46_init(JSContext* ctx, JSModuleDef* m) {
  JS_NewClassID(&lwsjs_sockaddr46_class_id);
  JS_NewClass(JS_GetRuntime(ctx), lwsjs_sockaddr46_class_id, &lws_sockaddr46_class);

  JSValue proto = js_arraybuffer_prototype(ctx);
  lwsjs_sockaddr46_proto = JS_NewObjectProto(ctx, proto);
  JS_FreeValue(ctx, proto);

  JS_SetPropertyFunctionList(ctx, lwsjs_sockaddr46_proto, lws_sockaddr46_proto_funcs, countof(lws_sockaddr46_proto_funcs));

  lwsjs_sockaddr46_ctor = JS_NewCFunction2(ctx, lwsjs_sockaddr46_constructor, "LWSSockAddr46", 0, JS_CFUNC_constructor, 0);
  JS_SetConstructor(ctx, lwsjs_sockaddr46_ctor, lwsjs_sockaddr46_proto);

  if(m) {
    JS_SetModuleExport(ctx, m, "LWSSockAddr46", lwsjs_sockaddr46_ctor);
  }

  return 0;
}

JSValue
lwsjs_sockaddr46_value(JSContext* ctx, JSValueConst value) {
  if(JS_IsInstanceOf(ctx, value, lwsjs_sockaddr46_ctor))
    return JS_DupValue(ctx, value);

  return lwsjs_sockaddr46_constructor(ctx, lwsjs_sockaddr46_ctor, 1, &value);
}

lws_sockaddr46*
lwsjs_sockaddr46_data(JSContext* ctx, JSValueConst value) {
  size_t len;
  lws_sockaddr46* sa;

  if(!JS_IsInstanceOf(ctx, value, lwsjs_sockaddr46_ctor))
    return 0;

  if((sa = (lws_sockaddr46*)JS_GetArrayBuffer(ctx, &len, value)) && len < sizeof(*sa)) {
    JS_ThrowRangeError(ctx, "SockAddr64 must have length %zu", sizeof(*sa));
    return 0;
  }

  return sa;
}

JSValue
lwsjs_sockaddr46_new(JSContext* ctx) {
  return lwsjs_sockaddr46_constructor(ctx, lwsjs_sockaddr46_ctor, 0, 0);
}
