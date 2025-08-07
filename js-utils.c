#include "js-utils.h"
#include <string.h>
#define MAX(a, b) ((a) > (b) ? (a) : (b))
#define MIN(a, b) ((a) < (b) ? (a) : (b))
#define WRAPAROUND(n, len) ((n) < 0 ? (n) + (len) : (n))

JSValue
js_function_prototype(JSContext* ctx) {
  JSValue ret, fn = JS_NewCFunction(ctx, 0, "", 0);
  ret = JS_GetPrototype(ctx, fn);

  JS_FreeValue(ctx, fn);

  return ret;
}

JSValue
ptr_obj(JSContext* ctx, JSObject* obj) {
  return JS_DupValue(ctx, JS_MKPTR(JS_TAG_OBJECT, obj));
}

JSValue
js_iterator_next(JSContext* ctx, JSValueConst obj, BOOL* done_p) {
  JSValue fn = JS_GetPropertyStr(ctx, obj, "next");
  JSValue result = JS_Call(ctx, fn, obj, 0, 0);
  JS_FreeValue(ctx, fn);
  *done_p = to_boolfree(ctx, JS_GetPropertyStr(ctx, result, "done"));
  JSValue value = JS_GetPropertyStr(ctx, result, "value");
  JS_FreeValue(ctx, result);
  return value;
}

JSValue*
to_valuearray(JSContext* ctx, JSValueConst obj, size_t* lenp) {
  JSValue iterator = iterator_get(ctx, obj);

  if(JS_IsException(iterator)) {
    JS_GetException(ctx);
    return 0;
  }

  JSValue tmp = JS_Call(ctx, iterator, obj, 0, NULL);
  JS_FreeValue(ctx, iterator);
  iterator = tmp;

  BOOL done = FALSE;
  JSValue* ret = NULL;
  uint32_t i;

  for(i = 0;; ++i) {
    JSValue value = js_iterator_next(ctx, iterator, &done);

    if(done || !(ret = js_realloc(ctx, ret, (i + 1) * sizeof(JSValue)))) {
      JS_FreeValue(ctx, value);
      break;
    }

    ret[i] = value;
  }

  *lenp = i;

  return ret;
}

char**
to_stringarray(JSContext* ctx, JSValueConst obj) {
  JSValue iterator = iterator_get(ctx, obj);

  if(JS_IsException(iterator)) {
    JS_GetException(ctx);
    return 0;
  }

  JSValue tmp = JS_Call(ctx, iterator, obj, 0, NULL);
  JS_FreeValue(ctx, iterator);
  iterator = tmp;

  BOOL done = FALSE;
  char** ret = 0;
  uint32_t i;

  for(i = 0;; ++i) {
    JSValue value = js_iterator_next(ctx, iterator, &done);

    if(done || !(ret = js_realloc(ctx, ret, (i + 2) * sizeof(char*)))) {
      JS_FreeValue(ctx, value);
      break;
    }

    ret[i] = to_stringfree(ctx, value);
    ret[i + 1] = 0;
  }

  return ret;
}
BOOL
js_has_property(JSContext* ctx, JSValueConst obj, const char* name) {
  JSAtom atom = JS_NewAtom(ctx, name);
  BOOL ret = JS_HasProperty(ctx, obj, atom);
  JS_FreeAtom(ctx, atom);

  /*if(!ret) {
    char buf[strlen(name) + 1];

    camelize(buf, sizeof(buf), name);

    if(strcmp(name, buf)) {
      atom = JS_NewAtom(ctx, buf);
      ret = JS_HasProperty(ctx, obj, atom);
      JS_FreeAtom(ctx, atom);
    }
  }*/

  return ret;
}

BOOL
js_has_property2(JSContext* ctx, JSValueConst obj, const char* name) {

  if(!js_has_property(ctx, obj, name)) {
    char buf[strlen(name) + 1];

    camelize(buf, sizeof(buf), name);

    return js_has_property(ctx, obj, buf);
  }

  return TRUE;
}

JSValue
js_get_property(JSContext* ctx, JSValueConst obj, const char* name) {
  if(!js_has_property(ctx, obj, name)) {
    char buf[strlen(name) + 1];

    camelize(buf, sizeof(buf), name);

    return JS_GetPropertyStr(ctx, obj, buf);
  }

  return JS_GetPropertyStr(ctx, obj, name);
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

void
js_error_print(JSContext* ctx, JSValueConst exception) {
  JSValue stack;
  const char* str;
  stack = JS_GetPropertyStr(ctx, exception, "stack");

  if((str = JS_ToCString(ctx, exception))) {
    fprintf(stderr, "\x1b[2K\rERROR: %s\n", str);
    JS_FreeCString(ctx, str);
  }

  if((str = JS_ToCString(ctx, stack))) {
    fprintf(stderr, "STACK: %s\n", str);
    JS_FreeCString(ctx, str);
  }
}
