#include "lws.h"
#include "js-utils.h"
#ifdef HAVE_ALLOCA_H
#include <alloca.h>
#endif
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

/* Checks `name` (as given) first, falling back to its camelCase spelling
   if that's absent - option objects throughout this codebase are keyed in
   snake_case (matching the underlying lws struct field names) but JS
   callers commonly write camelCase, so this fallback needs to live in the
   one shared has-property primitive rather than in each individual call
   site (see BUGS: option-key-casing-silently-ignored - a handful of
   integer-typed properties bypassed js_has_property2()'s equivalent
   fallback by calling this function directly, so only the exact
   snake_case spelling worked for them). A no-op for names that are
   already camelCase or contain no underscores (camelize() returns them
   unchanged), so this doesn't change behavior for non-option callers. */
BOOL
js_has_property(JSContext* ctx, JSValueConst obj, const char* name) {
  JSAtom atom = JS_NewAtom(ctx, name);
  BOOL ret = JS_HasProperty(ctx, obj, atom);
  JS_FreeAtom(ctx, atom);

  if(!ret) {
    char buf[strlen(name) + 1];

    camelize(buf, sizeof(buf), name);

    if(strcmp(buf, name) != 0) {
      atom = JS_NewAtom(ctx, buf);
      ret = JS_HasProperty(ctx, obj, atom);
      JS_FreeAtom(ctx, atom);
    }
  }

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

/* Fetches the exact name's own value first, falling back to the
   camelCase spelling only if that came back `undefined` - deliberately
   NOT gated on js_has_property() (which, since it does its own
   snake_case<->camelCase fallback internally, would say "yes" for the
   exact name whenever *either* spelling is present, short-circuiting
   this function past the branch that actually fetches the camelCase
   value and leaving `local_port`-style snake_case-canonical properties
   set from their camelCase spelling reading back as undefined). */
JSValue
js_get_property(JSContext* ctx, JSValueConst obj, const char* name) {
  JSValue ret = JS_GetPropertyStr(ctx, obj, name);

  if(JS_IsUndefined(ret)) {
    char buf[strlen(name) + 1];

    camelize(buf, sizeof(buf), name);

    if(strcmp(buf, name) != 0) {
      JS_FreeValue(ctx, ret);
      ret = JS_GetPropertyStr(ctx, obj, buf);
    }
  }

  return ret;
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

JSValue
from_stringarray(JSContext* ctx, const char* const* strs) {
  uint32_t i;
  JSValue ret = JS_NewArray(ctx);

  for(i = 0; strs[i]; ++i)
    JS_SetPropertyUint32(ctx, ret, i, JS_NewString(ctx, strs[i]));

  return ret;
}

void
str_or_buf_property(const char** pptr, const void** mptr, unsigned int* mlen, JSContext* ctx, JSValueConst obj, const char* name) {
  if(js_has_property2(ctx, obj, name)) {
    JSValue value = js_get_property(ctx, obj, name);

    if(!JS_IsString(value) && JS_IsObject(value)) {
      size_t len;
      uint8_t* buf;

      if((buf = JS_GetArrayBuffer(ctx, &len, value))) {
        *pptr = 0;

        if((*mptr = js_malloc(ctx, len))) {
          *mlen = len;

          memcpy((void*)*mptr, buf, len);
        }

        return;
      }

      JS_GetException(ctx);
    }

    *mptr = 0;

    str_replace(ctx, pptr, to_stringfree(ctx, value));
  }
}

size_t
get_offset_length(JSContext* ctx, int argc, JSValueConst argv[], size_t maxlen, size_t* lenp) {
  int64_t ofs = 0, len = maxlen;

  if(argc > 0) {
    if((ofs = to_int64(ctx, argv[0])) < 0)
      ofs = WRAP(ofs, (int64_t)maxlen);

    if(argc > 1) {
      if((len = to_int64(ctx, argv[1])) < 0)
        len = WRAP(len, (int64_t)maxlen);
    }
  }

  ofs = CLAMP(ofs, 0, (int64_t)maxlen);
  maxlen -= ofs;
  *lenp = CLAMP(len, 0, (int64_t)maxlen);

  return ofs;
}

JSValue
get_typedarray_buffer(JSContext* ctx, JSValueConst value, size_t* p_offset, size_t* p_length) {
  size_t offset, bytes, bytes_per_element;
  JSValue buffer = JS_GetTypedArrayBuffer(ctx, value, &offset, &bytes, &bytes_per_element);
  int ret = 0;

  if(JS_IsException(buffer)) {
    /* JS_GetTypedArrayBuffer threw; discard the exception so the caller can
     * treat this as a silent "not a typed array" probe. */
    JS_FreeValue(ctx, JS_GetException(ctx));
    buffer = JS_DupValue(ctx, value);
    offset = 0;
    bytes = SIZE_MAX;
    bytes_per_element = 1;
  }

  if(p_offset)
    *p_offset = offset;

  if(p_length)
    *p_length = bytes;

  return buffer;
}

void*
get_buffer(JSContext* ctx, int argc, JSValueConst argv[], size_t* lenp) {
  size_t maxlen, offset = 0, bytes = SIZE_MAX;
  uint8_t* ptr;
  JSValue buffer = get_typedarray_buffer(ctx, argv[0], &offset, &bytes);

  if((ptr = JS_GetArrayBuffer(ctx, &maxlen, buffer))) {
    maxlen -= offset;
    bytes = MIN(maxlen, bytes);

    if(argc > 1) {
      size_t len = 0;
      size_t ofs = get_offset_length(ctx, argc - 1, argv + 1, maxlen, &len);

      offset += ofs;
      bytes = len;
    }

    if(lenp)
      *lenp = bytes;

    ptr += offset;
  } else {
    /* JS_GetArrayBuffer() throws when argv[0] isn't an ArrayBuffer, but
       returning NULL here is a normal, expected outcome for callers using
       this as a "try ArrayBuffer, else fall back" probe (e.g.
       LWSSockAddr46's constructor also accepting a numeric-address string).
       Callers that instead treat NULL as a hard error immediately throw
       their own, more specific exception, which already discards this one -
       but a caller that doesn't must not be left with a stray pending
       exception that only surfaces later, unrelated to any real failure. */
    JS_FreeValue(ctx, JS_GetException(ctx));
  }

  JS_FreeValue(ctx, buffer);
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

static JSValue
js_invoke_deferred_call(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic, JSValueConst data[]) {
  JSValueConst obj = data[0], method = data[1];
  JSValue ret = JS_Call(ctx, method, obj, magic, &data[2]);

  if(JS_IsException(ret))
    js_error_print(ctx, JS_GetException(ctx));

  JS_FreeValue(ctx, ret);
  return JS_UNDEFINED;
}

/**
 * Defers `obj[method_name](...argv)` to a microtask, for callers running
 * from inside a native callback dispatch (LWSSocket's s->dispatching) where
 * calling back into JS synchronously would be misinterpreted (e.g. a
 * synchronous wsi.close() from inside onRawConnected/onClientEstablished
 * gets read by libwebsockets as the callback returning nonzero, i.e.
 * "reject this connection", instead of a graceful close - see BUGS).
 * Implemented as Promise.resolve().then(<JS_NewCFunctionData closure>) so
 * the invocation runs as a normal microtask job, same as a JS-authored
 * `Promise.resolve().then(() => obj[method_name](...argv))` would.
 */
JSValue
js_invoke_deferred(JSContext* ctx, JSValueConst obj, const char* method_name, int argc, JSValueConst argv[]) {
  JSValue method = JS_GetPropertyStr(ctx, obj, method_name);

  if(!JS_IsFunction(ctx, method)) {
    JS_FreeValue(ctx, method);
    return JS_ThrowTypeError(ctx, "'%s' is not a function", method_name);
  }

  JSValueConst* data = alloca(sizeof(JSValueConst) * (2 + argc));
  data[0] = obj;
  data[1] = method;

  for(int i = 0; i < argc; i++)
    data[2 + i] = argv[i];

  JSValue fn = JS_NewCFunctionData(ctx, js_invoke_deferred_call, 0, argc, 2 + argc, data);
  JS_FreeValue(ctx, method);

  JSValue promise_ctor = global_get(ctx, "Promise");
  JSValue resolve_fn = JS_GetPropertyStr(ctx, promise_ctor, "resolve");
  JSValue resolved = JS_Call(ctx, resolve_fn, promise_ctor, 0, 0);
  JS_FreeValue(ctx, resolve_fn);
  JS_FreeValue(ctx, promise_ctor);

  JSValue then_fn = JS_GetPropertyStr(ctx, resolved, "then");
  JSValue chained = JS_Call(ctx, then_fn, resolved, 1, (JSValueConst[]){fn});
  JS_FreeValue(ctx, then_fn);
  JS_FreeValue(ctx, resolved);
  JS_FreeValue(ctx, fn);

  return chained;
}
