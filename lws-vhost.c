#include "lws-vhost.h"
#include "lws-context.h"
#include "lws-socket.h"
#include "lws-protocol.h"
#include "js-utils.h"

struct lws_protocol_vhost_options*
lwsjs_vhost_option_from(JSContext* ctx, JSValueConst obj) {
  struct lws_protocol_vhost_options* vho;
  JSValue name = JS_UNDEFINED, value = JS_UNDEFINED, options = JS_UNDEFINED, next = JS_UNDEFINED;

  if(JS_IsArray(ctx, obj)) {
    name = JS_GetPropertyUint32(ctx, obj, 0);
    value = JS_GetPropertyUint32(ctx, obj, 1);
    options = JS_GetPropertyUint32(ctx, obj, 2);
  } else if(JS_IsObject(obj)) {
    name = JS_GetPropertyStr(ctx, obj, "name");
    value = JS_GetPropertyStr(ctx, obj, "value");
    options = JS_GetPropertyStr(ctx, obj, "options");

    if(js_has_property(ctx, obj, "next"))
      next = JS_GetPropertyStr(ctx, obj, "next");
  }

  if((vho = js_mallocz(ctx, sizeof(struct lws_protocol_vhost_options)))) {
    vho->name = to_string(ctx, name);
    vho->value = to_string(ctx, value);
    vho->options = lwsjs_vhost_options_from(ctx, options);
    vho->next = JS_IsObject(next) ? lwsjs_vhost_option_from(ctx, next) : NULL;
  }

  JS_FreeValue(ctx, name);
  JS_FreeValue(ctx, value);
  JS_FreeValue(ctx, options);
  JS_FreeValue(ctx, next);
  return vho;
}

struct lws_protocol_vhost_options*
lwsjs_vhost_options_from(JSContext* ctx, JSValueConst value) {
  struct lws_protocol_vhost_options *vho = 0, **ptr = &vho, *tmp;
  JSValue first = JS_UNDEFINED;

  if(JS_IsArray(ctx, value) && ((first = JS_GetPropertyUint32(ctx, value, 0)), JS_IsObject(first))) {
    int32_t len = to_int32free(ctx, JS_GetPropertyStr(ctx, value, "length"));

    if(len > 0) {
      for(int32_t i = 0; i < len; i++) {
        JSValue option = JS_GetPropertyUint32(ctx, value, i);

        if((*ptr = tmp = lwsjs_vhost_option_from(ctx, option)))
          do
            ptr = (struct lws_protocol_vhost_options**)&(*ptr)->next;
          while(*ptr);

        JS_FreeValue(ctx, option);

        if(!tmp)
          break;
      }
    }
  } else if(JS_IsObject(value)) {
    vho = lwsjs_vhost_option_from(ctx, value);
  }

  JS_FreeValue(ctx, first);

  return vho;
}

struct lws_protocol_vhost_options*
lwsjs_vhost_options_fromfree(JSContext* ctx, JSValue value) {
  struct lws_protocol_vhost_options* vho = lwsjs_vhost_options_from(ctx, value);

  JS_FreeValue(ctx, value);
  return vho;
}

void
lwsjs_vhost_options_free(JSRuntime* rt, struct lws_protocol_vhost_options* vho) {
  struct lws_protocol_vhost_options* next;

  while(vho) {
    js_free_rt(rt, (char*)vho->name);
    js_free_rt(rt, (char*)vho->value);
    lwsjs_vhost_options_free(rt, (struct lws_protocol_vhost_options*)vho->options);

    next = (struct lws_protocol_vhost_options*)vho->next;
    js_free_rt(rt, vho);
    vho = next;
  }
}

JSClassID lwsjs_vhost_class_id;
static JSValue lwsjs_vhost_proto, lwsjs_vhost_ctor;

static JSValue
lwsjs_vhost_constructor(JSContext* ctx, JSValueConst new_target, int argc, JSValueConst argv[]) {
  LWSVhost* vh;
  struct lws_context* context;

  if(!(context = lws_context_data(argv[0])))
    return JS_ThrowTypeError(ctx, "argument 1 must be of type LWSContext");

  if(!(vh = js_mallocz(ctx, sizeof(LWSVhost))))
    return JS_EXCEPTION;

  /* using new_target to get the prototype is necessary when the class is extended. */
  JSValue proto = JS_GetPropertyStr(ctx, new_target, "prototype");
  if(JS_IsException(proto))
    proto = JS_DupValue(ctx, lwsjs_vhost_proto);

  JSValue obj = JS_NewObjectProtoClass(ctx, proto, lwsjs_vhost_class_id);
  JS_FreeValue(ctx, proto);
  if(JS_IsException(obj))
    goto fail;

  if(JS_IsObject(argv[1]))
    lwsjs_context_creation_info_fromobj(ctx, argv[1], &vh->info);

  vh->info.user = obj_ptr(ctx, obj);

  JS_SetOpaque(obj, vh);

  /* This must be called last, because it can trigger callbacks already */
  if(!(vh->vho = lws_create_vhost(context, &vh->info))) {
    /* Undo the self-reference below by hand: the finalizer normally drops
       it, but the finalizer only runs once the last ref is gone, and
       vh->info.user *is* one of those refs - freeing just `obj` here would
       leave the object pinned at refcount 1 forever. */
    obj_free(JS_GetRuntime(ctx), vh->info.user);
    vh->info.user = NULL;

    JS_FreeValue(ctx, obj);

    return JS_ThrowInternalError(ctx, "lws_create_vhost failed");
  }

  JS_DefinePropertyValueStr(ctx, obj, "info", JS_DupValue(ctx, argv[1]), JS_PROP_CONFIGURABLE);
  return obj;

fail:
  js_free(ctx, vh);
  JS_FreeValue(ctx, obj);
  return JS_EXCEPTION;
}

enum {
  METHOD_DESTROY,
  METHOD_ADOPT_SOCKET,
  METHOD_ADOPT_SOCKET_READBUF,
  METHOD_ADOPT_DESCRIPTOR,
  METHOD_NAME_TO_PROTOCOL,
};

static JSValue
lwsjs_vhost_methods(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[], int magic) {
  LWSVhost* vh;
  JSValue ret = JS_UNDEFINED;

  if(!(vh = lwsjs_vhost_data2(ctx, this_val)))
    return JS_EXCEPTION;

  if(!vh->vho && magic != METHOD_DESTROY)
    return JS_ThrowInternalError(ctx, "LWSVhost has been destroyed");

  switch(magic) {
    case METHOD_DESTROY: {
      if(vh->vho) {
        lws_vhost_destroy(vh->vho);
        vh->vho = NULL;
      }

      /* Drop the self-reference vh->info.user holds on this same object
         (see the constructor's failure path and lwsjs_vhost_finalizer) -
         without this, destroy() tears down the native vhost but the JS
         wrapper still keeps itself alive forever. */
      if(vh->info.user) {
        obj_free(JS_GetRuntime(ctx), vh->info.user);
        vh->info.user = NULL;
      }

      ret = JS_TRUE;
      break;
    }

    case METHOD_ADOPT_SOCKET: {
      int32_t arg = to_int32(ctx, argv[0]);

      /*if(wsi_from_fd(lc->ctx, arg))
        return JS_ThrowInternalError(ctx, "socket %" PRIi32 " already adopted", arg);*/

      struct lws* wsi;

      if((wsi = lws_adopt_socket_vhost(vh->vho, arg)))
        ret = lwsjs_socket_create(ctx, wsi);

      break;
    }

    case METHOD_ADOPT_SOCKET_READBUF: {
      int32_t arg = to_int32(ctx, argv[0]);

      /*if(wsi_from_fd(lc->ctx, arg))
        return JS_ThrowInternalError(ctx, "socket %" PRIi32 " already adopted", arg);*/

      size_t len;
      uint8_t* buf;

      if(!(buf = get_buffer(ctx, argc - 1, argv + 1, &len)))
        return JS_ThrowTypeError(ctx, "argument 2 must be an arraybuffer");

      struct lws* wsi;

      if((wsi = lws_adopt_socket_vhost_readbuf(vh->vho, arg, (const char*)buf, len)))
        ret = lwsjs_socket_create(ctx, wsi);

      break;
    }

    case METHOD_ADOPT_DESCRIPTOR: {
      /* lws_adopt_descriptor_vhost() - unlike METHOD_ADOPT_SOCKET above, which is
         always a plain accepted socket adopted in HTTP serving mode - lets
         the caller pick the adoption type (raw/http/udp/ssl, via the
         LWS_ADOPT_* flags) and bind straight to a named vhost protocol
         instead of starting in HTTP mode and upgrading later. */
      int32_t fd = to_int32(ctx, argv[0]);
      int32_t type = argc > 1 ? to_int32(ctx, argv[1]) : LWS_ADOPT_SOCKET;
      const char* vh_prot_name = NULL;
      struct lws *parent = NULL, *wsi;
      lws_sock_file_fd_type u;

      if(argc > 2 && !JS_IsUndefined(argv[2]) && !(vh_prot_name = JS_ToCString(ctx, argv[2])))
        return JS_ThrowTypeError(ctx, "adoptDescriptor: argument 3 must be a string");

      if(argc > 3 && !JS_IsUndefined(argv[3]) && !(parent = lwsjs_socket_wsi(argv[3]))) {
        if(vh_prot_name)
          JS_FreeCString(ctx, vh_prot_name);

        return JS_ThrowTypeError(ctx, "adoptDescriptor: argument 4 must be an LWSSocket");
      }

      if(type & LWS_ADOPT_SOCKET)
        u.sockfd = fd;
      else
        u.filefd = fd;

      wsi = lws_adopt_descriptor_vhost(vh->vho, (lws_adoption_type)type, u, vh_prot_name, parent);

      if(vh_prot_name)
        JS_FreeCString(ctx, vh_prot_name);

      if(wsi)
        ret = lwsjs_socket_create(ctx, wsi);

      break;
    }

    case METHOD_NAME_TO_PROTOCOL: {
      const char* name;

      if((name = JS_ToCString(ctx, argv[0]))) {
        const struct lws_protocols* pro;

        if((pro = lws_vhost_name_to_protocol(vh->vho, name)))
          ret = pro->user ? ptr_obj(ctx, pro->user) : lwsjs_protocol_obj(ctx, pro);
        else
          ret = JS_NULL;

        JS_FreeCString(ctx, name);
      }

      break;
    }
  }

  return ret;
}

enum {
  PROP_TAG,
  PROP_NAME,
  PROP_PORT,
  PROP_LISTEN_PORT,
  PROP_IFACE,
};

static JSValue
lwsjs_vhost_get(JSContext* ctx, JSValueConst this_val, int magic) {
  LWSVhost* vh;
  JSValue ret = JS_UNDEFINED;

  if(!(vh = lwsjs_vhost_data2(ctx, this_val)))
    return JS_EXCEPTION;

  if(!vh->vho)
    return JS_ThrowInternalError(ctx, "LWSVhost has been destroyed");

  switch(magic) {
    case PROP_TAG: {
      ret = JS_NewString(ctx, lws_vh_tag(vh->vho));
      break;
    }

    case PROP_NAME: {
      const char* s;

      if((s = lws_get_vhost_name(vh->vho)))
        ret = JS_NewString(ctx, s);

      break;
    }

    case PROP_PORT: {
      ret = JS_NewInt32(ctx, lws_get_vhost_port(vh->vho));
      break;
    }

    case PROP_LISTEN_PORT: {
      ret = JS_NewInt32(ctx, lws_get_vhost_listen_port(vh->vho));
      break;
    }

    case PROP_IFACE: {
      const char* s;

      if((s = lws_get_vhost_iface(vh->vho)))
        ret = JS_NewString(ctx, s);

      break;
    }
  }

  return ret;
}

static void
lwsjs_vhost_finalizer(JSRuntime* rt, JSValue val) {
  LWSVhost* vh;

  if((vh = lwsjs_vhost_data(val))) {
    lwsjs_context_creation_info_free(rt, &vh->info);

    /* Both are normally already cleared by destroy() (see
       lwsjs_vhost_methods' METHOD_DESTROY) - guarded here for the case
       this finalizes without an explicit destroy() call, e.g. the whole
       JSRuntime tearing down with the vhost still live. */
    if(vh->vho) {
      lws_vhost_destroy(vh->vho);
      vh->vho = NULL;
    }

    if(vh->info.user) {
      obj_free(rt, vh->info.user);
      vh->info.user = NULL;
    }

    js_free_rt(rt, vh);
  }
}

static const JSClassDef lws_vhost_class = {
    "LWSVhost",
    .finalizer = lwsjs_vhost_finalizer,
};

static const JSCFunctionListEntry lws_vhost_proto_funcs[] = {
    JS_CGETSET_MAGIC_FLAGS_DEF("tag", lwsjs_vhost_get, 0, PROP_TAG, JS_PROP_ENUMERABLE),
    JS_CGETSET_MAGIC_DEF("name", lwsjs_vhost_get, 0, PROP_NAME),
    JS_CGETSET_MAGIC_DEF("port", lwsjs_vhost_get, 0, PROP_PORT),
    JS_CGETSET_MAGIC_DEF("listenPort", lwsjs_vhost_get, 0, PROP_LISTEN_PORT),
    JS_CGETSET_MAGIC_DEF("iface", lwsjs_vhost_get, 0, PROP_IFACE),
    JS_CFUNC_MAGIC_DEF("destroy", 0, lwsjs_vhost_methods, METHOD_DESTROY),
    JS_CFUNC_MAGIC_DEF("adoptSocket", 1, lwsjs_vhost_methods, METHOD_ADOPT_SOCKET),
    JS_CFUNC_MAGIC_DEF("adoptSocketReadbuf", 2, lwsjs_vhost_methods, METHOD_ADOPT_SOCKET_READBUF),
    JS_CFUNC_MAGIC_DEF("adoptDescriptor", 1, lwsjs_vhost_methods, METHOD_ADOPT_DESCRIPTOR),
    JS_CFUNC_MAGIC_DEF("nameToProtocol", 1, lwsjs_vhost_methods, METHOD_NAME_TO_PROTOCOL),
    JS_PROP_STRING_DEF("[Symbol.toStringTag]", "LWSVhost", JS_PROP_CONFIGURABLE),
};

int
lwsjs_vhost_init(JSContext* ctx, JSModuleDef* m) {
  JS_NewClassID(&lwsjs_vhost_class_id);
  JS_NewClass(JS_GetRuntime(ctx), lwsjs_vhost_class_id, &lws_vhost_class);

  lwsjs_vhost_proto = JS_NewObjectProto(ctx, JS_NULL);

  JS_SetPropertyFunctionList(ctx, lwsjs_vhost_proto, lws_vhost_proto_funcs, countof(lws_vhost_proto_funcs));

  lwsjs_vhost_ctor = JS_NewCFunction2(ctx, lwsjs_vhost_constructor, "LWSVhost", 0, JS_CFUNC_constructor, 0);
  JS_SetConstructor(ctx, lwsjs_vhost_ctor, lwsjs_vhost_proto);

  if(m) {
    JS_SetModuleExport(ctx, m, "LWSVhost", lwsjs_vhost_ctor);
  }

  return 0;
}

JSValue
lws_vhost_object(JSContext* ctx, struct lws_vhost* vho) {
  void* obj;

  if((obj = lws_get_vhost_user(vho)))
    return ptr_obj(ctx, obj);

  return JS_UNDEFINED;
}
