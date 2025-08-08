#include "lws.h"
#include "js-utils.h"
#include <ctype.h>
#include <string.h>

JSValue
js_function_prototype(JSContext* ctx) {
  JSValue ret, fn = JS_NewCFunction(ctx, 0, "", 0);
  ret = JS_GetPrototype(ctx, fn);

  JS_FreeValue(ctx, fn);

  return ret;
}

JSValue
js_iterator_get(JSContext* ctx, JSValueConst iterable) {
  JSValue symbol = global_get(ctx, "Symbol");
  JSValue symiter = JS_GetPropertyStr(ctx, symbol, "iterator");
  JS_FreeValue(ctx, symbol);
  JSAtom atom = JS_ValueToAtom(ctx, symiter);
  JS_FreeValue(ctx, symiter);
  JSValue ret = JS_GetProperty(ctx, iterable, atom);
  JS_FreeAtom(ctx, atom);
  return ret;
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

BOOL
js_has_property(JSContext* ctx, JSValueConst obj, const char* name) {
  JSAtom atom = JS_NewAtom(ctx, name);
  BOOL ret = JS_HasProperty(ctx, obj, atom);
  JS_FreeAtom(ctx, atom);
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

void
js_error_print(JSContext* ctx, JSValueConst exception) {
  JSValue stack = JS_GetPropertyStr(ctx, exception, "stack");
  const char* str;

  if((str = JS_ToCString(ctx, exception))) {
    fprintf(stderr, "\x1b[2K\rERROR: %s\n", str);
    JS_FreeCString(ctx, str);
  }

  if((str = JS_ToCString(ctx, stack))) {
    fprintf(stderr, "STACK: %s\n", str);
    JS_FreeCString(ctx, str);
  }

  JS_FreeValue(ctx, stack);
}

JSValue
js_fmt_pointer(JSContext* ctx, void* ptr, const char* str) {
  char buf[64];
  snprintf(buf, sizeof(buf), "%s%p", str ? str : "", ptr);
  return JS_NewString(ctx, buf);
}

JSValue*
to_valuearray(JSContext* ctx, JSValueConst obj, size_t* lenp) {
  JSValue iterator = js_iterator_get(ctx, obj);

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
  JSValue iterator = js_iterator_get(ctx, obj);

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

void
str_or_buf_property(const char** pptr, const void** mptr, unsigned int* mlen, JSContext* ctx, JSValueConst obj, const char* name) {

  if(js_has_property2(ctx, obj, name)) {
    JSValue value = js_get_property(ctx, obj, name);
    size_t len;
    uint8_t* buf;

    if((buf = JS_GetArrayBuffer(ctx, &len, value))) {
      *pptr = 0;

      if((*mptr = js_malloc(ctx, len))) {
        *mlen = len;

        memcpy((void*)*mptr, buf, len);
      }
    } else {
      *mptr = 0;

      str_replace(ctx, pptr, to_stringfree(ctx, value));
    }
  }
}

size_t
get_offset_length(JSContext* ctx, int argc, JSValueConst argv[], size_t maxlen, size_t* lenp) {
  int64_t ofs = 0, len = maxlen;

  if(argc > 0) {
    if((ofs = to_int64(ctx, argv[0])) < 0)
      ofs = WRAPAROUND(ofs, (int64_t)maxlen);
    ofs = MAX(0, MIN(ofs, (int64_t)maxlen));

    if(argc > 1)
      if((len = to_int64(ctx, argv[1])) < 0)
        len = WRAPAROUND(len, (int64_t)maxlen);
  }

  maxlen -= ofs;
  *lenp = MAX(0, MIN(len, (int64_t)maxlen));

  return ofs;
}

void*
get_buffer(JSContext* ctx, int argc, JSValueConst argv[], size_t* lenp) {
  size_t maxlen;
  uint8_t* ptr;

  if((ptr = JS_GetArrayBuffer(ctx, &maxlen, argv[0]))) {
    size_t ofs = 0, len = maxlen;

    if(argc > 1)
      ofs = get_offset_length(ctx, argc - 1, argv + 1, maxlen, &len);

    *lenp = len;
    ptr += ofs;
  }

  return ptr;
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

  if(js_cclosure_class_id == 0) {
    JS_NewClassID(&js_cclosure_class_id);
    JS_NewClass(JS_GetRuntime(ctx), js_cclosure_class_id, &js_cclosure_class);
  }

  JSValue func_proto = js_function_prototype(ctx);
  JSValue func_obj = JS_NewObjectProtoClass(ctx, func_proto, js_cclosure_class_id);

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

  return func_obj;
}
