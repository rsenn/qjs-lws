#include "lws.h"
#include <assert.h>

JSClassID lws_spa_class_id;
static JSValue lws_spa_proto, lws_spa_ctor;


typedef struct {
JSContext*ctx;
JSValue this_obj;
union {
JSValue oncontent,onfinalcontent,onopen,onclose;
JSValue array[4];
};
} SPACallbacks;

typedef struct {
 struct lws_spa *spa;
 SPACallbacks callbacks;
} LWSSPA;


static JSValue
lws_spa_constructor(JSContext* ctx, JSValueConst new_target, int argc, JSValueConst argv[]) {
  JSValue proto, obj;
   LWSSPA*spa;

  if(!(spa = js_mallocz(ctx, sizeof(LWSSPA))))
    return JS_EXCEPTION;
 
  spa->callbacks.=ctx;
  spa->callbacks.array=(JSValue[4]){ JS_NULL, JS_NULL,JS_NULL,JS_NULL };

  /* using new_target to get the prototype is necessary when the class is extended. */
  proto = JS_GetPropertyStr(ctx, new_target, "prototype");
  if(JS_IsException(proto))
    proto = JS_DupValue(ctx, lws_spa_proto);

  obj = JS_NewObjectProtoClass(ctx, proto, lws_spa_class_id);
  JS_FreeValue(ctx, proto);
  if(JS_IsException(obj))
    goto fail;

  
  spa->callbacks.this_obj=obj;

  JS_SetOpaque(obj, spa);

  return obj;

fail:
  js_free(ctx, spa);
  JS_FreeValue(ctx, obj);
  return JS_EXCEPTION;
}


enum {

};

static JSValue
lws_spa_methods(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[], int magic) {
  LWSSPA* s;
  JSValue ret = JS_UNDEFINED;

  if(!(s = JS_GetOpaque2(ctx, this_val, lws_spa_class_id)))
    return JS_EXCEPTION;

  switch(magic) {
    
  }

  return ret;
}

enum {
  
};

static JSValue
lws_spa_functions(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[], int magic) {
  LWSSPA* s;
  JSValue ret = JS_UNDEFINED;

  switch(magic) {
   
  }

  return ret;
}

enum {

};

static JSValue
lws_spa_get(JSContext* ctx, JSValueConst this_val, int magic) {
  LWSSPA* s;
  JSValue ret = JS_UNDEFINED;

  if(!(s = JS_GetOpaque2(ctx, this_val, lws_spa_class_id)))
    return JS_EXCEPTION;

  switch(magic) {
      }

  return ret;
}

static void
lws_spa_finalizer(JSRuntime* rt, JSValue val) {
  LWSSPA* spa;

  if((spa = JS_GetOpaque(val, lws_spa_class_id))) {



    js_free_rt(rt, spa);
  }
}

static const JSClassDef lws_spa_class = {
    "LWSSPA",
    .finalizer = lws_spa_finalizer,
};

static const JSCFunctionListEntry lws_spa_proto_funcs[] = {
     JS_PROP_STRING_DEF("[Symbol.toStringTag]", "LWSSPA", JS_PROP_CONFIGURABLE),
};
 
int
lws_spa_init(JSContext* ctx, JSModuleDef* m) {
  JS_NewClassID(&lws_spa_class_id);
  JS_NewClass(JS_GetRuntime(ctx), lws_spa_class_id, &lws_spa_class);
  lws_spa_proto = JS_NewObjectProto(ctx, JS_NULL);
  JS_SetPropertyFunctionList(ctx, lws_spa_proto, lws_spa_proto_funcs, countof(lws_spa_proto_funcs));

  lws_spa_ctor = JS_NewObjectProto(ctx, JS_NULL);
   JS_SetConstructor(ctx, lws_spa_ctor, lws_spa_proto);

  if(m) {
    JS_SetModuleExport(ctx, m, "LWSSPA", lws_spa_ctor);
  }

  return 0;
}
