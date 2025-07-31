#include <quickjs.h>
#include <cutils.h>
#include <list.h>
#include <libwebsockets.h>
#include <lws_config.h>
#include <assert.h>
#include "lws-socket.h"
#include "lws-context.h"
#include "lws.h"

typedef struct lws_protocols LWSProtocols;
typedef struct lws_protocol_vhost_options LWSProtocolVHostOptions;
typedef struct lws_context_creation_info LWSContextCreationInfo;
typedef struct lws_client_connect_info LWSClientConnectInfo;

JSClassID lwsjs_context_class_id;
static JSValue lwsjs_context_proto, lwsjs_context_ctor;

static LWSProtocolVHostOptions* vhost_options_fromarray(JSContext*, JSValueConst);
static void vhost_options_free(JSRuntime*, LWSProtocolVHostOptions*);

static JSValue
lwsjs_sethandler_function(JSContext* ctx, int write) {
  JSValue glob = JS_GetGlobalObject(ctx);
  JSValue os = JS_GetPropertyStr(ctx, glob, "os");
  JS_FreeValue(ctx, glob);
  JSValue fn = JS_GetPropertyStr(ctx, os, write ? "setWriteHandler" : "setReadHandler");
  JS_FreeValue(ctx, os);
  return fn;
}

static void
lwsjs_set_handler(JSContext* ctx, int fd, JSValueConst handler, int write) {
  JSValue fn = lwsjs_sethandler_function(ctx, write);
  JSValue args[2] = {
      JS_NewInt32(ctx, fd),
      handler,
  };
  JSValue ret = JS_Call(ctx, fn, JS_NULL, 2, args);
  JS_FreeValue(ctx, ret);
  JS_FreeValue(ctx, fn);
}

static void
lwsjs_clear_handlers(JSContext* ctx, int fd) {
  lwsjs_set_handler(ctx, fd, JS_NULL, 0);
  lwsjs_set_handler(ctx, fd, JS_NULL, 1);
}

static JSValue
protocol_handler(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic, JSValueConst func_data[]) {
  void* cptr = to_ptr(ctx, func_data[3]);

  struct lws_pollfd lpfd = {
      .fd = to_int32(ctx, func_data[0]),
      .events = to_int32(ctx, func_data[1]),
      .revents = JS_ToBool(ctx, func_data[2]) ? POLLOUT : POLLIN,
  };

  /*JSValue obj = lwsjs_socket_get_by_fd(ctx, lpfd.fd);

  if(!JS_IsObject(obj)) {
    lwsl_user("WARNING: socket %d deleted", lpfd.fd);
    lwsjs_clear_handlers(ctx, lpfd.fd);
  } else*/
  lws_service_fd((struct lws_context*)cptr, &lpfd);

  return JS_UNDEFINED;
}

static int
pollfd_callback(struct lws* wsi, enum lws_callback_reasons reason, void* user, void* in, size_t len) {
  struct lws_protocols const* pro = lws_get_protocol(wsi);
  LWSProtocol* closure = pro ? pro->user : 0;
  JSContext* ctx = closure ? closure->ctx : 0;

  if(!ctx) {
    JSObject* obj = lws_context_user(lws_get_context(wsi));
    LWSContext* lwsctx;

    if((lwsctx = JS_GetOpaque(JS_MKPTR(JS_TAG_OBJECT, obj), lwsjs_context_class_id)))
      ctx = lwsctx->js;
  }

  switch(reason) {
    case LWS_CALLBACK_LOCK_POLL:
    case LWS_CALLBACK_UNLOCK_POLL: return 0;

    case LWS_CALLBACK_DEL_POLL_FD: {
      struct lws_pollargs* x = in;

      lwsjs_set_handler(ctx, x->fd, JS_NULL, 0);
      lwsjs_set_handler(ctx, x->fd, JS_NULL, 1);
      return 0;
    }

    case LWS_CALLBACK_ADD_POLL_FD:
    case LWS_CALLBACK_CHANGE_MODE_POLL_FD: {
      struct lws_pollargs* x = in;

      if(x->events == x->prev_events)
        return 0;

      BOOL write = !!(x->events & POLLOUT);
      JSValueConst data[] = {
          JS_NewInt32(ctx, x->fd),
          JS_NewInt32(ctx, x->events),
          JS_NewBool(ctx, write),
          JS_NewInt64(ctx, (intptr_t)lws_get_context(wsi)),
      };
      JSValue fn = JS_NewCFunctionData(ctx, protocol_handler, 0, 0, countof(data), data);

      if(reason == LWS_CALLBACK_CHANGE_MODE_POLL_FD)
        lwsjs_set_handler(ctx, x->fd, JS_NULL, !write);

      lwsjs_set_handler(ctx, x->fd, fn, write);

      JS_FreeValue(ctx, fn);
      return 0;
    }

    default: break;
  }

  return -1;
}

static JSContext*
wsi_to_js_ctx(struct lws* wsi) {
  struct lws_protocols const* pro = lws_get_protocol(wsi);
  LWSProtocol* closure = pro ? pro->user : 0;
  JSContext* ctx = closure ? closure->ctx : 0;

  if(!ctx) {
    JSObject* obj = lws_context_user(lws_get_context(wsi));
    LWSContext* lwsctx;

    if((lwsctx = JS_GetOpaque(JS_MKPTR(JS_TAG_OBJECT, obj), lwsjs_context_class_id)))
      ctx = lwsctx->js;
  }

  return ctx;
}

static int
http_callback(struct lws* wsi, enum lws_callback_reasons reason, void* user, void* in, size_t len) {

  if(pollfd_callback(wsi, reason, user, in, len) == 0)
    return 0;

  int ret = lws_callback_http_dummy(wsi, reason, user, in, len);

  if(reason == LWS_CALLBACK_WSI_DESTROY) {
    JSContext* ctx;

    if((ctx = wsi_to_js_ctx(wsi)))
      lwsjs_socket_destroy(ctx, wsi);
  }

  return ret;
}

static int
protocol_callback(struct lws* wsi, enum lws_callback_reasons reason, void* user, void* in, size_t len) {
  if(reason == LWS_CALLBACK_OPENSSL_LOAD_EXTRA_CLIENT_VERIFY_CERTS || reason == LWS_CALLBACK_OPENSSL_LOAD_EXTRA_SERVER_VERIFY_CERTS)
    return 0;

  if(pollfd_callback(wsi, reason, user, in, len) == 0)
    return 0;

  struct lws_protocols const* pro = lws_get_protocol(wsi);
  LWSProtocol* closure = pro ? pro->user : 0;
  JSContext* ctx = wsi_to_js_ctx(wsi);
  JSValue* cb = closure ? &closure->callback : 0;

  if(closure && !is_null_or_undefined(closure->callbacks[reason])) {
    cb = &closure->callbacks[reason];
  } else

    switch(reason) {
      case LWS_CALLBACK_FILTER_NETWORK_CONNECTION:
      case LWS_CALLBACK_LOCK_POLL:
      case LWS_CALLBACK_UNLOCK_POLL: return 0;

      case LWS_CALLBACK_DEL_POLL_FD: {
        struct lws_pollargs* x = in;

        lwsjs_set_handler(ctx, x->fd, JS_NULL, 0);
        lwsjs_set_handler(ctx, x->fd, JS_NULL, 1);
        return 0;
      }

      case LWS_CALLBACK_ADD_POLL_FD:
      case LWS_CALLBACK_CHANGE_MODE_POLL_FD: {
        struct lws_pollargs* x = in;
        BOOL write = !!(x->events & POLLOUT);
        JSValueConst data[] = {
            JS_NewInt32(ctx, x->fd),
            JS_NewInt32(ctx, x->events),
            JS_NewBool(ctx, write),
            JS_NewInt64(ctx, (intptr_t)lws_get_context(wsi)),
        };
        JSValue fn = JS_NewCFunctionData(ctx, protocol_handler, 0, 0, countof(data), data);

        if(reason == LWS_CALLBACK_CHANGE_MODE_POLL_FD)
          lwsjs_set_handler(ctx, x->fd, JS_NULL, !write);

        lwsjs_set_handler(ctx, x->fd, fn, write);

        JS_FreeValue(ctx, fn);
        return 0;
      }

      default: break;
    }

  if(((int32_t*)wsi)[58] & 2) {
    // struct lws_vhost* vh = lws_get_vhost(lws_get_parent(wsi));

    return lws_callback_http_dummy(wsi, reason, user, in, len);
  }

  if(is_null_or_undefined(*cb))
    return 0;

  if(reason == LWS_CALLBACK_HTTP_WRITEABLE) {
    JSValue sock = lwsjs_socket_get_or_create(ctx, wsi);
    LWSSocket* s;

    if((s = JS_GetOpaque(sock, lwsjs_socket_class_id)))
      if(s->want_write) {
        s->want_write = FALSE;

        if(!JS_IsUndefined(s->write_handler)) {
          JSValue args[1] = {sock};
          JSValue ret = JS_Call(ctx, s->write_handler, JS_UNDEFINED, countof(args), args);
          JS_FreeValue(ctx, ret);
        }
      }

    JS_FreeValue(ctx, sock);

  } else if(reason == LWS_CALLBACK_FILTER_HTTP_CONNECTION) {
    JSValue sock = lwsjs_socket_get_or_create(ctx, wsi);
    LWSSocket* s;

    if((s = JS_GetOpaque(sock, lwsjs_socket_class_id)))
      if(JS_IsUndefined(s->headers))
        s->headers = lwsjs_socket_headers(ctx, s->wsi);

    JS_FreeValue(ctx, sock);
  }

  if(user && pro->per_session_data_size == sizeof(JSValue)) {
    if(reason == LWS_CALLBACK_WSI_DESTROY) {
      JS_FreeValue(ctx, *(JSValue*)user);
      *(JSValue*)user = JS_MKPTR(0, 0);
    } else if(reason == LWS_CALLBACK_HTTP_BIND_PROTOCOL) {
      *(JSValue*)user = JS_NewObjectProto(ctx, JS_NULL);
    }
  }

  int argi = 1, buffer_index = -1;
  JSValue argv[5] = {
      reason == LWS_CALLBACK_HTTP_BIND_PROTOCOL || reason == LWS_CALLBACK_PROTOCOL_INIT ? JS_NULL : lwsjs_socket_get_or_create(ctx, wsi),
  };

  if(cb == &closure->callback)
    argv[argi++] = JS_NewInt32(ctx, reason);

  /*argv[argi++] = (user && pro->per_session_data_size == sizeof(JSValue) && (JS_VALUE_GET_OBJ(*(JSValue*)user) && JS_VALUE_GET_TAG(*(JSValue*)user) == JS_TAG_OBJECT)) ? *(JSValue*)user : JS_NULL;*/

  if(reason == LWS_CALLBACK_HTTP_CONFIRM_UPGRADE) {
    JSValue sock = lwsjs_socket_get_or_create(ctx, wsi);
    LWSSocket* s;

    if((s = JS_GetOpaque(sock, lwsjs_socket_class_id)))
      if(!strcmp(in, "websocket"))
        s->type = SOCKET_WS;
  }

  if(reason == LWS_CALLBACK_FILTER_HTTP_CONNECTION) {
    JSValue sock = lwsjs_socket_get_or_create(ctx, wsi);
    LWSSocket* s;

    if((s = JS_GetOpaque(sock, lwsjs_socket_class_id)))
      if(!strcmp(in, "ws"))
        s->type = SOCKET_WS;
  }

  if(reason == LWS_CALLBACK_CLIENT_ESTABLISHED || reason == LWS_CALLBACK_FILTER_PROTOCOL_CONNECTION) {
    JSValue sock = lwsjs_socket_get_or_create(ctx, wsi);
    LWSSocket* s;

    if((s = JS_GetOpaque(sock, lwsjs_socket_class_id)))
      s->type = SOCKET_WS;
  }

  if(reason == LWS_CALLBACK_CLIENT_APPEND_HANDSHAKE_HEADER) {
    argv[buffer_index = argi++] = JS_NewArrayBuffer(ctx, *(uint8_t**)in, len, 0, 0, FALSE);
  } else if(reason == LWS_CALLBACK_OPENSSL_PERFORM_SERVER_CERT_VERIFICATION) {
    argv[argi++] = JS_NewInt64(ctx, (int64_t)(intptr_t)in);
    argv[argi++] = JS_NewInt32(ctx, len);
  } else if(reason == LWS_CALLBACK_ESTABLISHED_CLIENT_HTTP) {
    argv[argi++] = JS_NewInt32(ctx, lws_http_client_http_response(wsi));
  } else if(reason == LWS_CALLBACK_CONNECTING) {
    argv[argi++] = JS_NewInt32(ctx, (int32_t)(intptr_t)in);
  } else if(reason == LWS_CALLBACK_WS_PEER_INITIATED_CLOSE) {
    if(len >= 2)
      argv[argi++] = JS_NewInt32(ctx, ntohs(*(uint16_t*)in));

    if(len > 2)
      argv[argi++] = JS_NewArrayBufferCopy(ctx, (const uint8_t*)in + 2, len - 2);

  } else if(in && (len > 0 || reason == LWS_CALLBACK_ADD_HEADERS) && reason != LWS_CALLBACK_FILTER_HTTP_CONNECTION && reason != LWS_CALLBACK_CLIENT_CONNECTION_ERROR) {
    BOOL is_ws = reason == LWS_CALLBACK_CLIENT_RECEIVE || reason == LWS_CALLBACK_RECEIVE;

    if(reason == LWS_CALLBACK_ADD_HEADERS) {
      struct lws_process_html_args* args = in;

      len = args->max_len;
    }

    argv[argi++] = in ? ((!is_ws || lws_frame_is_binary(wsi))) ? JS_NewArrayBufferCopy(ctx, in, len) : JS_NewStringLen(ctx, in, len) : JS_NULL;
    argv[argi++] = JS_NewInt64(ctx, len);
  } else if(in && (len == 0 || reason == LWS_CALLBACK_FILTER_HTTP_CONNECTION || reason == LWS_CALLBACK_CLIENT_CONNECTION_ERROR)) {
    argv[argi++] = JS_NewString(ctx, in);
  }

  JSValue ret = JS_Call(ctx, *cb, JS_NULL, argi, argv);

  for(int i = 0; i < argi; i++) {
    if(buffer_index == argi)
      JS_DetachArrayBuffer(ctx, argv[i]);
    JS_FreeValue(ctx, argv[i]);
  }

  int32_t i = to_int32free(ctx, ret);

  if(reason != LWS_CALLBACK_PROTOCOL_INIT && reason != LWS_CALLBACK_HTTP_BIND_PROTOCOL) {
    JSValue sock = lwsjs_socket_get_or_create(ctx, wsi);
    LWSSocket* s;

    if((s = JS_GetOpaque(sock, lwsjs_socket_class_id)))
      if(s->completed)
        i = -1;

    JS_FreeValue(ctx, sock);
  }

  if(i != 0) {
    int fd = lws_get_socket_fd(wsi);

    if(fd != -1)
      lwsjs_clear_handlers(ctx, fd);

    lws_wsi_close(wsi, LWS_TO_KILL_ASYNC);
    // lws_close_free_wsi(wsi, LWS_CLOSE_STATUS_NOSTATUS, __func__);
  }

  return i;
}

static LWSProtocols
protocol_fromobj(JSContext* ctx, JSValueConst obj) {
  LWSProtocols pro = LWS_PROTOCOL_LIST_TERM;
  LWSProtocol* closure;

  if(!(closure = js_mallocz(ctx, sizeof(LWSProtocol))))
    return pro;

  BOOL is_array = JS_IsArray(ctx, obj);
  JSValue value = is_array ? JS_GetPropertyUint32(ctx, obj, 0) : JS_GetPropertyStr(ctx, obj, "name");
  pro.name = to_stringfree(ctx, value);

  value = is_array ? JS_GetPropertyUint32(ctx, obj, 1) : JS_GetPropertyStr(ctx, obj, "callback");

  closure->ctx = ctx;
  closure->callback = value;
  closure->obj = JS_VALUE_GET_OBJ(JS_DupValue(ctx, obj));

  pro.callback = protocol_callback;
  pro.user = closure;

  lwsjs_get_lws_callbacks(ctx, obj, closure->callbacks);

  pro.per_session_data_size = sizeof(JSValue);

  value = is_array ? JS_GetPropertyUint32(ctx, obj, 2) : lwsjs_get_property(ctx, obj, "rx_buffer_size");
  pro.rx_buffer_size = to_integerfree(ctx, value);

  value = is_array ? JS_GetPropertyUint32(ctx, obj, 3) : JS_GetPropertyStr(ctx, obj, "id");
  pro.id = to_integerfree(ctx, value);

  value = is_array ? JS_GetPropertyUint32(ctx, obj, 4) : lwsjs_get_property(ctx, obj, "tx_packet_size");
  pro.tx_packet_size = to_integerfree(ctx, value);

  return pro;
}

static void
protocol_free(JSRuntime* rt, LWSProtocols* pro) {
  LWSProtocol* closure = pro->user;

  if(closure) {
    JS_FreeValueRT(rt, closure->callback);

    if(closure->obj)
      JS_FreeValueRT(rt, JS_MKPTR(JS_TAG_OBJECT, closure->obj));

    js_free_rt(rt, closure);
  }

  pro->user = 0;
  pro->callback = 0;

  js_free_rt(rt, (char*)pro->name);
}

static const LWSProtocols*
protocols_fromarray(JSContext* ctx, JSValueConst value) {
  if(JS_IsArray(ctx, value)) {
    int32_t len = to_int32free(ctx, JS_GetPropertyStr(ctx, value, "length"));

    if(len > 0) {
      LWSProtocols* pro = js_mallocz(ctx, (len + 2) * sizeof(LWSProtocols));

      pro[0] = (struct lws_protocols){
          "http-only",
          http_callback,
          0,
          0,
          0,
          NULL,
          0,
      };

      for(int32_t i = 0; i < len; i++) {
        JSValue protocol = JS_GetPropertyUint32(ctx, value, i);

        pro[i + 1] = protocol_fromobj(ctx, protocol);

        JS_FreeValue(ctx, protocol);
      }

      return pro;
    }
  }

  return 0;
}

static void
protocols_free(JSRuntime* rt, LWSProtocols* pro) {
  size_t i;

  for(i = 0; pro[i].name; ++i)
    protocol_free(rt, &pro[i]);

  js_free_rt(rt, pro);
}

static struct lws_http_mount*
http_mount_fromobj(JSContext* ctx, JSValueConst obj, const char* name) {
  struct lws_http_mount* mnt;
  JSValue value;

  if(!(mnt = js_mallocz(ctx, sizeof(struct lws_http_mount))))
    return 0;

  if(name) {
    mnt->mountpoint = js_strdup(ctx, name);
    mnt->mountpoint_len = strlen(name);
  }

  if(JS_IsArray(ctx, obj)) {
    int i = 0;

    if(!name) {
      value = JS_GetPropertyUint32(ctx, obj, i++);
      mnt->mountpoint = to_stringfree(ctx, value);
      mnt->mountpoint_len = strlen(mnt->mountpoint);
    }

    value = JS_GetPropertyUint32(ctx, obj, i++);
    mnt->origin = to_stringfree(ctx, value);

    value = JS_GetPropertyUint32(ctx, obj, i++);
    mnt->def = to_stringfree(ctx, value);

    value = JS_GetPropertyUint32(ctx, obj, i++);
    mnt->protocol = to_stringfree(ctx, value);

    value = JS_GetPropertyUint32(ctx, obj, i++);
    mnt->basic_auth_login_file = to_stringfree(ctx, value);

  } else if(JS_IsObject(obj)) {
    value = JS_GetPropertyStr(ctx, obj, "mountpoint");

    mnt->mountpoint = to_stringfree(ctx, value);
    mnt->mountpoint_len = strlen(mnt->mountpoint);

    value = JS_GetPropertyStr(ctx, obj, "origin");
    mnt->origin = to_stringfree(ctx, value);

    value = JS_GetPropertyStr(ctx, obj, "def");
    mnt->def = to_stringfree(ctx, value);

    value = JS_GetPropertyStr(ctx, obj, "protocol");
    mnt->protocol = to_stringfree(ctx, value);

    value = JS_GetPropertyStr(ctx, obj, "cgienv");
    mnt->cgienv = vhost_options_fromarray(ctx, value);
    JS_FreeValue(ctx, value);

    value = lwsjs_get_property(ctx, obj, "extra_mimetypes");
    mnt->extra_mimetypes = vhost_options_fromarray(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, obj, "interpret");
    mnt->interpret = vhost_options_fromarray(ctx, value);
    JS_FreeValue(ctx, value);

    value = lwsjs_get_property(ctx, obj, "cgi_timeout");
    mnt->cgi_timeout = to_integerfree(ctx, value);

    value = lwsjs_get_property(ctx, obj, "cache_max_age");
    mnt->cache_max_age = to_integerfree(ctx, value);

    value = lwsjs_get_property(ctx, obj, "auth_mask");
    mnt->auth_mask = to_integerfree(ctx, value);

    value = lwsjs_get_property(ctx, obj, "cache_reusable");
    mnt->cache_reusable = to_boolfree(ctx, value);

    value = lwsjs_get_property(ctx, obj, "cache_revalidate");
    mnt->cache_revalidate = to_boolfree(ctx, value);

    value = lwsjs_get_property(ctx, obj, "cache_intermediaries");
    mnt->cache_intermediaries = to_boolfree(ctx, value);

    value = lwsjs_get_property(ctx, obj, "cache_no");
    mnt->cache_no = to_boolfree(ctx, value);

    value = lwsjs_get_property(ctx, obj, "origin_protocol");
    mnt->origin_protocol = to_integerfree(ctx, value);

    value = lwsjs_get_property(ctx, obj, "basic_auth_login_file");
    mnt->basic_auth_login_file = to_stringfree(ctx, value);
  }

  return mnt;
}

static const struct lws_http_mount*
http_mounts_fromarray(JSContext* ctx, JSValueConst value) {
  const struct lws_http_mount *mnt = 0, **ptr = &mnt, *tmp;

  if(JS_IsArray(ctx, value)) {
    int32_t len = to_int32free(ctx, JS_GetPropertyStr(ctx, value, "length"));

    if(len > 0) {
      mnt = js_malloc(ctx, sizeof(struct lws_http_mount));

      for(int32_t i = 0; i < len; i++) {
        JSValue mount = JS_GetPropertyUint32(ctx, value, i);

        if((*ptr = tmp = http_mount_fromobj(ctx, mount, 0)))
          ptr = (const struct lws_http_mount**)&(*ptr)->mount_next;

        JS_FreeValue(ctx, mount);

        if(!tmp)
          break;
      }
    }
  } else if(JS_IsObject(value)) {
    JSPropertyEnum* tmp_tab = 0;
    uint32_t len;

    if(!JS_GetOwnPropertyNames(ctx, &tmp_tab, &len, value, JS_GPN_STRING_MASK | JS_GPN_SET_ENUM)) {
      for(uint32_t i = 0; i < len; i++) {
        const char* name = JS_AtomToCString(ctx, tmp_tab[i].atom);
        JSValue mount = JS_GetProperty(ctx, value, tmp_tab[i].atom);

        if((*ptr = tmp = http_mount_fromobj(ctx, mount, name)))
          ptr = (const struct lws_http_mount**)&(*ptr)->mount_next;

        JS_FreeCString(ctx, name);
        JS_FreeValue(ctx, mount);

        if(!tmp)
          break;
      }
    }
  }

  return mnt;
}

static void
http_mounts_free(JSRuntime* rt, struct lws_http_mount* mnt) {
  for(; mnt; mnt = (struct lws_http_mount*)mnt->mount_next) {
    if(mnt->mountpoint) {
      js_free_rt(rt, (char*)mnt->mountpoint);
      mnt->mountpoint = 0;
    }

    if(mnt->origin) {
      js_free_rt(rt, (char*)mnt->origin);
      mnt->origin = 0;
    }

    if(mnt->def) {
      js_free_rt(rt, (char*)mnt->def);
      mnt->def = 0;
    }

    if(mnt->protocol) {
      js_free_rt(rt, (char*)mnt->protocol);
      mnt->protocol = 0;
    }

    if(mnt->cgienv) {
      vhost_options_free(rt, (LWSProtocolVHostOptions*)mnt->cgienv);
      mnt->cgienv = 0;
    }

    if(mnt->extra_mimetypes) {
      vhost_options_free(rt, (LWSProtocolVHostOptions*)mnt->extra_mimetypes);
      mnt->extra_mimetypes = 0;
    }

    if(mnt->interpret) {
      vhost_options_free(rt, (LWSProtocolVHostOptions*)mnt->interpret);
      mnt->interpret = 0;
    }

    if(mnt->basic_auth_login_file) {
      js_free_rt(rt, (char*)mnt->basic_auth_login_file);
      mnt->basic_auth_login_file = 0;
    }
  }
}

static LWSProtocolVHostOptions*
vhost_option_fromobj(JSContext* ctx, JSValueConst obj) {
  LWSProtocolVHostOptions* vho;
  JSValue name = JS_UNDEFINED, value = JS_UNDEFINED, options = JS_UNDEFINED, next = JS_UNDEFINED;

  if(JS_IsArray(ctx, obj)) {
    name = JS_GetPropertyUint32(ctx, obj, 0);
    value = JS_GetPropertyUint32(ctx, obj, 1);
    options = JS_GetPropertyUint32(ctx, obj, 2);
  } else if(JS_IsObject(obj)) {
    name = JS_GetPropertyStr(ctx, obj, "name");
    value = JS_GetPropertyStr(ctx, obj, "value");
    options = JS_GetPropertyStr(ctx, obj, "options");

    if(lwsjs_has_property(ctx, obj, "next"))
      next = JS_GetPropertyStr(ctx, obj, "next");
  }

  if((vho = js_malloc(ctx, sizeof(LWSProtocolVHostOptions)))) {
    vho->name = to_string(ctx, name);
    vho->value = to_string(ctx, value);
    vho->options = vhost_options_fromarray(ctx, options);
    vho->next = JS_IsObject(next) ? vhost_option_fromobj(ctx, next) : NULL;
  }

  JS_FreeValue(ctx, name);
  JS_FreeValue(ctx, value);
  JS_FreeValue(ctx, options);
  JS_FreeValue(ctx, next);
  return vho;
}

static LWSProtocolVHostOptions*
vhost_options_fromarray(JSContext* ctx, JSValueConst value) {
  LWSProtocolVHostOptions *vho = 0, **ptr = &vho, *tmp;

  if(JS_IsArray(ctx, value)) {
    int32_t len = to_int32free(ctx, JS_GetPropertyStr(ctx, value, "length"));

    if(len > 0) {
      for(int32_t i = 0; i < len; i++) {
        JSValue option = JS_GetPropertyUint32(ctx, value, i);

        if((*ptr = tmp = vhost_option_fromobj(ctx, option))) {
          do
            ptr = (LWSProtocolVHostOptions**)&(*ptr)->next;
          while(*ptr);
        }

        JS_FreeValue(ctx, option);

        if(!tmp)
          break;
      }
    }
  } else if(JS_IsObject(value)) {
    vho = vhost_option_fromobj(ctx, value);
  }

  return vho;
}

static void
vhost_options_free(JSRuntime* rt, LWSProtocolVHostOptions* vho) {
  do {
    js_free_rt(rt, (char*)vho->name);
    vho->name = 0;

    js_free_rt(rt, (char*)vho->value);
    vho->value = 0;

    vhost_options_free(rt, (LWSProtocolVHostOptions*)vho->options);
    vho->options = 0;

  } while((vho = (LWSProtocolVHostOptions*)vho->next));
}

static void
client_connect_info_fromobj(JSContext* ctx, JSValueConst obj, LWSClientConnectInfo* ci) {
  JSValue value;

  value = JS_GetPropertyStr(ctx, obj, "context");
  ci->context = JS_GetOpaque(value, lwsjs_context_class_id);
  JS_FreeValue(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "address");
  ci->address = to_stringfree(ctx, value);

  value = lwsjs_get_property(ctx, obj, "port");
  ci->port = to_integerfree(ctx, value);

  value = lwsjs_get_property(ctx, obj, "ssl_connection");
  ci->ssl_connection = to_integerfree(ctx, value);

  if(lwsjs_has_property(ctx, obj, "ssl")) {
    value = lwsjs_get_property(ctx, obj, "ssl");
    ci->ssl_connection |= JS_ToBool(ctx, value) ? LCCSCF_USE_SSL | LCCSCF_ALLOW_SELFSIGNED | LCCSCF_ALLOW_INSECURE | LCCSCF_ALLOW_EXPIRED | LCCSCF_SKIP_SERVER_CERT_HOSTNAME_CHECK : 0;
    JS_FreeValue(ctx, value);
  }

  value = JS_GetPropertyStr(ctx, obj, "path");
  ci->path = to_stringfree(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "host");
  ci->host = to_stringfree(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "origin");
  ci->origin = to_stringfree(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "protocol");
  ci->protocol = to_stringfree(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "method");
  ci->method = to_stringfree(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "iface");
  ci->iface = to_stringfree(ctx, value);

  value = lwsjs_get_property(ctx, obj, "local_port");
  ci->local_port = to_integerfree(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "local_protocol_name");
  ci->local_protocol_name = to_stringfree(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "alpn");
  ci->alpn = to_stringfree(ctx, value);

  value = lwsjs_get_property(ctx, obj, "keep_warm_secs");
  ci->keep_warm_secs = to_integerfree(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "auth_username");
  ci->auth_username = to_stringfree(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "auth_password");
  ci->auth_password = to_stringfree(ctx, value);
}

static void
client_connect_info_free(JSRuntime* rt, LWSClientConnectInfo* ci) {
  if(ci->address)
    js_free_rt(rt, (char*)ci->address);
  if(ci->path)
    js_free_rt(rt, (char*)ci->path);
  if(ci->host)
    js_free_rt(rt, (char*)ci->host);
  if(ci->origin)
    js_free_rt(rt, (char*)ci->origin);
  if(ci->protocol)
    js_free_rt(rt, (char*)ci->protocol);
  if(ci->method)
    js_free_rt(rt, (char*)ci->method);
  if(ci->iface)
    js_free_rt(rt, (char*)ci->iface);
  if(ci->local_protocol_name)
    js_free_rt(rt, (char*)ci->local_protocol_name);
  if(ci->alpn)
    js_free_rt(rt, (char*)ci->alpn);
  if(ci->auth_username)
    js_free_rt(rt, (char*)ci->auth_username);
  if(ci->auth_password)
    js_free_rt(rt, (char*)ci->auth_password);
}

static void
context_creation_info_fromobj(JSContext* ctx, JSValueConst obj, LWSContextCreationInfo* ci) {
  JSValue value;

  value = JS_GetPropertyStr(ctx, obj, "iface");
  ci->iface = to_stringfree(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "vhost_name");
  ci->vhost_name = to_stringfree(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "protocols");
  ci->protocols = protocols_fromarray(ctx, value);
  JS_FreeValue(ctx, value);

#ifdef LWS_ROLE_WS

#endif
#if defined(LWS_ROLE_H1) || defined(LWS_ROLE_H2)
  value = lwsjs_get_property(ctx, obj, "http_proxy_address");
  ci->http_proxy_address = to_stringfree(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "headers");
  ci->headers = vhost_options_fromarray(ctx, value);
  JS_FreeValue(ctx, value);

  value = lwsjs_get_property(ctx, obj, "reject_service_keywords");
  ci->reject_service_keywords = vhost_options_fromarray(ctx, value);
  JS_FreeValue(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "pvo");
  ci->pvo = vhost_options_fromarray(ctx, value);
  JS_FreeValue(ctx, value);

  value = lwsjs_get_property(ctx, obj, "log_filepath");
  ci->log_filepath = to_stringfree(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "mounts");
  ci->mounts = http_mounts_fromarray(ctx, value);
  JS_FreeValue(ctx, value);

  value = lwsjs_get_property(ctx, obj, "server_string");
  ci->server_string = to_stringfree(ctx, value);

  value = lwsjs_get_property(ctx, obj, "error_document_404");
  ci->error_document_404 = to_stringfree(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "port");
  ci->port = to_integerfree(ctx, value);

  value = lwsjs_get_property(ctx, obj, "http_proxy_port");
  ci->http_proxy_port = to_integerfree(ctx, value);

  value = lwsjs_get_property(ctx, obj, "keepalive_timeout");
  ci->keepalive_timeout = to_integerfree(ctx, value);
#endif

#ifdef LWS_WITH_SYS_ASYNC_DNS
#warning LWS_WITH_SYS_ASYNC_DNS

  value = lwsjs_get_property(ctx, obj, "async_dns_servers");
    printf("async_dns_servers: %s\n", JS_ToCString(ctx, value));

  ci->async_dns_servers = (const char**)to_stringarrayfree(ctx, value);
  if(ci->async_dns_servers)
    printf("async_dns_servers: %s\n", ci->async_dns_servers[0]);
#endif

#ifdef LWS_WITH_TLS
  value = lwsjs_get_property(ctx, obj, "ssl_private_key_password");
  ci->ssl_private_key_password = to_stringfree(ctx, value);

  value = lwsjs_get_property(ctx, obj, "ssl_cert_filepath");
  ci->ssl_cert_filepath = to_stringfree(ctx, value);

  value = lwsjs_get_property(ctx, obj, "ssl_private_key_filepath");
  ci->ssl_private_key_filepath = to_stringfree(ctx, value);

  value = lwsjs_get_property(ctx, obj, "ssl_ca_filepath");
  ci->ssl_ca_filepath = to_stringfree(ctx, value);

  value = lwsjs_get_property(ctx, obj, "ssl_cipher_list");
  ci->ssl_cipher_list = to_stringfree(ctx, value);

  value = lwsjs_get_property(ctx, obj, "tls1_3_plus_cipher_list");
  ci->tls1_3_plus_cipher_list = to_stringfree(ctx, value);

  value = lwsjs_get_property(ctx, obj, "client_ssl_private_key_password");
  ci->client_ssl_private_key_password = to_stringfree(ctx, value);

  value = lwsjs_get_property(ctx, obj, "client_ssl_cert_filepath");
  ci->client_ssl_cert_filepath = to_stringfree(ctx, value);

  value = lwsjs_get_property(ctx, obj, "client_ssl_private_key_filepath");
  ci->client_ssl_private_key_filepath = to_stringfree(ctx, value);

  value = lwsjs_get_property(ctx, obj, "client_ssl_ca_filepath");
  ci->client_ssl_ca_filepath = to_stringfree(ctx, value);

  value = lwsjs_get_property(ctx, obj, "client_ssl_cipher_list");
  ci->client_ssl_cipher_list = to_stringfree(ctx, value);

  value = lwsjs_get_property(ctx, obj, "client_tls_1_3_plus_cipher_list");
  ci->client_tls_1_3_plus_cipher_list = to_stringfree(ctx, value);

#endif

#ifdef LWS_WITH_SOCKS5
  value = lwsjs_get_property(ctx, obj, "socks_proxy_address");
  ci->socks_proxy_address = to_stringfree(ctx, value);

  value = lwsjs_get_property(ctx, obj, "socks_proxy_port");
  ci->socks_proxy_port = to_integerfree(ctx, value);

#endif

  value = lwsjs_get_property(ctx, obj, "default_loglevel");
  ci->default_loglevel = to_integerfree(ctx, value);

  value = lwsjs_get_property(ctx, obj, "vh_listen_sockfd");
  ci->vh_listen_sockfd = to_integerfree(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "options");
  ci->options = to_integerfree(ctx, value);

  if(ci->options & LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG) {
    value = lwsjs_get_property(ctx, obj, "listen_accept_role");
    ci->listen_accept_role = to_stringfree(ctx, value);
    value = lwsjs_get_property(ctx, obj, "listen_accept_protocol");
    ci->listen_accept_protocol = to_stringfree(ctx, value);
  }
}

static void
context_creation_info_free(JSRuntime* rt, LWSContextCreationInfo* ci) {
  if(ci->iface)
    js_free_rt(rt, (char*)ci->iface);

  if(ci->protocols)
    protocols_free(rt, (LWSProtocols*)ci->protocols);

  if(ci->http_proxy_address)
    js_free_rt(rt, (char*)ci->http_proxy_address);

  if(ci->headers)
    vhost_options_free(rt, (LWSProtocolVHostOptions*)ci->headers);

  if(ci->reject_service_keywords)
    vhost_options_free(rt, (LWSProtocolVHostOptions*)ci->reject_service_keywords);

  if(ci->pvo)
    vhost_options_free(rt, (LWSProtocolVHostOptions*)ci->pvo);

  if(ci->log_filepath)
    js_free_rt(rt, (char*)ci->log_filepath);

  if(ci->mounts)
    http_mounts_free(rt, (struct lws_http_mount*)ci->mounts);

  if(ci->server_string)
    js_free_rt(rt, (char*)ci->server_string);

  if(ci->error_document_404)
    js_free_rt(rt, (char*)ci->error_document_404);

#ifdef LWS_WITH_SYS_ASYNC_DNS
  if(ci->async_dns_servers) {
    for(size_t i = 0; ci->async_dns_servers[i]; ++i)
      js_free_rt(rt, (char*)ci->async_dns_servers[i]);
    js_free_rt(rt, ci->async_dns_servers);
  }
#endif

#ifdef LWS_WITH_TLS
  if(ci->ssl_private_key_password)
    js_free_rt(rt, (char*)ci->ssl_private_key_password);

  if(ci->ssl_cert_filepath)
    js_free_rt(rt, (char*)ci->ssl_cert_filepath);

  if(ci->ssl_private_key_filepath)
    js_free_rt(rt, (char*)ci->ssl_private_key_filepath);

  if(ci->ssl_ca_filepath)
    js_free_rt(rt, (char*)ci->ssl_ca_filepath);

  if(ci->ssl_cipher_list)
    js_free_rt(rt, (char*)ci->ssl_cipher_list);

  if(ci->tls1_3_plus_cipher_list)
    js_free_rt(rt, (char*)ci->tls1_3_plus_cipher_list);

  if(ci->client_ssl_private_key_password)
    js_free_rt(rt, (char*)ci->client_ssl_private_key_password);

  if(ci->client_ssl_cert_filepath)
    js_free_rt(rt, (char*)ci->client_ssl_cert_filepath);

  if(ci->client_ssl_private_key_filepath)
    js_free_rt(rt, (char*)ci->client_ssl_private_key_filepath);

  if(ci->client_ssl_ca_filepath)
    js_free_rt(rt, (char*)ci->client_ssl_ca_filepath);

  if(ci->client_ssl_cipher_list)
    js_free_rt(rt, (char*)ci->client_ssl_cipher_list);

  if(ci->client_tls_1_3_plus_cipher_list)
    js_free_rt(rt, (char*)ci->client_tls_1_3_plus_cipher_list);
#endif

#ifdef LWS_WITH_SOCKS5
  if(ci->socks_proxy_address)
    js_free_rt(rt, (char*)ci->socks_proxy_address);
#endif

  if(ci->listen_accept_role)
    js_free_rt(rt, (char*)ci->listen_accept_role);

  if(ci->listen_accept_protocol)
    js_free_rt(rt, (char*)ci->listen_accept_protocol);
}

static JSValue
lwsjs_context_constructor(JSContext* ctx, JSValueConst new_target, int argc, JSValueConst argv[]) {
  JSValue proto, obj;
  LWSContext* lc;

  if(!(lc = js_mallocz(ctx, sizeof(LWSContext))))
    return JS_EXCEPTION;

  /* using new_target to get the prototype is necessary when the class is extended. */
  proto = JS_GetPropertyStr(ctx, new_target, "prototype");
  if(JS_IsException(proto))
    proto = JS_DupValue(ctx, lwsjs_context_proto);

  obj = JS_NewObjectProtoClass(ctx, proto, lwsjs_context_class_id);
  JS_FreeValue(ctx, proto);
  if(JS_IsException(obj))
    goto fail;

  if(JS_IsObject(argv[0]))
    context_creation_info_fromobj(ctx, argv[0], &lc->info);

  JS_SetOpaque(obj, lc);

  lc->js = JS_DupContext(ctx);
  lc->info.user = JS_VALUE_GET_OBJ(obj);
  // lc->info.options |= LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT;

  /* This must be called last, because it can trigger callbacks already */
  lc->ctx = lws_create_context(&lc->info);

  return obj;

fail:
  js_free(ctx, lc);
  JS_FreeValue(ctx, obj);
  return JS_EXCEPTION;
}

enum {
  DESTROY = 0,
  ADOPT_SOCKET,
  ADOPT_SOCKET_READBUF,
  CANCEL_SERVICE,
  CLIENT_CONNECT,
  GET_RANDOM,
};

static JSValue
lwsjs_context_methods(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[], int magic) {
  LWSContext* lc;
  JSValue ret = JS_UNDEFINED;

  if(!(lc = JS_GetOpaque2(ctx, this_val, lwsjs_context_class_id)))
    return JS_EXCEPTION;

  switch(magic) {
    case DESTROY: {
      if(lc->ctx) {
        lws_context_destroy(lc->ctx);
        lc->ctx = 0;
        ret = JS_TRUE;
      }

      break;
    }

    case ADOPT_SOCKET: {
      int32_t arg = to_int32(ctx, argv[0]);
      struct lws* wsi;
      LWSSocket* s;

      if((s = lws_get_opaque_user_data(wsi_from_fd(lc->ctx, arg))))
        ret = JS_DupValue(ctx, lwsjs_socket_wrap(ctx, s->wsi));
      else if((wsi = lws_adopt_socket(lc->ctx, arg)))
        ret = JS_DupValue(ctx, lwsjs_socket_wrap(ctx, wsi));

      break;
    }

    case ADOPT_SOCKET_READBUF: {
      int32_t arg = to_int32(ctx, argv[0]);
      struct lws* wsi;
      size_t len;
      uint8_t* buf;
      LWSSocket* s;

      if((s = lws_get_opaque_user_data(wsi_from_fd(lc->ctx, arg))))
        return JS_ThrowInternalError(ctx, "socket %" PRIi32 " already adopted", arg);

      if(!(buf = JS_GetArrayBuffer(ctx, &len, argv[1])))
        return JS_ThrowTypeError(ctx, "argument 2 must be an arraybuffer");

      if(argc > 2) {
        int64_t l = to_int64(ctx, argv[2]);

        if(l >= 0 && l < (int64_t)len)
          len = l;
      }

      if((wsi = lws_adopt_socket_readbuf(lc->ctx, arg, (const char*)buf, len))) {
        LWSSocket* s;

        if((s = lwsjs_socket_new(ctx, wsi)))
          ret = JS_DupValue(ctx, JS_MKPTR(JS_TAG_OBJECT, s->obj));
      }

      break;
    }

    case CANCEL_SERVICE: {
      lws_cancel_service(lc->ctx);
      break;
    }

    case CLIENT_CONNECT: {
      LWSClientConnectInfo cci = {0};
      struct lws *wsi, *wsi2;

      if(JS_IsObject(argv[0]))
        client_connect_info_fromobj(ctx, argv[0], &cci);

      cci.context = lc->ctx;
      cci.pwsi = &wsi2;

      if((wsi = lws_client_connect_via_info(&cci)))
        ret = lwsjs_socket_wrap(ctx, wsi);

      client_connect_info_free(JS_GetRuntime(ctx), &cci);
      break;
    }

    case GET_RANDOM: {
      size_t n;
      uint8_t* p;

      if((p = JS_GetArrayBuffer(ctx, &n, argv[0])))
        lws_get_random(lc->ctx, p, n);

      break;
    }
  }

  return ret;
}

enum {
  PROP_HOSTNAME = 0,
  PROP_VHOST,
  PROP_DEPRECATED,
  PROP_EUID,
  PROP_EGID,
};

static JSValue
lwsjs_context_get(JSContext* ctx, JSValueConst this_val, int magic) {
  LWSContext* lc;
  JSValue ret = JS_UNDEFINED;
  if(!(lc = JS_GetOpaque2(ctx, this_val, lwsjs_context_class_id)))
    return JS_EXCEPTION;

  switch(magic) {
    case PROP_HOSTNAME: {
      const char* s;

      if((s = lws_canonical_hostname(lc->ctx)))
        ret = JS_NewString(ctx, s);

      break;
    }

      /* case PROP_VHOST: {
           const char*s;

           if((s=lws_get_vhost_name(lc->ctx)))
             ret=JS_NewString(ctx, s);

           break;
         }*/

    case PROP_DEPRECATED: {
      ret = JS_NewBool(ctx, lws_context_is_deprecated(lc->ctx));
      break;
    }

    case PROP_EUID:
    case PROP_EGID: {
      uid_t uid;
      gid_t gid;
      lws_get_effective_uid_gid(lc->ctx, &uid, &gid);

      ret = JS_NewInt32(ctx, magic == PROP_EUID ? uid : gid);

      break;
    }
  }

  return ret;
}

static void
lwsjs_context_finalizer(JSRuntime* rt, JSValue val) {
  LWSContext* lc;

  if((lc = JS_GetOpaque(val, lwsjs_context_class_id))) {
    lws_context_destroy(lc->ctx);
    lc->ctx = 0;

    JS_FreeContext(lc->js);
    lc->js = 0;

    context_creation_info_free(rt, &lc->info);

    js_free_rt(rt, lc);
  }
}

static const JSClassDef lws_context_class = {
    "LWSContext",
    .finalizer = lwsjs_context_finalizer,
};

static const JSCFunctionListEntry lws_context_proto_funcs[] = {
    JS_CFUNC_MAGIC_DEF("destroy", 0, lwsjs_context_methods, DESTROY),
    JS_CFUNC_MAGIC_DEF("adoptSocket", 1, lwsjs_context_methods, ADOPT_SOCKET),
    JS_CFUNC_MAGIC_DEF("adoptSocketReadbuf", 2, lwsjs_context_methods, ADOPT_SOCKET_READBUF),
    JS_CFUNC_MAGIC_DEF("cancelService", 0, lwsjs_context_methods, CANCEL_SERVICE),
    JS_CFUNC_MAGIC_DEF("clientConnect", 1, lwsjs_context_methods, CLIENT_CONNECT),
    JS_CFUNC_MAGIC_DEF("getRandom", 1, lwsjs_context_methods, GET_RANDOM),
    JS_CGETSET_MAGIC_DEF("hostname", lwsjs_context_get, 0, PROP_HOSTNAME),
    // JS_CGETSET_MAGIC_DEF("vhost", lwsjs_context_get, 0, PROP_VHOST),
    JS_CGETSET_MAGIC_DEF("deprecated", lwsjs_context_get, 0, PROP_DEPRECATED),
    JS_CGETSET_MAGIC_DEF("euid", lwsjs_context_get, 0, PROP_EUID),
    JS_CGETSET_MAGIC_DEF("egid", lwsjs_context_get, 0, PROP_EGID),
    JS_PROP_STRING_DEF("[Symbol.toStringTag]", "LWSContext", JS_PROP_CONFIGURABLE),
};

int
lwsjs_context_init(JSContext* ctx, JSModuleDef* m) {
  JS_NewClassID(&lwsjs_context_class_id);
  JS_NewClass(JS_GetRuntime(ctx), lwsjs_context_class_id, &lws_context_class);
  lwsjs_context_proto = JS_NewObjectProto(ctx, JS_NULL);
  JS_SetPropertyFunctionList(ctx, lwsjs_context_proto, lws_context_proto_funcs, countof(lws_context_proto_funcs));

  lwsjs_context_ctor = JS_NewCFunction2(ctx, lwsjs_context_constructor, "LWSContext", 1, JS_CFUNC_constructor, 0);
  JS_SetConstructor(ctx, lwsjs_context_ctor, lwsjs_context_proto);

  if(m) {
    JS_SetModuleExport(ctx, m, "LWSContext", lwsjs_context_ctor);
  }

  return 0;
}
