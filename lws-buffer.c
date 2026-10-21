#include "lws-buffer.h"
#include "lws.h"
#include "js-utils.h"
#include "quickjs.h"
#include <inttypes.h>
#include <string.h>

/* View and Buffer are classes of their own (not ArrayBuffers), each object holding an LWSObj.
   View is the pure range (write, skip, avail, pointer, detach); Buffer extends it with the start
   it was made at (length, span, reset, toArrayBuffer, toString, readable, writable) */
static JSClassID lwsjs_view_class_id, lwsjs_buffer_class_id;
static JSValue lwsjs_view_ctor, lwsjs_view_proto, lwsjs_buffer_ctor, lwsjs_buffer_proto;

typedef struct {
  void* data;  /* struct lwsjs_view* or struct lwsjs_buffer*, NULL once detached. points to own for
                  objects made by the constructors, borrowed memory for lwsjs_view_wrap() */
  JSValue ref; /* what the memory belongs to, kept alive */
  union {
    struct lwsjs_view view;
    struct lwsjs_buffer buffer;
  } own;
} LWSObj;

static LWSObj*
lwsjs_obj(JSContext* ctx, JSValueConst value) {
  LWSObj* o;

  if(!(o = JS_GetOpaque(value, lwsjs_view_class_id)) && !(o = JS_GetOpaque(value, lwsjs_buffer_class_id)))
    JS_ThrowTypeError(ctx, "not a View | Buffer");

  return o;
}

/* the view of a View, or of a Buffer (its first member) */
struct lwsjs_view*
lwsjs_view_data2(JSContext* ctx, JSValueConst value) {
  LWSObj* o;

  if(!(o = lwsjs_obj(ctx, value)))
    return NULL;

  if(!o->data) {
    JS_ThrowTypeError(ctx, "detached");
    return NULL;
  }

  /* a Buffer is written through its writable half */
  return JS_GetOpaque(value, lwsjs_buffer_class_id) ? &((struct lwsjs_buffer*)o->data)->writable : o->data;
}

struct lwsjs_view*
lwsjs_view_data(JSContext* ctx, JSValueConst value) {
  struct lwsjs_view* view;

  if(!(view = lwsjs_view_data2(ctx, value)))
    JS_FreeValue(ctx, JS_GetException(ctx));

  return view;
}

/* cuts the object off the memory it borrowed (after the callback that lent it returned) */
void
lwsjs_view_detach(JSContext* ctx, JSValueConst value) {
  LWSObj* o;

  if((o = JS_GetOpaque(value, lwsjs_view_class_id)) || (o = JS_GetOpaque(value, lwsjs_buffer_class_id)))
    o->data = NULL;
}

/* destination of an output call, from the arguments left (argc, argv):
     argc == 1   a wrapped struct lwsjs_view: *vp is that view itself, advanced in place
     argc >= 2   ArrayBuffer | TypedArray | DataView and its write position (number, or array
                 [number]): *vp is *local, set up for the room from that position on
   returns where writing starts (NULL with an exception if argv is not a destination). when
   argc >= 2 the caller commits the advanced *local back with lwsjs_view_commit() */
uint8_t*
lwsjs_view_args(JSContext* ctx, struct lwsjs_view** vp, struct lwsjs_view* local, int argc, JSValueConst argv[]) {
  if(argc == 1) {
    struct lwsjs_view* v;

    if(!(v = lwsjs_view_data2(ctx, argv[0])))
      return NULL;

    if(!v->p || v->end < v->p) {
      JS_ThrowRangeError(ctx, "struct lwsjs_view has invalid range");
      return NULL;
    }

    *vp = v;
    return v->p;
  }

  size_t len;
  uint8_t* buf;

  if(argc < 2 || !(buf = get_buffer(ctx, 1, argv, &len))) {
    JS_ThrowTypeError(ctx, "argument must be struct lwsjs_view | (ArrayBuffer, offset)");
    return NULL;
  }

  int64_t ofs = to_int64free(ctx, JS_IsObject(argv[1]) ? JS_GetPropertyUint32(ctx, argv[1], 0) : JS_DupValue(ctx, argv[1]));

  lwsjs_view_buf(local, buf, len);
  local->p += CLAMP(ofs, 0, (int64_t)len);
  *vp = local;
  return local->p;
}

/* buffer form only: stores the position v->p reached into the offset array argv[1] */
void
lwsjs_view_commit(JSContext* ctx, JSValueConst argv[], const struct lwsjs_view* v) {
  size_t len;
  uint8_t* buf;

  if(JS_IsObject(argv[1]) && (buf = get_buffer(ctx, 1, argv, &len)))
    JS_SetPropertyUint32(ctx, argv[1], 0, js_new_size(ctx, v->p - buf));
}

enum {
  VIEW_WRITE = 0,
  VIEW_DETACH,
  VIEW_AVAIL,
  VIEW_SKIP,
  VIEW_POINTER,
};

static JSValue
lwsjs_view_method(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[], int magic) {
  struct lwsjs_view* view;

  if(!(view = lwsjs_view_data2(ctx, this_val)))
    return JS_EXCEPTION;

  if(view->end < view->p)
    return JS_ThrowRangeError(ctx, "struct lwsjs_view has .end < .p");

  size_t avail = view->end - view->p;
  JSValue ret = JS_UNDEFINED;

  switch(magic) {
    case VIEW_WRITE: {
      const char* str = 0;
      uint8_t* buf;
      size_t len;

      if(argc > 0 && (buf = get_buffer(ctx, argc, argv, &len))) {
      } else if(argc > 0 && (str = JS_ToCStringLen(ctx, &len, argv[0]))) {
        buf = (uint8_t*)str;
      } else {
        return JS_ThrowTypeError(ctx, "argument 1 must be ArrayBuffer | TypedArray | String");
      }

      if((len = MIN(len, avail)))
        memcpy(view->p, buf, len);

      view->p += len;
      ret = js_new_size(ctx, len);

      if(str)
        JS_FreeCString(ctx, str);

      break;
    }
    case VIEW_DETACH: {
      lwsjs_view_detach(ctx, this_val);
      break;
    }
    case VIEW_AVAIL: {
      ret = js_new_size(ctx, avail);
      break;
    }
    case VIEW_SKIP: {
      size_t n = argc > 0 ? to_size(ctx, argv[0]) : 0;

      view->p += MIN(n, avail);
      ret = JS_DupValue(ctx, this_val);
      break;
    }
    case VIEW_POINTER: {
      ret = js_new_pointer(ctx, view->p);
      break;
    }
  }

  return ret;
}

static JSValue
lwsjs_view_get(JSContext* ctx, JSValueConst this_val, int magic) {
  return lwsjs_view_method(ctx, this_val, 0, NULL, magic);
}

static JSValue
lwsjs_view_set(JSContext* ctx, JSValueConst this_val, JSValueConst value, int magic) {
  struct lwsjs_view* view;

  if(!(view = lwsjs_view_data2(ctx, this_val)))
    return JS_EXCEPTION;

  switch(magic) {
    case VIEW_POINTER: {
      js_to_pointer(ctx, &view->p, value);
      break;
    }
  }

  return JS_UNDEFINED;
}

static const JSCFunctionListEntry lwsjs_view_funcs[] = {
    JS_CFUNC_MAGIC_DEF("write", 1, lwsjs_view_method, VIEW_WRITE),
    JS_CFUNC_MAGIC_DEF("detach", 0, lwsjs_view_method, VIEW_DETACH),
    JS_CFUNC_MAGIC_DEF("skip", 1, lwsjs_view_method, VIEW_SKIP),
    JS_CGETSET_MAGIC_DEF("avail", lwsjs_view_get, NULL, VIEW_AVAIL),
    JS_CGETSET_MAGIC_DEF("pointer", lwsjs_view_get, lwsjs_view_set, VIEW_POINTER),
    JS_PROP_STRING_DEF("[Symbol.toStringTag]", "LWSView", JS_PROP_CONFIGURABLE),
};

/* the wrapped struct lwsjs_buffer of a Buffer */
struct lwsjs_buffer*
lwsjs_buffer_data2(JSContext* ctx, JSValueConst value) {
  LWSObj* o;

  if(!(o = JS_GetOpaque2(ctx, value, lwsjs_buffer_class_id)))
    return NULL;

  if(!o->data)
    JS_ThrowTypeError(ctx, "detached");

  return o->data;
}

struct lwsjs_buffer*
lwsjs_buffer_data(JSContext* ctx, JSValueConst value) {
  struct lwsjs_buffer* buffer;

  if(!(buffer = lwsjs_buffer_data2(ctx, value)))
    JS_FreeValue(ctx, JS_GetException(ctx));

  return buffer;
}

enum {
  BUFFER_LENGTH = 0,
  BUFFER_SPAN,
  BUFFER_RESET,
  BUFFER_TOBUFFER,
  BUFFER_TOSTRING,
  BUFFER_READABLE,
  BUFFER_WRITABLE,
};

static JSValue lwsjs_obj_new(JSContext*, LWSObj*, BOOL);

static JSValue
lwsjs_buffer_method(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[], int magic) {
  struct lwsjs_buffer* buffer;

  if(!(buffer = lwsjs_buffer_data2(ctx, this_val)))
    return JS_EXCEPTION;

  if(buffer->writable.p < buffer->start || buffer->writable.end < buffer->writable.p)
    return JS_ThrowRangeError(ctx, "struct lwsjs_buffer has invalid range");

  JSValue ret = JS_UNDEFINED;

  switch(magic) {
    case BUFFER_LENGTH: {
      ret = js_new_size(ctx, lwsjs_buffer_len(buffer));
      break;
    }
    case BUFFER_SPAN: {
      ret = js_new_size(ctx, buffer->writable.end - buffer->start);
      break;
    }
    case BUFFER_RESET: {
      buffer->writable.p = buffer->start;
      ret = JS_DupValue(ctx, this_val);
      break;
    }
    case BUFFER_TOBUFFER: {
      ret = JS_NewArrayBufferCopy(ctx, buffer->start, lwsjs_buffer_len(buffer));
      break;
    }
    case BUFFER_READABLE:
    case BUFFER_WRITABLE: {
      LWSObj* a;

      if(!(a = js_mallocz(ctx, sizeof(LWSObj))))
        return JS_EXCEPTION;

      /* aliases one half of the buffer, which it keeps alive and names as .parent */
      a->data = magic == BUFFER_READABLE ? (void*)lwsjs_buffer_readable(buffer) : (void*)&buffer->writable;
      a->ref = JS_DupValue(ctx, this_val);
      ret = lwsjs_obj_new(ctx, a, FALSE);

      if(!JS_IsException(ret))
        JS_DefinePropertyValueStr(ctx, ret, "parent", JS_DupValue(ctx, this_val), JS_PROP_CONFIGURABLE);

      break;
    }
    case BUFFER_TOSTRING: {
      ret = JS_NewStringLen(ctx, (const char*)buffer->start, lwsjs_buffer_len(buffer));
      break;
    }
  }

  return ret;
}

static JSValue
lwsjs_buffer_get(JSContext* ctx, JSValueConst this_val, int magic) {
  return lwsjs_buffer_method(ctx, this_val, 0, NULL, magic);
}

static const JSCFunctionListEntry lwsjs_buffer_funcs[] = {
    JS_CFUNC_MAGIC_DEF("reset", 0, lwsjs_buffer_method, BUFFER_RESET),
    JS_CFUNC_MAGIC_DEF("toArrayBuffer", 0, lwsjs_buffer_method, BUFFER_TOBUFFER),
    JS_CFUNC_MAGIC_DEF("toString", 0, lwsjs_buffer_method, BUFFER_TOSTRING),
    JS_CGETSET_MAGIC_DEF("length", lwsjs_buffer_get, NULL, BUFFER_LENGTH),
    JS_CGETSET_MAGIC_DEF("span", lwsjs_buffer_get, NULL, BUFFER_SPAN),
    JS_CGETSET_MAGIC_DEF("readable", lwsjs_buffer_get, NULL, BUFFER_READABLE),
    JS_CGETSET_MAGIC_DEF("writable", lwsjs_buffer_get, NULL, BUFFER_WRITABLE),
    JS_PROP_STRING_DEF("[Symbol.toStringTag]", "LWSBuffer", JS_PROP_CONFIGURABLE),
};

static void
lwsjs_obj_finalizer(JSRuntime* rt, JSValue val) {
  LWSObj* o;

  if((o = JS_GetOpaque(val, lwsjs_view_class_id)) || (o = JS_GetOpaque(val, lwsjs_buffer_class_id))) {
    JS_FreeValueRT(rt, o->ref);
    js_free_rt(rt, o);
  }
}

static void
lwsjs_obj_mark(JSRuntime* rt, JSValueConst val, JS_MarkFunc* mark_func) {
  LWSObj* o;

  if((o = JS_GetOpaque(val, lwsjs_view_class_id)) || (o = JS_GetOpaque(val, lwsjs_buffer_class_id)))
    JS_MarkValue(rt, o->ref, mark_func);
}

static JSClassDef lwsjs_view_class = {
    "View",
    .finalizer = lwsjs_obj_finalizer,
    .gc_mark = lwsjs_obj_mark,
};
static JSClassDef lwsjs_buffer_class = {
    "Buffer",
    .finalizer = lwsjs_obj_finalizer,
    .gc_mark = lwsjs_obj_mark,
};

/* wraps an LWSObj as View or Buffer object, taking it over (freed with the object) */
static JSValue
lwsjs_obj_new(JSContext* ctx, LWSObj* o, BOOL is_buffer) {
  JSValue obj = JS_NewObjectProtoClass(ctx, is_buffer ? lwsjs_buffer_proto : lwsjs_view_proto, is_buffer ? lwsjs_buffer_class_id : lwsjs_view_class_id);

  if(JS_IsException(obj)) {
    JS_FreeValue(ctx, o->ref);
    js_free(ctx, o);
    return obj;
  }

  JS_SetOpaque(obj, o);
  return obj;
}

/* the object only borrows *view: it must stay valid for as long as its methods can be called, and
   is cut off with lwsjs_view_detach() */
JSValue
lwsjs_view_wrap(JSContext* ctx, struct lwsjs_view* view) {
  LWSObj* o;

  if(!(o = js_mallocz(ctx, sizeof(LWSObj))))
    return JS_EXCEPTION;

  o->data = view;
  o->ref = JS_UNDEFINED;
  return lwsjs_obj_new(ctx, o, FALSE);
}

JSValue
lwsjs_buffer_wrap(JSContext* ctx, struct lwsjs_buffer* buffer) {
  LWSObj* o;

  if(!(o = js_mallocz(ctx, sizeof(LWSObj))))
    return JS_EXCEPTION;

  o->data = buffer;
  o->ref = JS_UNDEFINED;
  return lwsjs_obj_new(ctx, o, TRUE);
}

/* View(buffer [, offset [, size]]) (buffer: ArrayBuffer | TypedArray | DataView, as .parent), View(p, end [, parent]) with raw addresses, and Buffer([size] | buffer [, offset [, length]]), new or
   plain call alike: a wrapped range that keeps its buffer alive buffer[offset, offset + length).
   Buffer(size) and Buffer() own a zeroed block of LWS_PRE + size (LWS_RECOMMENDED_MIN_HEADER_SPACE
   without size) instead, the range starts LWS_PRE bytes in so lws_write() has its headroom */
static JSValue
lwsjs_construct(JSContext* ctx, int argc, JSValueConst argv[], BOOL is_buffer) {
  size_t blen;
  uint8_t* buf = NULL;
  int64_t ofs = 0, len;
  JSValueConst parent = JS_UNDEFINED;
  struct lwsjs_view v;
  LWSObj* o;

  if(is_buffer && (argc < 1 || JS_IsUndefined(argv[0]) || JS_IsNumber(argv[0]))) {
    len = LWS_RECOMMENDED_MIN_HEADER_SPACE;

    if(argc > 0 && !JS_IsUndefined(argv[0]) && JS_ToInt64(ctx, &len, argv[0]))
      return JS_EXCEPTION;

    if(len < 0 || len > INT32_MAX)
      return JS_ThrowRangeError(ctx, "invalid size %" PRId64, len);

    if(!(o = js_mallocz(ctx, sizeof(LWSObj) + LWS_PRE + len)))
      return JS_EXCEPTION;

    o->ref = JS_UNDEFINED;
    lwsjs_view_buf(&v, (uint8_t*)(o + 1) + LWS_PRE, len);
  } else if(!is_buffer && argc >= 1 && (JS_IsNumber(argv[0]) || JS_IsBigInt(ctx, argv[0]))) {
    /* View(p, end [, parent]): raw addresses, only parent (if given) is kept alive */
    if(argc < 2 || js_to_pointer(ctx, &v.p, argv[0]) || js_to_pointer(ctx, &v.end, argv[1]))
      return JS_ThrowTypeError(ctx, "View(p, end) needs two pointers (Number | BigInt)");

    if(!v.p || v.end < v.p)
      return JS_ThrowRangeError(ctx, "invalid range: p must be non-null and not above end");

    if(!(o = js_mallocz(ctx, sizeof(LWSObj))))
      return JS_EXCEPTION;

    o->ref = JS_UNDEFINED;

    if(argc > 2)
      parent = argv[2];
  } else {
    if(argc < 1 || !(buf = get_buffer(ctx, 1, argv, &blen)))
      return JS_ThrowTypeError(ctx, is_buffer ? "argument 1 must be size | ArrayBuffer | TypedArray | DataView" : "argument 1 must be ArrayBuffer | TypedArray | DataView");

    /* View(buf, offset, size) is View(toPointer(buf) + offset, toPointer(buf) + offset +
       (size ?? byteLength - offset), buf) */
    if(argc > 1 && !JS_IsUndefined(argv[1]) && JS_ToInt64(ctx, &ofs, argv[1]))
      return JS_EXCEPTION;

    len = (int64_t)blen - ofs;

    if(argc > 2 && !JS_IsUndefined(argv[2]) && JS_ToInt64(ctx, &len, argv[2]))
      return JS_EXCEPTION;

    if(!is_buffer)
      parent = argv[0];

    if(ofs < 0 || (uint64_t)ofs > blen || len < 0 || (uint64_t)len > blen - ofs)
      return JS_ThrowRangeError(ctx, "offset %" PRId64 " + length %" PRId64 " out of range of buffer of %zu bytes", ofs, len, blen);

    if(!(o = js_mallocz(ctx, sizeof(LWSObj))))
      return JS_EXCEPTION;

    lwsjs_view_buf(&v, buf + ofs, len);
    o->ref = JS_DupValue(ctx, argv[0]);
  }

  if(is_buffer) {
    o->own.buffer.start = v.p;
    o->own.buffer.writable = v;
    o->data = &o->own.buffer;
  } else {
    o->own.view = v;
    o->data = &o->own.view;
  }

  JSValue ret = lwsjs_obj_new(ctx, o, is_buffer);

  if(!JS_IsException(ret) && !JS_IsUndefined(parent)) {
    /* View(p, end, parent): parent is what owns the memory p..end, keep it alive as .parent */
    JS_DefinePropertyValueStr(ctx, ret, "parent", JS_DupValue(ctx, parent), JS_PROP_CONFIGURABLE);
  }

  return ret;
}

static JSValue
lwsjs_view_constructor(JSContext* ctx, JSValueConst new_target, int argc, JSValueConst argv[]) {
  return lwsjs_construct(ctx, argc, argv, FALSE);
}

static JSValue
lwsjs_buffer_constructor(JSContext* ctx, JSValueConst new_target, int argc, JSValueConst argv[]) {
  return lwsjs_construct(ctx, argc, argv, TRUE);
}

int
lwsjs_buffer_init(JSContext* ctx, JSModuleDef* m) {
  JS_NewClassID(&lwsjs_view_class_id);
  JS_NewClass(JS_GetRuntime(ctx), lwsjs_view_class_id, &lwsjs_view_class);
  JS_NewClassID(&lwsjs_buffer_class_id);
  JS_NewClass(JS_GetRuntime(ctx), lwsjs_buffer_class_id, &lwsjs_buffer_class);

  lwsjs_view_proto = JS_NewObjectProto(ctx, JS_NULL);
  JS_SetPropertyFunctionList(ctx, lwsjs_view_proto, lwsjs_view_funcs, countof(lwsjs_view_funcs));
  lwsjs_view_ctor = JS_NewCFunction2(ctx, lwsjs_view_constructor, "View", 3, JS_CFUNC_constructor_or_func, 0);
  JS_SetConstructor(ctx, lwsjs_view_ctor, lwsjs_view_proto);

  /* a Buffer is a View that also knows where it started */
  lwsjs_buffer_proto = JS_NewObjectProto(ctx, lwsjs_view_proto);
  JS_SetPropertyFunctionList(ctx, lwsjs_buffer_proto, lwsjs_buffer_funcs, countof(lwsjs_buffer_funcs));
  lwsjs_buffer_ctor = JS_NewCFunction2(ctx, lwsjs_buffer_constructor, "Buffer", 3, JS_CFUNC_constructor_or_func, 0);
  JS_SetConstructor(ctx, lwsjs_buffer_ctor, lwsjs_buffer_proto);
  JS_SetPrototype(ctx, lwsjs_buffer_ctor, lwsjs_view_ctor);

  if(m) {
    JS_SetModuleExport(ctx, m, "View", JS_DupValue(ctx, lwsjs_view_ctor));
    JS_SetModuleExport(ctx, m, "Buffer", JS_DupValue(ctx, lwsjs_buffer_ctor));
  }

  return 0;
}
