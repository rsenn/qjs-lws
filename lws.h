#ifndef QJS_LWS_H
#define QJS_LWS_H

#include <quickjs.h>
#include <libwebsockets.h>
#include <cutils.h>
#include <list.h>
#include <ctype.h>

#if __SIZEOF_POINTER__ == 8
#define intptr int64_t
#elif __SIZEOF_POINTER__ == 4
#define intptr int32_t
#endif

#if __SIZEOF_POINTER__ == 8
static inline void*
to_ptr(JSContext* ctx, JSValueConst val) {
  int64_t i = -1;
  JS_ToInt64(ctx, &i, val);
  return (void*)i;
}

#ifdef DEBUG_OUTPUT
#define DEBUG(x...) lwsl_user(x)
#else
#define DEBUG(x...)
#endif

#define VISIBLE __attribute__((visibility("default")))
#define MAX(a, b) ((a) > (b) ? (a) : (b))
#define MIN(a, b) ((a) < (b) ? (a) : (b))
#define WRAPAROUND(n, len) ((n) < 0 ? (n) + (len) : (n))

#define JS_CONSTANT(c) JS_PROP_INT64_DEF((#c), (c), JS_PROP_ENUMERABLE)

#define JS_CGETSET_MAGIC_FLAGS_DEF(prop_name, fgetter, fsetter, magic_num, flags) \
  { \
    .name = prop_name, .prop_flags = flags, .def_type = JS_DEF_CGETSET_MAGIC, .magic = magic_num, .u = {.getset = {.get = {.getter_magic = fgetter}, .set = {.setter_magic = fsetter}} } \
  }

#define to_integer(ctx, val) to_int64(ctx, val)
#define to_integerfree(ctx, val) to_int64free(ctx, val)
#elif __SIZEOF_POINTER__ == 8
static inline void*
to_ptr(JSContext* ctx, JSValueConst val) {
  int32_t i = -1;
  JS_ToInt32(ctx, &i, val);
  return (void*)i;
}

#define to_integer(ctx, val) to_int32(ctx, val)
#define to_integerfree(ctx, val) to_int32free(ctx, val)
#endif

static inline BOOL
is_null_or_undefined(JSValueConst val) {
  return JS_IsNull(val) || JS_IsUndefined(val);
}

static inline int32_t
to_int32(JSContext* ctx, JSValueConst val) {
  int32_t i = -1;
  JS_ToInt32(ctx, &i, val);
  return i;
}

static inline int32_t
to_int32free(JSContext* ctx, JSValueConst val) {
  int32_t i = to_int32(ctx, val);
  JS_FreeValue(ctx, val);
  return i;
}

static inline uint32_t
to_uint32(JSContext* ctx, JSValueConst val) {
  uint32_t i = -1;
  JS_ToUint32(ctx, &i, val);
  return i;
}

static inline uint32_t
to_uint32free(JSContext* ctx, JSValueConst val) {
  uint32_t i = to_uint32(ctx, val);
  JS_FreeValue(ctx, val);
  return i;
}

static inline int64_t
to_int64(JSContext* ctx, JSValueConst val) {
  int64_t i = -1;
  JS_ToInt64(ctx, &i, val);
  return i;
}

static inline int64_t
to_int64free(JSContext* ctx, JSValueConst val) {
  int64_t i = to_int64(ctx, val);
  JS_FreeValue(ctx, val);
  return i;
}

static inline char*
to_string(JSContext* ctx, JSValueConst value) {
  if(is_null_or_undefined(value))
    return 0;

  const char* s = JS_ToCString(ctx, value);
  char* x = js_strdup(ctx, s);
  JS_FreeCString(ctx, s);
  return x;
}

static inline char*
to_stringfree(JSContext* ctx, JSValue value) {
  char* s = to_string(ctx, value);
  JS_FreeValue(ctx, value);
  return s;
}

char** to_stringarray(JSContext*, JSValueConst);

static inline char**
to_stringarrayfree(JSContext* ctx, JSValue val) {
  char** ret = to_stringarray(ctx, val);
  JS_FreeValue(ctx, val);
  return ret;
}

static inline BOOL
to_boolfree(JSContext* ctx, JSValue value) {
  BOOL b = JS_ToBool(ctx, value);
  JS_FreeValue(ctx, value);
  return b;
}

static inline JSValue
global_get(JSContext* ctx, const char* name) {
  JSValue global_obj = JS_GetGlobalObject(ctx);
  JSValue ret = JS_GetPropertyStr(ctx, global_obj, name);
  JS_FreeValue(ctx, global_obj);
  return ret;
}

static inline JSObject*
obj_ptr(JSContext* ctx, JSValueConst obj) {
  return JS_VALUE_GET_OBJ(JS_DupValue(ctx, obj));
}

static inline void
obj_free(JSRuntime* rt, JSObject* obj) {
  JS_FreeValueRT(rt, JS_MKPTR(JS_TAG_OBJECT, obj));
}

static inline size_t
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

static inline void*
get_buffer(JSContext* ctx, int argc, JSValueConst argv[], size_t* lenp) {
  size_t len;
  uint8_t* ptr;

  if((ptr = JS_GetArrayBuffer(ctx, &len, argv[0]))) {
    size_t ofs = 0;

    if(argc > 1)
      ofs = get_offset_length(ctx, argc - 1, argv + 1, len, lenp);

    ptr += ofs;
  }

  return ptr;
}

JSValue ptr_obj(JSContext* ctx, JSObject* obj);

static inline JSValue
iterator_get(JSContext* ctx, JSValueConst iterable) {
  JSValue symbol = global_get(ctx, "Symbol");
  JSValue symiter = JS_GetPropertyStr(ctx, symbol, "iterator");
  JS_FreeValue(ctx, symbol);
  JSAtom atom = JS_ValueToAtom(ctx, symiter);
  JS_FreeValue(ctx, symiter);
  JSValue ret = JS_GetProperty(ctx, iterable, atom);
  JS_FreeAtom(ctx, atom);
  return ret;
}

static inline int
clz(uint32_t i) {
  int ret = 0;

  for(ret = 0; !(i & 0x80000000); ++ret)
    i <<= 1;

  return ret;
}

static inline size_t
find_charset(const char* s, const char* set, size_t setlen) {
  size_t i, j;

  for(i = 0; s[i]; ++i)
    for(j = 0; j < setlen; ++j)
      if(s[i] == set[j])
        return i;

  return i;
}

static inline size_t
camelize(char* dst, size_t dlen, const char* src) {
  size_t i, j;

  for(i = 0, j = 0; src[i] && j + 1 < dlen; ++i, ++j) {
    if(src[i] == '_') {
      ++i;
      dst[j] = toupper(src[i]);
      continue;
    }

    dst[j] = tolower(src[i]);
  }

  dst[j] = '\0';
  return j;
}

static inline size_t
decamelize(char* dst, size_t dlen, const char* src) {
  size_t i, j;

  for(i = 0, j = 0; src[i] && j + 1 < dlen; ++i, ++j) {
    if(i > 0 && islower(src[i - 1]) && isupper(src[i]))
      dst[j++] = '_';

    dst[j] = toupper(src[i]);
  }

  dst[j] = '\0';
  return j;
}

static inline int
list_size(struct list_head* list) {
  struct list_head* el;
  int i = 0;

  list_for_each(el, list) { ++i; }

  return i;
}

void lwsjs_get_lws_callbacks(JSContext* ctx, JSValueConst obj, JSValue callbacks[]);
BOOL lwsjs_has_property(JSContext*, JSValue, const char*);
JSValue lwsjs_get_property(JSContext*, JSValue, const char*);
enum lws_callback_reasons lwsjs_callback_find(const char* name);
int lwsjs_init(JSContext*, JSModuleDef*);
JSModuleDef* lwsjs_init_module(JSContext*, const char*);
int lwsjs_spa_init(JSContext* ctx, JSModuleDef* m);

#endif
