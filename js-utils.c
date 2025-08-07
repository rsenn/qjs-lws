#include "js-utils.h"

JSValue
js_function_prototype(JSContext* ctx) {
  JSValue ret, fn = JS_NewCFunction(ctx, 0, "", 0);
  ret = JS_GetPrototype(ctx, fn);

  JS_FreeValue(ctx, fn);

  return ret;
}

typedef struct {
  CClosureFunc* func;
  uint16_t length, magic;
  void* opaque;
  void (*opaque_finalize)(void*);
} JSCClosureRecord;

static JSClassID js_cclosure_class_id;

static inline JSCClosureRecord*
js_cclosure_data(JSValueConst value) {
  return JS_GetOpaque(value, js_cclosure_class_id);
}

static inline JSCClosureRecord*
js_cclosure_data2(JSContext* ctx, JSValueConst value) {
  return JS_GetOpaque2(ctx, value, js_cclosure_class_id);
}

static JSValue
js_cclosure_call(JSContext* ctx, JSValueConst func_obj, JSValueConst this_val, int argc, JSValueConst argv[], int flags) {
  JSCClosureRecord* ccr;
  JSValueConst* arg_buf;
  int i;

  if(!(ccr = js_cclosure_data2(ctx, func_obj)))
    return JS_EXCEPTION;

  /* XXX: could add the function on the stack for debug */
  if(unlikely(argc < ccr->length)) {
    arg_buf = alloca(sizeof(arg_buf[0]) * ccr->length);

    for(i = 0; i < argc; i++)
      arg_buf[i] = argv[i];

    for(i = argc; i < ccr->length; i++)
      arg_buf[i] = JS_UNDEFINED;

  } else {
    arg_buf = argv;
  }

  return ccr->func(ctx, this_val, argc, arg_buf, ccr->magic, ccr->opaque);
}

static void
js_cclosure_finalizer(JSRuntime* rt, JSValue val) {
  JSCClosureRecord* ccr;

  if((ccr = js_cclosure_data(val))) {
    if(ccr->opaque_finalize)
      ccr->opaque_finalize(ccr->opaque);

    js_free_rt(rt, ccr);
  }
}

static JSClassDef js_cclosure_class = {
    .class_name = "JSCClosure",
    .finalizer = js_cclosure_finalizer,
    .call = js_cclosure_call,
};

JSValue
js_function_cclosure(JSContext* ctx, CClosureFunc* func, int length, int magic, void* opaque, void (*opaque_finalize)(void*)) {
  JSCClosureRecord* ccr;
  JSValue func_proto, func_obj;

  if(js_cclosure_class_id == 0) {
    JS_NewClassID(&js_cclosure_class_id);
    JS_NewClass(JS_GetRuntime(ctx), js_cclosure_class_id, &js_cclosure_class);
  }

  func_proto = js_function_prototype(ctx);
  func_obj = JS_NewObjectProtoClass(ctx, func_proto, js_cclosure_class_id);

  JS_FreeValue(ctx, func_proto);

  if(JS_IsException(func_obj))
    return func_obj;

  if(!(ccr = js_malloc(ctx, sizeof(JSCClosureRecord)))) {
    JS_FreeValue(ctx, func_obj);
    return JS_EXCEPTION;
  }

  ccr->func = func;
  ccr->length = length;
  ccr->magic = magic;
  ccr->opaque = opaque;
  ccr->opaque_finalize = opaque_finalize;

  JS_SetOpaque(func_obj, ccr);

  // JS_DefinePropertyValueStr(ctx, func_obj, "length", JS_NewUint32(ctx, length), JS_PROP_CONFIGURABLE);

  return func_obj;
}
