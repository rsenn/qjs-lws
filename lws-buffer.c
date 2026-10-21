#include "lws-buffer.h"
#include "lws.h"
#include "js-utils.h"
#include "quickjs.h"
#include <inttypes.h>
#include <string.h>

/* View and Buffer are wrapped structs: an object holding a 16 (struct lwsjs_view) or 24 (struct
   lwsjs_buffer) byte ArrayBuffer, with a prototype of its own instead of ArrayBuffer.prototype.
   View is the pure range (write, skip, avail, pointer, detach); Buffer extends it with the start
   it was made at (written, capacity, reset, toArrayBuffer, toString) */
static JSValue lwsjs_view_ctor, lwsjs_view_proto, lwsjs_buffer_ctor, lwsjs_buffer_proto;

/* the view of a wrapped View, or of a wrapped Buffer (its first member) */
struct lwsjs_view*
lwsjs_view_data2(JSContext* ctx, JSValueConst value) {
  struct lwsjs_view* view;
  size_t size;

  if((view = (void*)JS_GetArrayBuffer(ctx, &size, value)) && size != sizeof(struct lwsjs_view) && size != sizeof(struct lwsjs_buffer)) {
    JS_ThrowInternalError(ctx, "lwsjs_view_data %" PRIu64 " != %" PRIu64 " sizeof(struct lwsjs_view) | %" PRIu64 " sizeof(struct lwsjs_buffer)", (uint64_t)size, (uint64_t)sizeof(struct lwsjs_view), (uint64_t)sizeof(struct lwsjs_buffer));
    view = NULL;
  }

  return view;
}

struct lwsjs_view*
lwsjs_view_data(JSContext* ctx, JSValueConst value) {
  struct lwsjs_view* view;

  if(!(view = lwsjs_view_data2(ctx, value)))
    JS_FreeValue(ctx, JS_GetException(ctx));

  return view;
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
      JS_DetachArrayBuffer(ctx, this_val);
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
  struct lwsjs_buffer* buffer;
  size_t size;

  if((buffer = (void*)JS_GetArrayBuffer(ctx, &size, value)) && size != sizeof(struct lwsjs_buffer)) {
    JS_ThrowInternalError(ctx, "lwsjs_buffer_data %" PRIu64 " != %" PRIu64 " sizeof(struct lwsjs_buffer)", (uint64_t)size, (uint64_t)sizeof(struct lwsjs_buffer));
    buffer = NULL;
  }

  return buffer;
}

struct lwsjs_buffer*
lwsjs_buffer_data(JSContext* ctx, JSValueConst value) {
  struct lwsjs_buffer* buffer;

  if(!(buffer = lwsjs_buffer_data2(ctx, value)))
    JS_FreeValue(ctx, JS_GetException(ctx));

  return buffer;
}

enum {
  BUFFER_WRITTEN = 0,
  BUFFER_CAPACITY,
  BUFFER_RESET,
  BUFFER_TOBUFFER,
  BUFFER_TOSTRING,
};

static JSValue
lwsjs_buffer_method(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[], int magic) {
  struct lwsjs_buffer* buffer;

  if(!(buffer = lwsjs_buffer_data2(ctx, this_val)))
    return JS_EXCEPTION;

  if(buffer->view.p < buffer->start || buffer->view.end < buffer->view.p)
    return JS_ThrowRangeError(ctx, "struct lwsjs_buffer has invalid range");

  JSValue ret = JS_UNDEFINED;

  switch(magic) {
    case BUFFER_WRITTEN: {
      ret = js_new_size(ctx, lwsjs_buffer_len(buffer));
      break;
    }
    case BUFFER_CAPACITY: {
      ret = js_new_size(ctx, buffer->view.end - buffer->start);
      break;
    }
    case BUFFER_RESET: {
      buffer->view.p = buffer->start;
      ret = JS_DupValue(ctx, this_val);
      break;
    }
    case BUFFER_TOBUFFER: {
      ret = JS_NewArrayBufferCopy(ctx, buffer->start, lwsjs_buffer_len(buffer));
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
    JS_CGETSET_MAGIC_DEF("written", lwsjs_buffer_get, NULL, BUFFER_WRITTEN),
    JS_CGETSET_MAGIC_DEF("capacity", lwsjs_buffer_get, NULL, BUFFER_CAPACITY),
    JS_PROP_STRING_DEF("[Symbol.toStringTag]", "LWSBuffer", JS_PROP_CONFIGURABLE),
};

/* wraps data (a struct lwsjs_view or struct lwsjs_buffer of size bytes) in an ArrayBuffer with
   proto as its prototype. data is only borrowed unless free_func releases it */
static JSValue
lwsjs_wrap(JSContext* ctx, void* data, size_t size, JSFreeArrayBufferDataFunc* free_func, void* opaque, JSValueConst proto) {
  JSValue obj = JS_NewArrayBuffer(ctx, data, size, free_func, opaque, FALSE);

  if(!JS_IsException(obj))
    JS_SetPrototype(ctx, obj, proto);

  return obj;
}

/* the object only borrows *view: it must stay valid for as long as its methods can be called */
JSValue
lwsjs_view_wrap(JSContext* ctx, struct lwsjs_view* view) {
  return lwsjs_wrap(ctx, view, sizeof(struct lwsjs_view), NULL, NULL, lwsjs_view_proto);
}

JSValue
lwsjs_buffer_wrap(JSContext* ctx, struct lwsjs_buffer* buffer) {
  return lwsjs_wrap(ctx, buffer, sizeof(struct lwsjs_buffer), NULL, NULL, lwsjs_buffer_proto);
}

/* storage of a View or Buffer made by its constructor: the struct itself and the buffer it
   points into (or, for Buffer(size), the memory itself right behind this struct) */
typedef struct {
  union {
    struct lwsjs_view view;
    struct lwsjs_buffer buffer;
  } u;
  JSValue ref;
} LWSOwner;

static void
lwsjs_owner_free(JSRuntime* rt, void* opaque, void* ptr) {
  LWSOwner* o = opaque;

  /* JS_DetachArrayBuffer() calls this and so does the finalizer afterwards, the second time with
     ptr == NULL (the detached data pointer) and the owner already gone */
  if(!ptr)
    return;

  JS_FreeValueRT(rt, o->ref);
  js_free_rt(rt, o);
}

/* View(buffer [, offset [, length]]) and Buffer([size] | buffer [, offset [, length]]), new or
   plain call alike: a wrapped range over buffer[offset, offset + length) that keeps buffer alive.
   Buffer(size) and Buffer() own a zeroed block of LWS_PRE + size (LWS_RECOMMENDED_MIN_HEADER_SPACE
   without size) instead, the range starts LWS_PRE bytes in so lws_write() has its headroom */
static JSValue
lwsjs_construct(JSContext* ctx, int argc, JSValueConst argv[], BOOL is_buffer) {
  size_t blen;
  uint8_t* buf = NULL;
  int64_t ofs = 0, len;
  LWSOwner* o;

  if(is_buffer && (argc < 1 || JS_IsUndefined(argv[0]) || JS_IsNumber(argv[0]))) {
    len = LWS_RECOMMENDED_MIN_HEADER_SPACE;

    if(argc > 0 && !JS_IsUndefined(argv[0]) && JS_ToInt64(ctx, &len, argv[0]))
      return JS_EXCEPTION;

    if(len < 0 || len > INT32_MAX)
      return JS_ThrowRangeError(ctx, "invalid size %" PRId64, len);

    if(!(o = js_mallocz(ctx, sizeof(LWSOwner) + LWS_PRE + len)))
      return JS_EXCEPTION;

    o->ref = JS_UNDEFINED;
    lwsjs_view_buf(&o->u.view, (uint8_t*)(o + 1) + LWS_PRE, len);
  } else {
    if(argc < 1 || !(buf = get_buffer(ctx, 1, argv, &blen)))
      return JS_ThrowTypeError(ctx, is_buffer ? "argument 1 must be size | ArrayBuffer | TypedArray | DataView" : "argument 1 must be ArrayBuffer | TypedArray | DataView");

    if(argc > 1 && !JS_IsUndefined(argv[1]) && JS_ToInt64(ctx, &ofs, argv[1]))
      return JS_EXCEPTION;

    len = (int64_t)blen - ofs;

    if(argc > 2 && !JS_IsUndefined(argv[2]) && JS_ToInt64(ctx, &len, argv[2]))
      return JS_EXCEPTION;

    if(ofs < 0 || (uint64_t)ofs > blen || len < 0 || (uint64_t)len > blen - ofs)
      return JS_ThrowRangeError(ctx, "offset %" PRId64 " + length %" PRId64 " out of range of buffer of %zu bytes", ofs, len, blen);

    if(!(o = js_malloc(ctx, sizeof(LWSOwner))))
      return JS_EXCEPTION;

    lwsjs_view_buf(&o->u.view, buf + ofs, len);
    o->ref = JS_DupValue(ctx, argv[0]);
  }

  if(is_buffer)
    o->u.buffer.start = o->u.view.p;

  JSValue ret = is_buffer ? lwsjs_wrap(ctx, &o->u.buffer, sizeof(struct lwsjs_buffer), lwsjs_owner_free, o, lwsjs_buffer_proto)
                          : lwsjs_wrap(ctx, &o->u.view, sizeof(struct lwsjs_view), lwsjs_owner_free, o, lwsjs_view_proto);

  if(JS_IsException(ret)) {
    JS_FreeValue(ctx, o->ref);
    js_free(ctx, o);
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
