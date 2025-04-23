#ifndef QJS_LWS_H
#define QJS_LWS_H

#include <quickjs.h>
#include <libwebsockets.h>
#include <cutils.h>
#include <ctype.h>

#define VISIBLE __attribute__((visibility("default")))
#define MAX(a, b) ((a) > (b) ? (a) : (b))
#define MIN(a, b) ((a) < (b) ? (a) : (b))

static inline size_t
str_chrs(const char* s, const char* set, size_t setlen) {
  size_t i, j;

  for(i = 0; s[i]; ++i)
    for(j = 0; j < setlen; ++j)
      if(s[i] == set[j])
        return i;

  return i;
}

static inline size_t
str_camelize(char* dst, size_t dlen, const char* src) {
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
str_decamelize(char* dst, size_t dlen, const char* src) {
  size_t i, j;

  for(i = 0, j = 0; src[i] && j + 1 < dlen; ++i, ++j) {
    if(i > 0 && islower(src[i - 1]) && isupper(src[i]))
      dst[j++] = '_';

    dst[j] = toupper(src[i]);
  }

  dst[j] = '\0';
  return j;
}

static inline const int64_t
value_to_integer(JSContext* ctx, JSValueConst value) {
  int64_t i = -1;
  JS_ToInt64(ctx, &i, value);
  return i;
}

static inline const char*
value_to_string(JSContext* ctx, JSValueConst value) {
  if(JS_IsUndefined(value) || JS_IsNull(value))
    return 0;

  const char* s = JS_ToCString(ctx, value);
  char* x = js_strdup(ctx, s);
  JS_FreeCString(ctx, s);
  return x;
}

/*static inline const char*
atom_to_string(JSContext* ctx, JSAtom a) {
  char* x = 0;
  JSValue v = JS_AtomToValue(ctx, a);

  if(!(JS_IsUndefined(v) || JS_IsNull(v))) {
    const char* s = JS_ToCString(ctx, v);
    x = js_strdup(ctx, s);
    JS_FreeCString(ctx, s);
  }

  JS_FreeValue(ctx, v);
  return x;
}*/

static inline BOOL
js_is_null_or_undefined(JSValueConst val) {
  return JS_IsNull(val) || JS_IsUndefined(val);
}
#define JS_CGETSET_MAGIC_FLAGS_DEF(prop_name, fgetter, fsetter, magic_num, flags) \
  { \
    .name = prop_name, .prop_flags = flags, .def_type = JS_DEF_CGETSET_MAGIC, .magic = magic_num, .u = {.getset = {.get = {.getter_magic = fgetter}, .set = {.setter_magic = fsetter}} } \
  }

void js_get_lws_callbacks(JSContext* ctx, JSValueConst obj, JSValue callbacks[LWS_CALLBACK_USER + 1]);
BOOL js_has_property(JSContext*, JSValue, const char*);
JSValue js_get_property(JSContext*, JSValue, const char*);
enum lws_callback_reasons lws_callback_find(const char* name);
int lws_init(JSContext*, JSModuleDef*);
JSModuleDef* js_init_module(JSContext*, const char*);

#endif
