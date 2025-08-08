/**
 * @file js-utils.h
 */
#ifndef JS_UTILS_H
#define JS_UTILS_H

#include <quickjs.h>
#include <cutils.h>

#define JS_CONSTANT(c) JS_PROP_INT64_DEF((#c), (c), JS_PROP_ENUMERABLE)

#define JS_CGETSET_MAGIC_FLAGS_DEF(prop_name, fgetter, fsetter, magic_num, flags) \
  { \
    .name = prop_name, .prop_flags = flags, .def_type = JS_DEF_CGETSET_MAGIC, .magic = magic_num, .u = {.getset = {.get = {.getter_magic = fgetter}, .set = {.setter_magic = fsetter}} } \
  }

#define MAX(a, b) ((a) > (b) ? (a) : (b))
#define MIN(a, b) ((a) < (b) ? (a) : (b))
#define WRAPAROUND(n, len) ((n) < 0 ? (n) + (len) : (n))

typedef JSValue CClosureFunc(JSContext*, JSValueConst, int, JSValueConst[], int, void*);

size_t camelize(char*, size_t, const char*);
size_t decamelize(char*, size_t, const char*);
JSValue ptr_obj(JSContext*, JSObject*);
JSValue js_iterator_next(JSContext*, JSValueConst, BOOL*);
JSValue* to_valuearray(JSContext*, JSValueConst, size_t*);
char** to_stringarray(JSContext*, JSValueConst);
BOOL js_has_property(JSContext*, JSValueConst, const char*);
BOOL js_has_property2(JSContext*, JSValueConst, const char*);
JSValue js_get_property(JSContext*, JSValueConst, const char*);
void str_or_buf_property(const char**, const void**, unsigned int*, JSContext*, JSValueConst, const char*);
size_t get_offset_length(JSContext*, int, JSValueConst[], size_t, size_t*);
void* get_buffer(JSContext*, int, JSValueConst[], size_t*);
JSValue iterator_get(JSContext*, JSValueConst);
JSValue js_function_cclosure(JSContext*, CClosureFunc*, int, int, void*, void (*)(void*));
void js_error_print(JSContext*, JSValueConst);

#if __SIZEOF_POINTER__ == 8
static inline void*
to_ptr(JSContext* ctx, JSValueConst val) {
  int64_t i = -1;
  JS_ToInt64(ctx, &i, val);
  return (void*)i;
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
is_nullish(JSValueConst val) {
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

static inline uint32_t
to_uint32free_default(JSContext* ctx, JSValueConst val, uint32_t def) {
  if(JS_IsNumber(val))
    return to_uint32free(ctx, val);
  JS_FreeValue(ctx, val);
  return def;
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
  if(is_nullish(value))
    return 0;

  const char* s = JS_ToCString(ctx, value);
  char* x = js_strdup(ctx, s);
  JS_FreeCString(ctx, s);
  return x;
}

static inline char*
to_stringlen(JSContext* ctx, size_t* lenp, JSValueConst value) {
  if(is_nullish(value))
    return 0;

  size_t len = 0;
  const char* s = JS_ToCStringLen(ctx, &len, value);
  char* x = js_strndup(ctx, s, len);
  JS_FreeCString(ctx, s);

  if(lenp)
    *lenp = len;

  return x;
}

static inline char*
to_stringfree(JSContext* ctx, JSValue value) {
  char* s = to_string(ctx, value);
  JS_FreeValue(ctx, value);
  return s;
}

static inline char*
to_stringfree_default(JSContext* ctx, JSValue value, const char* def) {
  if(JS_IsUndefined(value) || JS_IsNull(value) || JS_IsException(value) || JS_IsUninitialized(value))
    return js_strdup(ctx, def);

  return to_stringfree(ctx, value);
}

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

static inline void
str_free(JSContext* ctx, char** pptr) {
  if(*pptr) {
    js_free(ctx, *pptr);
    *pptr = 0;
  }
}

static inline void
str_replace(JSContext* ctx, const char** pptr, char* str) {
  char** pp = (char**)pptr;
  str_free(ctx, pp);
  *pp = str;
}

static inline void
str_property(const char** pptr, JSContext* ctx, JSValueConst obj, const char* name) {
  if(js_has_property2(ctx, obj, name))
    str_replace(ctx, pptr, to_stringfree(ctx, js_get_property(ctx, obj, name)));
}

static inline JSObject*
obj_ptr(JSContext* ctx, JSValueConst obj) {
  return JS_VALUE_GET_OBJ(JS_DupValue(ctx, obj));
}

static inline void
obj_free(JSRuntime* rt, JSObject* obj) {
  JS_FreeValueRT(rt, JS_MKPTR(JS_TAG_OBJECT, obj));
}

#endif /* JS_UTILS_H */
