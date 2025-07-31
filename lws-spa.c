#include "lws.h"
#include "lws-socket.h"
#include <cutils.h>
#include <libwebsockets.h>
#include <assert.h>

JSClassID lwsjs_spa_class_id;
static JSValue lwsjs_spa_proto, lwsjs_spa_ctor;

typedef struct {
  struct {
    JSValue content, finalcontent, open, close;
  } on;
  JSContext* ctx;
  JSValue this_obj;
} SPACallbacks;

typedef struct {
  struct lws_spa* spa;
  SPACallbacks callbacks;
  JSValue name, filename;
  struct lws_spa_create_info info;
} LWSSPA;

static const char* const lws_spa_callback_names[] = {
    "onContent",
    "onFinalContent",
    "onOpen",
    "onClose",
};

static inline LWSSPA*
lwsjs_spa_data2(JSContext* ctx, JSValueConst value) {
  return JS_GetOpaque2(ctx, value, lwsjs_spa_class_id);
}

static int
lwsjs_spa_callback(void* data, const char* name, const char* filename, char* buf, int len, enum lws_spa_fileupload_states state) {
  LWSSPA* s = data;
  SPACallbacks* cb = &s->callbacks;

  if(state == LWS_UFS_OPEN) {
    JS_FreeValue(cb->ctx, s->name);
    s->name = JS_NewString(cb->ctx, name);

    JS_FreeValue(cb->ctx, s->filename);
    s->filename = JS_NewString(cb->ctx, filename);
  }

  JSValue args[] = {
      s->name,
      s->filename,
      (buf && len) ? JS_NewArrayBufferCopy(cb->ctx, (const uint8_t*)buf, len) : JS_NULL,
  };

  JSValue* fn = &((JSValue*)cb)[state - LWS_UFS_CONTENT];
  JSValue result = JS_Call(cb->ctx, *fn, cb->this_obj, (buf && len) ? 3 : 2, args);

  int32_t ret = JS_IsException(result) ? -1 : to_int32(cb->ctx, result);

  JS_FreeValue(cb->ctx, result);
  JS_FreeValue(cb->ctx, args[2]);

  if(state == LWS_UFS_CLOSE) {
    JS_FreeValue(cb->ctx, s->name);
    s->name = JS_NULL;

    JS_FreeValue(cb->ctx, s->filename);
    s->filename = JS_NULL;
  }

  return ret;
}

static JSValue
lwsjs_spa_constructor(JSContext* ctx, JSValueConst new_target, int argc, JSValueConst argv[]) {
  LWSSPA* s;
  LWSSocket* sock;

  if(!(sock = lwsjs_socket_data(argv[0])))
    return JS_ThrowTypeError(ctx, "argument 1 must be an LWSSocket");

  if(!(s = js_mallocz(ctx, sizeof(LWSSPA))))
    return JS_EXCEPTION;

  /* using new_target to get the prototype is necessary when the class is extended. */
  JSValue proto = JS_GetPropertyStr(ctx, new_target, "prototype");
  if(JS_IsException(proto))
    proto = JS_DupValue(ctx, lwsjs_spa_proto);

  JSValue obj = JS_NewObjectProtoClass(ctx, proto, lwsjs_spa_class_id);
  JS_FreeValue(ctx, proto);
  if(JS_IsException(obj))
    goto fail;

  JSValue this_val = argc > 1 && JS_IsObject(argv[1]) ? JS_DupValue(ctx, argv[1]) : JS_UNDEFINED;

  s->callbacks = (SPACallbacks){
      .on =
          {
              .content = JS_NULL,
              .finalcontent = JS_NULL,
              .open = JS_NULL,
              .close = JS_NULL,
          },
      .ctx = ctx,
      .this_obj = this_val,
  };

  if(!JS_IsUndefined(this_val))
    for(size_t i = 0; i < countof(lws_spa_callback_names); ++i)
      ((JSValue*)&s->callbacks)[i] = JS_GetPropertyStr(ctx, this_val, lws_spa_callback_names[i]);

  if(!JS_IsFunction(ctx, s->callbacks.on.finalcontent) && JS_IsFunction(ctx, s->callbacks.on.content))
    s->callbacks.on.finalcontent = JS_DupValue(ctx, s->callbacks.on.content);

  uint32_t count_params = to_uint32free_default(ctx, lwsjs_get_property(ctx, this_val, "count_params"), 1024);
  uint32_t storage = to_uint32free_default(ctx, lwsjs_get_property(ctx, this_val, "max_storage"), 512);

  s->info = (struct lws_spa_create_info){
      .param_names = count_params ? js_mallocz(ctx, sizeof(char*) * (count_params + 1)) : 0,
      .count_params = count_params,
      .max_storage = storage + 1,
      .opt_cb = &lwsjs_spa_callback,
      .opt_data = s,
      .ac_chunk_size = to_uint32free(ctx, lwsjs_get_property(ctx, this_val, "ac_chunk_size")),
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

  if(!(s = lwsjs_spa_data2(ctx, this_val)))
    return JS_EXCEPTION;

  switch(magic) {
    case METHOD_PROCESS: {
      size_t n;
      uint8_t* p;

      if(!(p = get_buffer(ctx, argc, argv, &n)))
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

  if(prop > JS_ATOM_MAX_INT) {
    LWSSPA* s;
    const char* str;

    if(!(s = lwsjs_spa_data2(ctx, this_val)))
      return JS_EXCEPTION;

    if((str = lws_spa_get_string(s->spa, prop & JS_ATOM_MAX_INT)))
      value = JS_NewStringLen(ctx, str, lws_spa_get_length(s->spa, prop & JS_ATOM_MAX_INT));
  } else {
    JSValue proto = JS_GetPrototype(ctx, this_val);

    if(!JS_IsObject(proto))
      proto = JS_DupValue(ctx, lwsjs_spa_proto);

    value = JS_GetProperty(ctx, proto, prop);

    JS_FreeValue(ctx, proto);
  }

  return value;
}

static void
lwsjs_spa_finalizer(JSRuntime* rt, JSValue val) {
  LWSSPA* s;

  if((s = JS_GetOpaque(val, lwsjs_spa_class_id))) {

    for(size_t i = 0; i < (sizeof(s->callbacks.on) / sizeof(JSValue)); i++)
      JS_FreeValueRT(rt, ((JSValue*)&s->callbacks)[i]);

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
  JS_NewClassID(&lwsjs_spa_class_id);
  JS_NewClass(JS_GetRuntime(ctx), lwsjs_spa_class_id, &lws_spa_class);

  lwsjs_spa_proto = JS_NewObjectProto(ctx, JS_NULL);

  JS_SetPropertyFunctionList(ctx, lwsjs_spa_proto, lws_spa_proto_funcs, countof(lws_spa_proto_funcs));

  lwsjs_spa_ctor = JS_NewCFunction2(ctx, lwsjs_spa_constructor, "LWSSPA", 1, JS_CFUNC_constructor, 0);
  JS_SetConstructor(ctx, lwsjs_spa_ctor, lwsjs_spa_proto);

  if(m) {
    JS_SetModuleExport(ctx, m, "LWSSPA", lwsjs_spa_ctor);
  }

  return 0;
}
