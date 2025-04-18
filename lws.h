#ifndef QJS_LWS_H
#define QJS_LWS_H

#include <quickjs.h>

#define VISIBLE __attribute__((visibility("default")))

static inline size_t
str_chr(const char* s, char c) {
  size_t i;

  for(i = 0; s[i]; ++i)
    if(s[i] == c)
      return i;

  return i;
}

static inline size_t
str_chrs(const char* s, const char* set, size_t setlen) {
  size_t i, j;

  for(i = 0; s[i]; ++i)
    for(j = 0; j < setlen; ++j)
      if(s[i] == set[j])
        return i;

  return i;
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

static inline const char*
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
}

int lws_init(JSContext*, JSModuleDef*);
JSModuleDef* js_init_module(JSContext*, const char*);

#endif
