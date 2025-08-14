#include "lws-vhost.h"
#include "lws-socket.h"
#include "js-utils.h"

JSClassID lwsjs_vhost_class_id;
static JSValue lwsjs_vhost_proto, lwsjs_vhost_ctor;

static JSValue
lwsjs_vhost_constructor(JSContext* ctx, JSValueConst new_target, int argc, JSValueConst argv[]) {
  LWSVhost* lv;
  struct lws_context* context;

  if(!(context = lws_context_data(argv[0])))
    return JS_ThrowTypeError(ctx, "argument 1 must be of type LWSContext");

  if(!(lv = js_mallocz(ctx, sizeof(LWSVhost))))
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
    lwsjs_context_creation_info_fromobj(ctx, argv[1], &lv->info);

  lv->info.user = obj_ptr(ctx, obj);

  JS_SetOpaque(obj, lv);

  /* This must be called last, because it can trigger callbacks already */
  lv->vho = lws_create_vhost(context, &lv->info);

  JS_DefinePropertyValueStr(ctx, obj, "info", JS_DupValue(ctx, argv[1]), JS_PROP_CONFIGURABLE);

  return obj;

fail:
  js_free(ctx, lv);
  JS_FreeValue(ctx, obj);
  return JS_EXCEPTION;
}

enum {
  ADOPT_SOCKET,
  ADOPT_SOCKET_READBUF,
  NAME_TO_PROTOCOL,

};

static JSValue
lwsjs_vhost_methods(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[], int magic) {
  LWSVhost* lv;
  JSValue ret = JS_UNDEFINED;

  if(!(lv = lwsjs_vhost_data2(ctx, this_val)))
    return JS_EXCEPTION;

  switch(magic) {

    case ADOPT_SOCKET: {
      int32_t arg = to_int32(ctx, argv[0]);
      struct lws* wsi;

      /*if(wsi_from_fd(lc->ctx, arg))
        return JS_ThrowInternalError(ctx, "socket %" PRIi32 " already adopted", arg);*/

      if((wsi = lws_adopt_socket_vhost(lv->vho, arg)))
        ret = lwsjs_socket_create(ctx, wsi);

      break;
    }

    case ADOPT_SOCKET_READBUF: {
      int32_t arg = to_int32(ctx, argv[0]);
      struct lws* wsi;
      size_t len;
      uint8_t* buf;

      /*if(wsi_from_fd(lc->ctx, arg))
        return JS_ThrowInternalError(ctx, "socket %" PRIi32 " already adopted", arg);*/

      if(!(buf = get_buffer(ctx, argc - 1, argv + 1, &len)))
        return JS_ThrowTypeError(ctx, "argument 2 must be an arraybuffer");

      if((wsi = lws_adopt_socket_vhost_readbuf(lv->vho, arg, (const char*)buf, len)))
        ret = lwsjs_socket_create(ctx, wsi);

      break;
    }

    case NAME_TO_PROTOCOL: {
      const char* name;

      if((name = JS_ToCString(ctx, argv[0]))) {
        const struct lws_protocols* pro;

        if((pro = lws_vhost_name_to_protocol(lv->vho, name)))
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
  LWSVhost* lv;
  JSValue ret = JS_UNDEFINED;

  if(!(lv = lwsjs_vhost_data2(ctx, this_val)))
    return JS_EXCEPTION;

  switch(magic) {
    case PROP_TAG: {
      ret = JS_NewString(ctx, lws_vh_tag(lv->vho));
      break;
    }

    case PROP_NAME: {
      const char* s;

      if((s = lws_get_vhost_name(lv->vho)))
        ret = JS_NewString(ctx, s);

      break;
    }

    case PROP_PORT: {
      ret = JS_NewInt32(ctx, lws_get_vhost_port(lv->vho));
      break;
    }

    case PROP_LISTEN_PORT: {
      ret = JS_NewInt32(ctx, lws_get_vhost_listen_port(lv->vho));
      break;
    }

    case PROP_IFACE: {
      const char* s;

      if((s = lws_get_vhost_iface(lv->vho)))
        ret = JS_NewString(ctx, s);

      break;
    }
  }

  return ret;
}

static void
lwsjs_vhost_finalizer(JSRuntime* rt, JSValue val) {
  LWSVhost* lv;

  if((lv = lwsjs_vhost_data(val))) {
    lwsjs_context_creation_info_free(rt, &lv->info);

    lws_vhost_destroy(lv->vho);
    lv->vho = 0;
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
    JS_CFUNC_MAGIC_DEF("adoptSocket", 1, lwsjs_vhost_methods, ADOPT_SOCKET),
    JS_CFUNC_MAGIC_DEF("adoptSocketReadbuf", 2, lwsjs_vhost_methods, ADOPT_SOCKET_READBUF),
    JS_CFUNC_MAGIC_DEF("nameToProtocol", 1, lwsjs_vhost_methods, NAME_TO_PROTOCOL),
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
  JSObject* obj;

  if((obj = lws_get_vhost_user(vho)))
    return ptr_obj(ctx, obj);

  return JS_UNDEFINED;
}
