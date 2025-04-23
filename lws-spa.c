#include "lws.h"
#include <cutils.h>
#include <libwebsockets.h>
#include <assert.h>

JSClassID lws_spa_class_id;
static JSValue lws_spa_proto, lws_spa_ctor;

typedef struct {
  JSContext* ctx;
  JSValue this_obj;
  union {
    JSValue oncontent, onfinalcontent, onopen, onclose;
    JSValue array[4];
  };
} SPACallbacks;

typedef struct {
  struct lws_spa* spa;
  SPACallbacks callbacks;
} LWSSPA;

static int
lws_spa_callback(void* data, const char* name, const char* filename, char* buf, int len, enum lws_spa_fileupload_states state) {
  SPACallbacks* cb = data;
  int ret = 0;

  return ret;
}

static JSValue
lws_spa_constructor(JSContext* ctx, JSValueConst new_target, int argc, JSValueConst argv[]) {
  JSValue proto, obj;
  LWSSPA* spa;

  if(!(spa = js_mallocz(ctx, sizeof(LWSSPA))))
    return JS_EXCEPTION;

  spa->callbacks.ctx = ctx;
  spa->callbacks.array[0] = JS_NULL;
  spa->callbacks.array[1] = JS_NULL;
  spa->callbacks.array[2] = JS_NULL;
  spa->callbacks.array[3] = JS_NULL;

  /* using new_target to get the prototype is necessary when the class is extended. */
  proto = JS_GetPropertyStr(ctx, new_target, "prototype");
  if(JS_IsException(proto))
    proto = JS_DupValue(ctx, lws_spa_proto);

  obj = JS_NewObjectProtoClass(ctx, proto, lws_spa_class_id);
  JS_FreeValue(ctx, proto);
  if(JS_IsException(obj))
    goto fail;

  spa->callbacks.this_obj = obj;

  JS_SetOpaque(obj, spa);

  return obj;

fail:
  js_free(ctx, spa);
  JS_FreeValue(ctx, obj);
  return JS_EXCEPTION;
}

enum {
  METHOD_PROCESS = 0,
  METHOD_FINALIZE,
};

static JSValue
lws_spa_methods(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[], int magic) {
  LWSSPA* s;
  JSValue ret = JS_UNDEFINED;

  if(!(s = JS_GetOpaque2(ctx, this_val, lws_spa_class_id)))
    return JS_EXCEPTION;

  switch(magic) {
    case METHOD_PROCESS: {
      size_t n;
      uint8_t* p;

      if(!(p = JS_GetArrayBuffer(ctx, &n, argv[0])))
        return JS_ThrowTypeError(ctx, "argument 1 must be ArrayBuffer");

      ret = JS_NewInt32(ctx, lws_spa_process(s->spa, (const char*)p, n));
      break;
    }

    case METHOD_FINALIZE: {
      ret = JS_NewInt32(ctx, lws_spa_finalize(s->spa));
      break;
    }
  }

  return ret;
}

static void
lws_spa_finalizer(JSRuntime* rt, JSValue val) {
  LWSSPA* s;

  if((s = JS_GetOpaque(val, lws_spa_class_id))) {

    for(size_t i = 0; i < countof(s->callbacks.array); i++)
      JS_FreeValueRT(rt, s->callbacks.array[i]);

    // JS_FreeValueRT(rt, s->callbacks.this_obj);

    lws_spa_destroy(s->spa);

    js_free_rt(rt, s);
  }
}

static const JSClassDef lws_spa_class = {
    "LWSSPA",
    .finalizer = lws_spa_finalizer,
};

static const JSCFunctionListEntry lws_spa_proto_funcs[] = {
    JS_CFUNC_MAGIC_DEF("process", 1, lws_spa_methods, METHOD_PROCESS),
    JS_CFUNC_MAGIC_DEF("finalize", 0, lws_spa_methods, METHOD_FINALIZE),
    JS_PROP_STRING_DEF("[Symbol.toStringTag]", "LWSSPA", JS_PROP_CONFIGURABLE),
};

int
lws_spa_init(JSContext* ctx, JSModuleDef* m) {
  JS_NewClassID(&lws_spa_class_id);
  JS_NewClass(JS_GetRuntime(ctx), lws_spa_class_id, &lws_spa_class);
  lws_spa_proto = JS_NewObjectProto(ctx, JS_NULL);
  JS_SetPropertyFunctionList(ctx, lws_spa_proto, lws_spa_proto_funcs, countof(lws_spa_proto_funcs));

  lws_spa_ctor = JS_NewCFunction2(ctx, lws_spa_constructor, "LWSSPA", 1, JS_CFUNC_constructor, 0);
  JS_SetConstructor(ctx, lws_spa_ctor, lws_spa_proto);

  if(m) {
    JS_SetModuleExport(ctx, m, "LWSSPA", lws_spa_ctor);
  }

  return 0;
}
