#include "lws.h"
#include "lws-socket.h"
#include <cutils.h>
#include <libwebsockets.h>
#include <assert.h>

JSClassID lws_spa_class_id;
static JSValue lws_spa_proto, lws_spa_ctor;

typedef struct {
  JSContext* ctx;
  JSValue this_obj;
  union {
    struct {
      JSValue oncontent, onfinalcontent, onopen, onclose;
    };
    JSValue array[4];
  };
  JSValue name, filename;
} SPACallbacks;

typedef struct {
  struct lws_spa* spa;
  struct lws_spa_create_info info;
  SPACallbacks callbacks;
} LWSSPA;

static const char* const lws_spa_callback_names[] = {
    "onContent",
    "onFinalContent",
    "onOpen",
    "onClose",
};

static int
lwsjs_spa_callback(void* data, const char* name, const char* filename, char* buf, int len, enum lws_spa_fileupload_states state) {
  SPACallbacks* cb = data;
  int32_t ret = 0;

  if(state == LWS_UFS_OPEN) {
    JS_FreeValue(cb->ctx, cb->name);
    cb->name = JS_NewString(cb->ctx, name);
    JS_FreeValue(cb->ctx, cb->filename);
    cb->filename = JS_NewString(cb->ctx, filename);
  }

  JSValue args[] = {
      cb->name,
      cb->filename,
      (buf && len) ? JS_NewArrayBufferCopy(cb->ctx, (const uint8_t*)buf, len) : JS_NULL,
  };

  JSValue fn = cb->array[state - LWS_UFS_CONTENT];
  JSValue result = JS_Call(cb->ctx, fn, cb->this_obj, (buf && len) ? 3 : 2, args);

  if(JS_IsException(result))
    ret = -1;
  else
    ret = to_int32(cb->ctx, result);

  JS_FreeValue(cb->ctx, args[2]);
  JS_FreeValue(cb->ctx, result);

  if(state == LWS_UFS_CLOSE) {
    JS_FreeValue(cb->ctx, cb->name);
    cb->name = JS_NULL;
    JS_FreeValue(cb->ctx, cb->filename);
    cb->filename = JS_NULL;
  }

  return ret;
}

static JSValue
lwsjs_spa_constructor(JSContext* ctx, JSValueConst new_target, int argc, JSValueConst argv[]) {
  JSValue proto, obj;
  LWSSPA* s;
  LWSSocket* sock;

  if(!(sock = JS_GetOpaque(argv[0], lws_socket_class_id)))
    return JS_ThrowTypeError(ctx, "argument 1 must be an LWSSocket");

  if(!(s = js_mallocz(ctx, sizeof(LWSSPA))))
    return JS_EXCEPTION;

  /* using new_target to get the prototype is necessary when the class is extended. */
  proto = JS_GetPropertyStr(ctx, new_target, "prototype");
  if(JS_IsException(proto))
    proto = JS_DupValue(ctx, lws_spa_proto);

  obj = JS_NewObjectProtoClass(ctx, proto, lws_spa_class_id);
  JS_FreeValue(ctx, proto);
  if(JS_IsException(obj))
    goto fail;

  s->callbacks = (SPACallbacks){
      .ctx = ctx,
      .this_obj = (argc > 1 && JS_IsObject(argv[1])) ? JS_DupValue(ctx, argv[1]) : JS_UNDEFINED,
      .oncontent = JS_NULL,
      .onfinalcontent = JS_NULL,
      .onopen = JS_NULL,
      .onclose = JS_NULL,
      .name = JS_NULL,
      .filename = JS_NULL,
  };

  if(argc > 1 && JS_IsObject(argv[1]))
    for(size_t i = 0; i < countof(lws_spa_callback_names); ++i)
      s->callbacks.array[i] = JS_GetPropertyStr(ctx, argv[1], lws_spa_callback_names[i]);

  if(is_null_or_undefined(s->callbacks.onfinalcontent) && !is_null_or_undefined(s->callbacks.oncontent))
    s->callbacks.onfinalcontent = JS_DupValue(ctx, s->callbacks.oncontent);

  s->info = (struct lws_spa_create_info){
      .param_names = js_mallocz(ctx, sizeof(char*) * 1024),
      .count_params = 0,
      .max_storage = 1024,
      .opt_cb = &lwsjs_spa_callback,
      .opt_data = &s->callbacks,
  };

  s->spa = lws_spa_create_via_info(sock->wsi, &s->info);

  JS_SetOpaque(obj, s);

  return obj;

fail:
  js_free(ctx, s);
  JS_FreeValue(ctx, obj);
  return JS_EXCEPTION;
}

enum {
  METHOD_PROCESS = 0,
  METHOD_FINALIZE,
};

static JSValue
lwsjs_spa_methods(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[], int magic) {
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

static JSValue
lwsjs_spa_get_property(JSContext* ctx, JSValueConst this_val, JSAtom prop, JSValueConst receiver) {
  JSValue value = JS_UNDEFINED;
  //  JSValue key = JS_AtomToValue(ctx, prop);

  if(prop > 0x7fffffff) {
    LWSSPA* s;

    if(!(s = JS_GetOpaque2(ctx, this_val, lws_spa_class_id)))
      return JS_EXCEPTION;

    int len = lws_spa_get_length(s->spa, prop & 0x7fffffff);
    const char* str = lws_spa_get_string(s->spa, prop & 0x7fffffff);

    if(str)
      value = JS_NewStringLen(ctx, str, len);
  } else {
    JSValue proto = JS_GetPrototype(ctx, this_val);

    if(!JS_IsObject(proto))
      proto = JS_DupValue(ctx, lws_spa_proto);

    value = JS_GetProperty(ctx, proto, prop);

    JS_FreeValue(ctx, proto);
  }

  return value;
}

static void
lwsjs_spa_finalizer(JSRuntime* rt, JSValue val) {
  LWSSPA* s;

  if((s = JS_GetOpaque(val, lws_spa_class_id))) {

    for(size_t i = 0; i < countof(s->callbacks.array); i++)
      JS_FreeValueRT(rt, s->callbacks.array[i]);

    JS_FreeValueRT(rt, s->callbacks.this_obj);

    if(s->info.param_names) {
      for(int i = 0; i < s->info.count_params; i++)
        if(s->info.param_names[i])
          js_free_rt(rt, (void*)s->info.param_names[i]);

      js_free_rt(rt, (void*)s->info.param_names);
    }

    if(s->spa)
      lws_spa_destroy(s->spa);

    js_free_rt(rt, s);
  }
}

static JSClassExoticMethods lws_spa_exotic_methods = {
    .get_property = lwsjs_spa_get_property,
};

static const JSClassDef lws_spa_class = {
    "LWSSPA",
    .finalizer = lwsjs_spa_finalizer,
    .exotic = &lws_spa_exotic_methods,
};

static const JSCFunctionListEntry lws_spa_proto_funcs[] = {
    JS_CFUNC_MAGIC_DEF("process", 1, lwsjs_spa_methods, METHOD_PROCESS),
    JS_CFUNC_MAGIC_DEF("finalize", 0, lwsjs_spa_methods, METHOD_FINALIZE),
    JS_PROP_STRING_DEF("[Symbol.toStringTag]", "LWSSPA", JS_PROP_CONFIGURABLE),
};

int
lwsjs_spa_init(JSContext* ctx, JSModuleDef* m) {
  JS_NewClassID(&lws_spa_class_id);
  JS_NewClass(JS_GetRuntime(ctx), lws_spa_class_id, &lws_spa_class);
  lws_spa_proto = JS_NewObjectProto(ctx, JS_NULL);
  JS_SetPropertyFunctionList(ctx, lws_spa_proto, lws_spa_proto_funcs, countof(lws_spa_proto_funcs));

  lws_spa_ctor = JS_NewCFunction2(ctx, lwsjs_spa_constructor, "LWSSPA", 1, JS_CFUNC_constructor, 0);
  JS_SetConstructor(ctx, lws_spa_ctor, lws_spa_proto);

  if(m) {
    JS_SetModuleExport(ctx, m, "LWSSPA", lws_spa_ctor);
  }

  return 0;
}
