#include <quickjs.h>
#include <cutils.h>
#include <list.h>
#include <libwebsockets.h>
#include <assert.h>
#include "lws-socket.h"
#include "lws-context.h"
#include "lws.h"

typedef struct lws_protocols LWSProtocols;
typedef struct lws_protocol_vhost_options LWSProtocolVHostOptions;
typedef struct lws_context_creation_info LWSContextCreationInfo;
typedef struct lws_client_connect_info LWSClientConnectInfo;

typedef struct {
  JSContext* ctx;
  JSValue callback, user;
  JSValue callbacks[LWS_CALLBACK_MQTT_SHADOW_TIMEOUT + 1];
} LWSProtocol;

JSClassID lws_context_class_id;
static JSValue lws_context_proto, lws_context_ctor;

static LWSProtocolVHostOptions* vhost_options_fromarray(JSContext*, JSValueConst);
static void vhost_options_free(JSRuntime*, LWSProtocolVHostOptions*);

static JSValue
js_sethandler_function(JSContext* ctx, int write) {
  JSValue glob = JS_GetGlobalObject(ctx);
  JSValue os = JS_GetPropertyStr(ctx, glob, "os");
  JS_FreeValue(ctx, glob);
  JSValue fn = JS_GetPropertyStr(ctx, os, write ? "setWriteHandler" : "setReadHandler");
  JS_FreeValue(ctx, os);
  return fn;
}

static void
js_set_handler(JSContext* ctx, int fd, JSValueConst handler, int write) {
  JSValue fn = js_sethandler_function(ctx, write);
  JSValue args[2] = {
      JS_NewInt32(ctx, fd),
      handler,
  };
  JSValue ret = JS_Call(ctx, fn, JS_NULL, 2, args);
  JS_FreeValue(ctx, ret);
  JS_FreeValue(ctx, fn);
}

static JSValue
protocol_handler(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic, JSValue* func_data) {
  BOOL write = JS_ToBool(ctx, func_data[2]);
  int64_t i64;
  int32_t fd, events;
  JS_ToInt64(ctx, &i64, func_data[3]);
  JS_ToInt32(ctx, &fd, func_data[0]);
  JS_ToInt32(ctx, &events, func_data[1]);

  struct lws_pollfd lpfd = {.fd = fd, .events = events, .revents = write ? POLLOUT : POLLIN};

  lws_service_fd((struct lws_context*)i64, &lpfd);

  return JS_UNDEFINED;
}

static int
protocol_callback(struct lws* wsi, enum lws_callback_reasons reason, void* user, void* in, size_t len) {
  struct lws_protocols const* pro = lws_get_protocol(wsi);
  LWSProtocol* closure = pro->user;
  JSContext* ctx = closure->ctx;
  JSValue* cb = &closure->callback;

  if(!js_is_null_or_undefined(closure->callbacks[reason])) {
    cb = &closure->callbacks[reason];
  } else

    switch(reason) {
      case LWS_CALLBACK_FILTER_NETWORK_CONNECTION:
      case LWS_CALLBACK_LOCK_POLL:
      case LWS_CALLBACK_UNLOCK_POLL: return 0;

      case LWS_CALLBACK_DEL_POLL_FD: {
        struct lws_pollargs* x = in;

        js_set_handler(ctx, x->fd, JS_NULL, 0);
        js_set_handler(ctx, x->fd, JS_NULL, 1);
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
          js_set_handler(ctx, x->fd, JS_NULL, !write);

        js_set_handler(ctx, x->fd, fn, write);

        JS_FreeValue(ctx, fn);
        return 0;
      }

      default: break;
    }

  if(reason == LWS_CALLBACK_HTTP_WRITEABLE) {
    JSValue sock = js_socket_get_or_create(ctx, wsi);
    LWSSocket* s;

    if((s = JS_GetOpaque(sock, lws_socket_class_id)))
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
    JSValue sock = js_socket_get_or_create(ctx, wsi);
    LWSSocket* s;

    if((s = JS_GetOpaque(sock, lws_socket_class_id)))
      if(JS_IsUndefined(s->headers))
        s->headers = js_socket_headers(ctx, s->wsi);

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

  int argi = 1;
  JSValue argv[5] = {
      js_socket_get_or_create(ctx, wsi),
  };

  if(cb == &closure->callback)
    argv[argi++] = JS_NewInt32(ctx, reason);

  /*  argv[argi++] = (user && pro->per_session_data_size == sizeof(JSValue) && (JS_VALUE_GET_OBJ(*(JSValue*)user) && JS_VALUE_GET_TAG(*(JSValue*)user) == JS_TAG_OBJECT)) ? *(JSValue*)user : JS_NULL;*/

  if(reason == LWS_CALLBACK_FILTER_HTTP_CONNECTION) {
    argv[argi++] = JS_NewStringLen(ctx, in, len);
  } else if(in || len > 0) {
    argv[argi++] = in ? JS_NewArrayBufferCopy(ctx, in, len) : JS_NULL;
    argv[argi++] = JS_NewInt64(ctx, len);
  }

  JSValue ret = JS_Call(ctx, *cb, JS_NULL, argi, argv);

  for(int i = 0; i < argi; i++)
    JS_FreeValue(ctx, argv[i]);

  int32_t i = -1;
  JS_ToInt32(ctx, &i, ret);
  JS_FreeValue(ctx, ret);

  JSValue sock = js_socket_get_or_create(ctx, wsi);
  LWSSocket* s;

  if((s = JS_GetOpaque(sock, lws_socket_class_id)))
    if(s->completed)
      i = -1;

  JS_FreeValue(ctx, sock);

  if(reason == LWS_CALLBACK_WSI_DESTROY)
    socket_destroy(wsi, ctx);

  return i;
}

static LWSProtocols
protocol_fromobj(JSContext* ctx, JSValueConst obj) {
  LWSProtocols pro;
  BOOL is_array = JS_IsArray(ctx, obj);
  JSValue value = is_array ? JS_GetPropertyUint32(ctx, obj, 0) : JS_GetPropertyStr(ctx, obj, "name");
  pro.name = value_to_string(ctx, value);
  JS_FreeValue(ctx, value);

  value = is_array ? JS_GetPropertyUint32(ctx, obj, 1) : JS_GetPropertyStr(ctx, obj, "callback");
  if(JS_IsFunction(ctx, value)) {
    LWSProtocol* closure = 0;

    if((closure = js_mallocz(ctx, sizeof(LWSProtocol)))) {
      closure->ctx = ctx;
      closure->callback = JS_DupValue(ctx, value);
      /*closure->user = is_array ? JS_GetPropertyUint32(ctx, obj, 2) :JS_GetPropertyStr(ctx, obj, "user"); */

      pro.callback = protocol_callback;
      pro.user = closure;

      js_get_lws_callbacks(ctx, obj, closure->callbacks);
    }
  }

  JS_FreeValue(ctx, value);

  // value = js_get_property(ctx, obj, "per_session_data_size");
  pro.per_session_data_size = sizeof(JSValue); // value_to_integer(ctx, value);
  // JS_FreeValue(ctx, value);

  value = is_array ? JS_GetPropertyUint32(ctx, obj, 2) : js_get_property(ctx, obj, "rx_buffer_size");
  pro.rx_buffer_size = value_to_integer(ctx, value);
  JS_FreeValue(ctx, value);

  value = is_array ? JS_GetPropertyUint32(ctx, obj, 3) : JS_GetPropertyStr(ctx, obj, "id");
  pro.id = value_to_integer(ctx, value);
  JS_FreeValue(ctx, value);

  value = is_array ? JS_GetPropertyUint32(ctx, obj, 4) : js_get_property(ctx, obj, "tx_packet_size");
  pro.tx_packet_size = value_to_integer(ctx, value);
  JS_FreeValue(ctx, value);

  return pro;
}

static void
protocol_free(JSRuntime* rt, LWSProtocols* pro) {
  LWSProtocol* closure = pro->user;

  if(closure) {
    JS_FreeValueRT(rt, closure->callback);
    JS_FreeValueRT(rt, closure->user);

    js_free_rt(rt, closure);
  }

  pro->user = 0;
  pro->callback = 0;

  js_free_rt(rt, (char*)pro->name);
}

static const LWSProtocols*
protocols_fromarray(JSContext* ctx, JSValueConst value) {
  if(JS_IsArray(ctx, value)) {
    int32_t len = -1;
    JSValue vlen = JS_GetPropertyStr(ctx, value, "length");
    JS_ToInt32(ctx, &len, vlen);
    JS_FreeValue(ctx, vlen);

    if(len > 0) {
      LWSProtocols* pro = js_mallocz(ctx, (len + 1) * sizeof(LWSProtocols));

      for(int32_t i = 0; i < len; i++) {
        JSValue protocol = JS_GetPropertyUint32(ctx, value, i);

        pro[i] = protocol_fromobj(ctx, protocol);

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
      mnt->mountpoint = value_to_string(ctx, value);
      mnt->mountpoint_len = strlen(mnt->mountpoint);
      JS_FreeValue(ctx, value);
    }

    value = JS_GetPropertyUint32(ctx, obj, i++);
    mnt->origin = value_to_string(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyUint32(ctx, obj, i++);
    mnt->def = value_to_string(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyUint32(ctx, obj, i++);
    mnt->protocol = value_to_string(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyUint32(ctx, obj, i++);
    mnt->basic_auth_login_file = value_to_string(ctx, value);

  } else if(JS_IsObject(obj)) {
    value = JS_GetPropertyStr(ctx, obj, "mountpoint");
    if(JS_IsString(value)) {
      mnt->mountpoint = value_to_string(ctx, value);
      mnt->mountpoint_len = strlen(mnt->mountpoint);
    }
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, obj, "origin");
    mnt->origin = value_to_string(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, obj, "def");
    mnt->def = value_to_string(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, obj, "protocol");
    mnt->protocol = value_to_string(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, obj, "cgienv");
    mnt->cgienv = vhost_options_fromarray(ctx, value);
    JS_FreeValue(ctx, value);

    value = js_get_property(ctx, obj, "extra_mimetypes");
    mnt->extra_mimetypes = vhost_options_fromarray(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, obj, "interpret");
    mnt->interpret = vhost_options_fromarray(ctx, value);
    JS_FreeValue(ctx, value);

    value = js_get_property(ctx, obj, "cgi_timeout");
    mnt->cgi_timeout = value_to_integer(ctx, value);
    JS_FreeValue(ctx, value);

    value = js_get_property(ctx, obj, "cache_max_age");
    mnt->cache_max_age = value_to_integer(ctx, value);
    JS_FreeValue(ctx, value);

    value = js_get_property(ctx, obj, "auth_mask");
    mnt->auth_mask = value_to_integer(ctx, value);
    JS_FreeValue(ctx, value);

    value = js_get_property(ctx, obj, "cache_reusable");
    mnt->cache_reusable = JS_ToBool(ctx, value);
    JS_FreeValue(ctx, value);

    value = js_get_property(ctx, obj, "cache_revalidate");
    mnt->cache_revalidate = JS_ToBool(ctx, value);
    JS_FreeValue(ctx, value);

    value = js_get_property(ctx, obj, "cache_intermediaries");
    mnt->cache_intermediaries = JS_ToBool(ctx, value);
    JS_FreeValue(ctx, value);

    value = js_get_property(ctx, obj, "cache_no");
    mnt->cache_no = JS_ToBool(ctx, value);
    JS_FreeValue(ctx, value);

    value = js_get_property(ctx, obj, "origin_protocol");
    mnt->origin_protocol = value_to_integer(ctx, value);
    JS_FreeValue(ctx, value);

    value = js_get_property(ctx, obj, "basic_auth_login_file");
    mnt->basic_auth_login_file = value_to_string(ctx, value);
    JS_FreeValue(ctx, value);
  }

  return mnt;
}

static const struct lws_http_mount*
http_mounts_fromarray(JSContext* ctx, JSValueConst value) {
  const struct lws_http_mount *mnt = 0, **ptr = &mnt, *tmp;

  if(JS_IsArray(ctx, value)) {
    int32_t len = -1;
    JSValue vlen = JS_GetPropertyStr(ctx, value, "length");
    JS_ToInt32(ctx, &len, vlen);
    JS_FreeValue(ctx, vlen);

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
  JSValue name, value, options;

  if(JS_IsArray(ctx, obj)) {
    name = JS_GetPropertyUint32(ctx, obj, 0);
    value = JS_GetPropertyUint32(ctx, obj, 1);
    options = JS_GetPropertyUint32(ctx, obj, 2);
  } else if(JS_IsObject(obj)) {
    name = JS_GetPropertyStr(ctx, obj, "name");
    value = JS_GetPropertyStr(ctx, obj, "value");
    options = JS_GetPropertyStr(ctx, obj, "options");
  }

  if((vho = js_malloc(ctx, sizeof(LWSProtocolVHostOptions)))) {
    vho->name = value_to_string(ctx, name);
    vho->value = value_to_string(ctx, value);
    vho->options = vhost_options_fromarray(ctx, options);
  }

  JS_FreeValue(ctx, name);
  JS_FreeValue(ctx, value);
  JS_FreeValue(ctx, options);
  return vho;
}

static LWSProtocolVHostOptions*
vhost_options_fromarray(JSContext* ctx, JSValueConst value) {
  LWSProtocolVHostOptions *vho = 0, **ptr = &vho, *tmp;

  if(JS_IsArray(ctx, value)) {
    int32_t len = -1;
    JSValue vlen = JS_GetPropertyStr(ctx, value, "length");
    JS_ToInt32(ctx, &len, vlen);
    JS_FreeValue(ctx, vlen);

    if(len > 0) {
      for(int32_t i = 0; i < len; i++) {
        JSValue option = JS_GetPropertyUint32(ctx, value, i);

        if((*ptr = tmp = vhost_option_fromobj(ctx, option)))
          ptr = (LWSProtocolVHostOptions**)&(*ptr)->next;

        JS_FreeValue(ctx, option);

        if(!tmp)
          break;
      }
    }
  }

  return vho;
}

static void
vhost_options_free(JSRuntime* rt, LWSProtocolVHostOptions* vho) {
  js_free_rt(rt, (char*)vho->name);
  vho->name = 0;

  js_free_rt(rt, (char*)vho->value);
  vho->value = 0;

  vhost_options_free(rt, (LWSProtocolVHostOptions*)vho->next);
  vho->next = 0;

  vhost_options_free(rt, (LWSProtocolVHostOptions*)vho->options);
  vho->options = 0;
}

static void
client_connect_info_fromobj(JSContext* ctx, JSValueConst obj, LWSClientConnectInfo* ci) {
  JSValue value;

  value = JS_GetPropertyStr(ctx, obj, "context");
  ci->context = JS_GetOpaque(value, lws_context_class_id);
  JS_FreeValue(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "address");
  ci->address = value_to_string(ctx, value);
  JS_FreeValue(ctx, value);

  value = js_get_property(ctx, obj, "port");
  ci->port = value_to_integer(ctx, value);
  JS_FreeValue(ctx, value);

  value = js_get_property(ctx, obj, "ssl_connection");
  ci->ssl_connection = value_to_integer(ctx, value);
  JS_FreeValue(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "path");
  ci->path = value_to_string(ctx, value);
  JS_FreeValue(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "host");
  ci->host = value_to_string(ctx, value);
  JS_FreeValue(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "origin");
  ci->origin = value_to_string(ctx, value);
  JS_FreeValue(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "protocol");
  ci->protocol = value_to_string(ctx, value);
  JS_FreeValue(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "iface");
  ci->iface = value_to_string(ctx, value);
  JS_FreeValue(ctx, value);

  value = js_get_property(ctx, obj, "local_port");
  ci->local_port = value_to_integer(ctx, value);
  JS_FreeValue(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "local_protocol_name");
  ci->local_protocol_name = value_to_string(ctx, value);
  JS_FreeValue(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "alpn");
  ci->alpn = value_to_string(ctx, value);
  JS_FreeValue(ctx, value);

  value = js_get_property(ctx, obj, "keep_warm_secs");
  ci->keep_warm_secs = value_to_integer(ctx, value);
  JS_FreeValue(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "auth_username");
  ci->auth_username = value_to_string(ctx, value);
  JS_FreeValue(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "auth_password");
  ci->auth_password = value_to_string(ctx, value);
  JS_FreeValue(ctx, value);
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
  ci->iface = value_to_string(ctx, value);
  JS_FreeValue(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "protocols");
  ci->protocols = protocols_fromarray(ctx, value);
  JS_FreeValue(ctx, value);

#ifdef LWS_ROLE_WS

#endif

#if defined(LWS_ROLE_H1) || defined(LWS_ROLE_H2)
  value = js_get_property(ctx, obj, "http_proxy_address");
  ci->http_proxy_address = value_to_string(ctx, value);
  JS_FreeValue(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "headers");
  ci->headers = vhost_options_fromarray(ctx, value);
  JS_FreeValue(ctx, value);

  value = js_get_property(ctx, obj, "reject_service_keywords");
  ci->reject_service_keywords = vhost_options_fromarray(ctx, value);
  JS_FreeValue(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "pvo");
  ci->pvo = vhost_options_fromarray(ctx, value);
  JS_FreeValue(ctx, value);

  value = js_get_property(ctx, obj, "log_filepath");
  ci->log_filepath = value_to_string(ctx, value);
  JS_FreeValue(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "mounts");
  ci->mounts = http_mounts_fromarray(ctx, value);
  JS_FreeValue(ctx, value);

  value = js_get_property(ctx, obj, "server_string");
  ci->server_string = value_to_string(ctx, value);
  JS_FreeValue(ctx, value);

  value = js_get_property(ctx, obj, "error_document_404");
  ci->error_document_404 = value_to_string(ctx, value);
  JS_FreeValue(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "port");
  ci->port = value_to_integer(ctx, value);
  JS_FreeValue(ctx, value);

  value = js_get_property(ctx, obj, "http_proxy_port");
  ci->http_proxy_port = value_to_integer(ctx, value);
  JS_FreeValue(ctx, value);

  value = js_get_property(ctx, obj, "keepalive_timeout");
  ci->keepalive_timeout = value_to_integer(ctx, value);
  JS_FreeValue(ctx, value);
#endif

#ifdef LWS_WITH_SYS_ASYNC_DNS
  value = js_get_property(ctx, obj, "async_dns_servers");

  if(JS_IsObject(value)) {
    JS_GetPropertyStr(ctx, value, "length");
    JS_ToInt32(ctx, &i, value);
    JS_FreeValue(ctx, value);

    if(i > 0) {
      ci->async_dns_servers = js_mallocz(ctx, (i + 1) * sizeof(const char*));

      for(int32_t j = 0; j < i; i++) {
        JSValue server = JS_GetPropertyUint32(ctx, value, j);

        ci->async_dns_servers[j] = value_to_string(ctx, server);
        JS_FreeValue(ctx, server);
      }

      ci->async_dns_servers[i] = 0;
    }
  }

  JS_FreeValue(ctx, value);
#endif

#ifdef LWS_WITH_TLS
  value = js_get_property(ctx, obj, "ssl_private_key_password");
  ci->ssl_private_key_password = value_to_string(ctx, value);
  JS_FreeValue(ctx, value);

  value = js_get_property(ctx, obj, "ssl_cert_filepath");
  ci->ssl_cert_filepath = value_to_string(ctx, value);
  JS_FreeValue(ctx, value);

  value = js_get_property(ctx, obj, "ssl_private_key_filepath");
  ci->ssl_private_key_filepath = value_to_string(ctx, value);
  JS_FreeValue(ctx, value);

  value = js_get_property(ctx, obj, "ssl_ca_filepath");
  ci->ssl_ca_filepath = value_to_string(ctx, value);
  JS_FreeValue(ctx, value);

  value = js_get_property(ctx, obj, "ssl_cipher_list");
  ci->ssl_cipher_list = value_to_string(ctx, value);
  JS_FreeValue(ctx, value);

  value = js_get_property(ctx, obj, "tls1_3_plus_cipher_list");
  ci->tls1_3_plus_cipher_list = value_to_string(ctx, value);
  JS_FreeValue(ctx, value);

  value = js_get_property(ctx, obj, "client_ssl_private_key_password");
  ci->client_ssl_private_key_password = value_to_string(ctx, value);
  JS_FreeValue(ctx, value);

  value = js_get_property(ctx, obj, "client_ssl_cert_filepath");
  ci->client_ssl_cert_filepath = value_to_string(ctx, value);
  JS_FreeValue(ctx, value);

  value = js_get_property(ctx, obj, "client_ssl_private_key_filepath");
  ci->client_ssl_private_key_filepath = value_to_string(ctx, value);
  JS_FreeValue(ctx, value);

  value = js_get_property(ctx, obj, "client_ssl_ca_filepath");
  ci->client_ssl_ca_filepath = value_to_string(ctx, value);
  JS_FreeValue(ctx, value);

  value = js_get_property(ctx, obj, "client_ssl_cipher_list");
  ci->client_ssl_cipher_list = value_to_string(ctx, value);
  JS_FreeValue(ctx, value);

  value = js_get_property(ctx, obj, "client_tls_1_3_plus_cipher_list");
  ci->client_tls_1_3_plus_cipher_list = value_to_string(ctx, value);
  JS_FreeValue(ctx, value);

#endif

#ifdef LWS_WITH_SOCKS5
  value = js_get_property(ctx, obj, "socks_proxy_address");
  ci->socks_proxy_address = value_to_string(ctx, value);
  JS_FreeValue(ctx, value);

  value = js_get_property(ctx, obj, "socks_proxy_port");
  ci->socks_proxy_port = value_to_integer(ctx, value);
  JS_FreeValue(ctx, value);

#endif

  value = js_get_property(ctx, obj, "default_loglevel");
  ci->default_loglevel = value_to_integer(ctx, value);
  JS_FreeValue(ctx, value);

  value = js_get_property(ctx, obj, "vh_listen_sockfd");
  ci->vh_listen_sockfd = value_to_integer(ctx, value);
  JS_FreeValue(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "options");
  ci->options = value_to_integer(ctx, value);
  JS_FreeValue(ctx, value);
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
}

static JSValue
lws_context_constructor(JSContext* ctx, JSValueConst new_target, int argc, JSValueConst argv[]) {
  JSValue proto, obj;
  LWSContext* lc;

  if(!(lc = js_mallocz(ctx, sizeof(LWSContext))))
    return JS_EXCEPTION;

  /* using new_target to get the prototype is necessary when the class is extended. */
  proto = JS_GetPropertyStr(ctx, new_target, "prototype");
  if(JS_IsException(proto))
    proto = JS_DupValue(ctx, lws_context_proto);

  obj = JS_NewObjectProtoClass(ctx, proto, lws_context_class_id);
  JS_FreeValue(ctx, proto);
  if(JS_IsException(obj))
    goto fail;

  if(JS_IsObject(argv[0]))
    context_creation_info_fromobj(ctx, argv[0], &lc->info);

  lc->info.user = JS_VALUE_GET_OBJ(obj);
  lc->ctx = lws_create_context(&lc->info);

  JS_SetOpaque(obj, lc);

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
  CLIENT_CONNECT,
};

static JSValue
lws_context_methods(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[], int magic) {
  LWSContext* lc;
  JSValue ret = JS_UNDEFINED;

  if(!(lc = JS_GetOpaque2(ctx, this_val, lws_context_class_id)))
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
      int32_t arg = -1;
      JS_ToInt32(ctx, &arg, argv[0]);
      struct lws* wsi;
      LWSSocket* s;

      if((s = socket_get_by_fd(arg)))
        ret = JS_DupValue(ctx, js_socket_wrap(ctx, s->wsi));
      else if((wsi = lws_adopt_socket(lc->ctx, arg)))
        ret = JS_DupValue(ctx, js_socket_wrap(ctx, wsi));

      break;
    }

    case ADOPT_SOCKET_READBUF: {
      int32_t arg = -1;
      JS_ToInt32(ctx, &arg, argv[0]);
      struct lws* wsi;
      size_t len;
      uint8_t* buf;
      LWSSocket* s;

      if((s = socket_get_by_fd(arg)))
        return JS_ThrowInternalError(ctx, "socket %" PRIi32 " already adopted", arg);

      if(!(buf = JS_GetArrayBuffer(ctx, &len, argv[1])))
        return JS_ThrowTypeError(ctx, "argument 2 must be an arraybuffer");

      if(argc > 2) {
        uint64_t l = 0;
        JS_ToIndex(ctx, &l, argv[2]);

        if(l >= 0 && l < len)
          len = l;
      }

      if((wsi = lws_adopt_socket_readbuf(lc->ctx, arg, buf, len))) {
        LWSSocket* s;

        if((s = socket_new(ctx, wsi)))
          ret = JS_DupValue(ctx, JS_MKPTR(JS_TAG_OBJECT, s->obj));
      }

      break;
    }

    case CLIENT_CONNECT: {
      LWSClientConnectInfo cci = {0};
      struct lws* wsi;

      if(JS_IsObject(argv[0]))
        client_connect_info_fromobj(ctx, argv[0], &cci);

      if((wsi = lws_client_connect_via_info(&cci)))
        ret = js_socket_wrap(ctx, wsi);

      client_connect_info_free(JS_GetRuntime(ctx), &cci);
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
lws_context_get(JSContext* ctx, JSValueConst this_val, int magic) {
  LWSContext* lc;
  JSValue ret = JS_UNDEFINED;
  if(!(lc = JS_GetOpaque2(ctx, this_val, lws_context_class_id)))
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
lws_context_finalizer(JSRuntime* rt, JSValue val) {
  LWSContext* lc;

  if((lc = JS_GetOpaque(val, lws_context_class_id))) {
    lws_context_destroy(lc->ctx);
    lc->ctx = 0;

    context_creation_info_free(rt, &lc->info);

    js_free_rt(rt, lc);
  }
}

static const JSClassDef lws_context_class = {
    "LWSContext",
    .finalizer = lws_context_finalizer,
};

static const JSCFunctionListEntry lws_context_proto_funcs[] = {
    JS_CFUNC_MAGIC_DEF("destroy", 0, lws_context_methods, DESTROY),
    JS_CFUNC_MAGIC_DEF("adoptSocket", 1, lws_context_methods, ADOPT_SOCKET),
    JS_CFUNC_MAGIC_DEF("adoptSocketReadbuf", 2, lws_context_methods, ADOPT_SOCKET_READBUF),
    JS_CFUNC_MAGIC_DEF("clientConnect", 1, lws_context_methods, CLIENT_CONNECT),
    JS_CGETSET_MAGIC_DEF("hostname", lws_context_get, 0, PROP_HOSTNAME),
    // JS_CGETSET_MAGIC_DEF("vhost", lws_context_get, 0, PROP_VHOST),
    JS_CGETSET_MAGIC_DEF("deprecated", lws_context_get, 0, PROP_DEPRECATED),
    JS_CGETSET_MAGIC_DEF("euid", lws_context_get, 0, PROP_EUID),
    JS_CGETSET_MAGIC_DEF("egid", lws_context_get, 0, PROP_EGID),
    JS_PROP_STRING_DEF("[Symbol.toStringTag]", "LWSContext", JS_PROP_CONFIGURABLE),
};

int
lws_context_init(JSContext* ctx, JSModuleDef* m) {
  JS_NewClassID(&lws_context_class_id);
  JS_NewClass(JS_GetRuntime(ctx), lws_context_class_id, &lws_context_class);
  lws_context_proto = JS_NewObjectProto(ctx, JS_NULL);
  JS_SetPropertyFunctionList(ctx, lws_context_proto, lws_context_proto_funcs, countof(lws_context_proto_funcs));

  lws_context_ctor = JS_NewCFunction2(ctx, lws_context_constructor, "LWSContext", 1, JS_CFUNC_constructor, 0);
  JS_SetConstructor(ctx, lws_context_ctor, lws_context_proto);

  if(m) {
    JS_SetModuleExport(ctx, m, "LWSContext", lws_context_ctor);
  }

  return 0;
}
