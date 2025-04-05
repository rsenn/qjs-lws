#include <quickjs.h>
#include <cutils.h>
#include <libwebsockets.h>

static JSValue lws_context_proto, lws_context_ctor;
static JSClassID lws_context_class_id;

static struct lws_protocol_vhost_options* lws_context_vh_options(JSContext* ctx, JSValueConst value);
static void lws_context_vh_options_free(JSRuntime* rt, struct lws_protocol_vhost_options* vho);

static const char*
value_to_string(JSContext* ctx, JSValueConst value) {
  if(JS_IsUndefined(value) || JS_IsNull(value))
    return 0;

  const char* s = JS_ToCString(ctx, value);
  char* x = js_strdup(ctx, s);
  JS_FreeCString(ctx, s);
  return x;
}

static const char*
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

static const int64_t
value_to_integer(JSContext* ctx, JSValueConst value) {
  int64_t i = -1;
  JS_ToInt64(ctx, &i, value);
  return i;
}

static JSValue
get_set_handler_function(JSContext* ctx, int write) {
  JSValue glob = JS_GetGlobalObject(ctx);
  JSValue os = JS_GetPropertyStr(ctx, glob, "os");
  JS_FreeValue(ctx, glob);
  JSValue fn = JS_GetPropertyStr(ctx, os, write ? "setWriteHandler" : "setReadHandler");
  JS_FreeValue(ctx, os);
  return fn;
}

static void
set_handler(JSContext* ctx, int fd, JSValueConst handler, int write) {
  JSValue fn = get_set_handler_function(ctx, write);
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

  struct lws_pollfd x = {.fd = fd, .events = events, .revents = write ? POLLOUT : POLLIN};

  lws_service_fd((struct lws_context*)i64, &x);
}

struct protocol_closure {
  JSContext* ctx;
  JSValue callback, user;
};

static int
protocol_callback(struct lws* wsi, enum lws_callback_reasons reason, void* user, void* in, size_t len) {
  struct lws_protocols const* pro = lws_get_protocol(wsi);
  struct protocol_closure* closure = pro->user;
  JSValue session = user && (*(uintptr_t*)user) ? *(JSValue*)user : JS_NULL;

  switch(reason) {
    case LWS_CALLBACK_LOCK_POLL:
    case LWS_CALLBACK_UNLOCK_POLL: break;

    case LWS_CALLBACK_DEL_POLL_FD: {
      struct lws_pollargs* x = in;
      set_handler(closure->ctx, x->fd, JS_NULL, 0);
      set_handler(closure->ctx, x->fd, JS_NULL, 1);
      break;
    }

    case LWS_CALLBACK_ADD_POLL_FD:
    case LWS_CALLBACK_CHANGE_MODE_POLL_FD: {
      struct lws_pollargs* x = in;
      BOOL write = !!(x->events & POLLOUT);
      JSValueConst data[] = {
          JS_NewInt32(closure->ctx, x->fd),
          JS_NewInt32(closure->ctx, x->events),
          JS_NewBool(closure->ctx, write),
          JS_NewInt64(closure->ctx, (intptr_t)lws_get_context(wsi)),
      };
      JSValue fn = JS_NewCFunctionData(closure->ctx, protocol_handler, 0, 0, countof(data), data);

      if(reason == LWS_CALLBACK_CHANGE_MODE_POLL_FD)
        set_handler(closure->ctx, x->fd, JS_NULL, !write);

      set_handler(closure->ctx, x->fd, fn, write);

      JS_FreeValue(closure->ctx, fn);
      break;
    }

    default: {
      if(user && pro->per_session_data_size == sizeof(JSValue)) {
        if(reason == LWS_CALLBACK_WSI_DESTROY) {
          // if(JS_VALUE_GET_PTR(*(JSValue*)user) != 0 || JS_VALUE_GET_TAG(*(JSValue*)user) != 0)
          JS_FreeValue(closure->ctx, *(JSValue*)user);
        } else if(reason == LWS_CALLBACK_HTTP_BIND_PROTOCOL) {
          //   if(JS_VALUE_GET_PTR(*(JSValue*)user) == 0 && JS_VALUE_GET_TAG(*(JSValue*)user) == 0)
          *(JSValue*)user = JS_NewObjectProto(closure->ctx, JS_NULL);
        }
      }

      JSValue argv[] = {
          JS_NewInt32(closure->ctx, reason),
          session,
          in ? JS_NewArrayBufferCopy(closure->ctx, in, len) : JS_NULL,
          JS_NewInt64(closure->ctx, len),
      };
      JSValue ret = JS_Call(closure->ctx, closure->callback, JS_NULL, in ? countof(argv) : 2, argv);
      JS_FreeValue(closure->ctx, argv[0]);
      JS_FreeValue(closure->ctx, argv[1]);
      JS_FreeValue(closure->ctx, argv[2]);
      JS_FreeValue(closure->ctx, argv[3]);

      int32_t i = -1;
      JS_ToInt32(closure->ctx, &i, ret);
      JS_FreeValue(closure->ctx, ret);

      return i;
    }
  }

  return 0;
}

static void
protocol_free(JSRuntime* rt, struct lws_protocols* pro) {
  struct protocol_closure* closure = pro->user;

  if(closure) {
    JS_FreeValueRT(rt, closure->callback);
    JS_FreeValueRT(rt, closure->user);

    js_free_rt(rt, closure);
  }

  pro->user = 0;
  pro->callback = 0;

  js_free_rt(rt, (char*)pro->name);
}

static void
protocols_free(JSRuntime* rt, struct lws_protocols* pro) {
  size_t i;

  for(i = 0; pro[i].name; ++i)
    protocol_free(rt, &pro[i]);

  js_free_rt(rt, pro);
}

static struct lws_protocols
protocol_fromobj(JSContext* ctx, JSValueConst obj) {
  struct lws_protocols pro;
  BOOL is_array = JS_IsArray(ctx, obj);

  JSValue value = is_array ? JS_GetPropertyUint32(ctx, obj, 0) : JS_GetPropertyStr(ctx, obj, "name");
  pro.name = value_to_string(ctx, value);
  JS_FreeValue(ctx, value);

  value = is_array ? JS_GetPropertyUint32(ctx, obj, 1) : JS_GetPropertyStr(ctx, obj, "callback");
  if(JS_IsFunction(ctx, value)) {
    struct protocol_closure* closure = 0;

    if((closure = js_mallocz(ctx, sizeof(struct protocol_closure)))) {
      closure->ctx = ctx;
      closure->callback = JS_DupValue(ctx, value);
      /*closure->user = is_array ? JS_GetPropertyUint32(ctx, obj, 2) :JS_GetPropertyStr(ctx, obj, "user");*/

      pro.callback = protocol_callback;
      pro.user = closure;
    }
  }
  JS_FreeValue(ctx, value);

  // value = JS_GetPropertyStr(ctx, obj, "per_session_data_size");
  pro.per_session_data_size = sizeof(JSValue); // value_to_integer(ctx, value);
  // JS_FreeValue(ctx, value);

  value = is_array ? JS_GetPropertyUint32(ctx, obj, 2) : JS_GetPropertyStr(ctx, obj, "rx_buffer_size");
  pro.rx_buffer_size = value_to_integer(ctx, value);
  JS_FreeValue(ctx, value);

  value = is_array ? JS_GetPropertyUint32(ctx, obj, 3) : JS_GetPropertyStr(ctx, obj, "id");
  pro.id = value_to_integer(ctx, value);
  JS_FreeValue(ctx, value);

  value = is_array ? JS_GetPropertyUint32(ctx, obj, 4) : JS_GetPropertyStr(ctx, obj, "tx_packet_size");
  pro.tx_packet_size = value_to_integer(ctx, value);
  JS_FreeValue(ctx, value);

  return pro;
}

static const struct lws_protocols*
protocols_fromarray(JSContext* ctx, JSValueConst value) {
  struct lws_protocols* pro = 0;

  if(JS_IsArray(ctx, value)) {
    int32_t len = -1;
    JSValue vlen = JS_GetPropertyStr(ctx, value, "length");
    JS_ToInt32(ctx, &len, vlen);
    JS_FreeValue(ctx, vlen);

    if(len > 0) {
      pro = js_mallocz(ctx, (len + 1) * sizeof(struct lws_protocols));

      for(int32_t i = 0; i < len; i++) {
        JSValue protocol = JS_GetPropertyUint32(ctx, value, i);

        pro[i] = protocol_fromobj(ctx, protocol);

        JS_FreeValue(ctx, protocol);
      }
    }
  }

  return pro;
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
    mnt->cgienv = lws_context_vh_options(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, obj, "extra_mimetypes");
    mnt->extra_mimetypes = lws_context_vh_options(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, obj, "interpret");
    mnt->interpret = lws_context_vh_options(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, obj, "cgi_timeout");
    mnt->cgi_timeout = value_to_integer(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, obj, "cache_max_age");
    mnt->cache_max_age = value_to_integer(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, obj, "auth_mask");
    mnt->auth_mask = value_to_integer(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, obj, "cache_reusable");
    mnt->cache_reusable = JS_ToBool(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, obj, "cache_revalidate");
    mnt->cache_revalidate = JS_ToBool(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, obj, "cache_intermediaries");
    mnt->cache_intermediaries = JS_ToBool(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, obj, "cache_no");
    mnt->cache_no = JS_ToBool(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, obj, "origin_protocol");
    mnt->origin_protocol = value_to_integer(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, obj, "basic_auth_login_file");
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
      lws_context_vh_options_free(rt, (struct lws_protocol_vhost_options*)mnt->cgienv);
      mnt->cgienv = 0;
    }
    if(mnt->extra_mimetypes) {
      lws_context_vh_options_free(rt, (struct lws_protocol_vhost_options*)mnt->extra_mimetypes);
      mnt->extra_mimetypes = 0;
    }
    if(mnt->interpret) {
      lws_context_vh_options_free(rt, (struct lws_protocol_vhost_options*)mnt->interpret);
      mnt->interpret = 0;
    }
    if(mnt->basic_auth_login_file) {
      js_free_rt(rt, (char*)mnt->basic_auth_login_file);
      mnt->basic_auth_login_file = 0;
    }
  }
}

static struct lws_protocol_vhost_options*
lws_context_vh_option(JSContext* ctx, JSValueConst obj) {
  struct lws_protocol_vhost_options* vho;
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

  if((vho = js_malloc(ctx, sizeof(struct lws_protocol_vhost_options)))) {
    vho->name = value_to_string(ctx, name);
    vho->value = value_to_string(ctx, value);
    vho->options = lws_context_vh_options(ctx, options);
  }

  JS_FreeValue(ctx, name);
  JS_FreeValue(ctx, value);
  JS_FreeValue(ctx, options);
  return vho;
}

static struct lws_protocol_vhost_options*
lws_context_vh_options(JSContext* ctx, JSValueConst value) {
  struct lws_protocol_vhost_options *vho = 0, **ptr = &vho, *tmp;

  if(JS_IsArray(ctx, value)) {
    int32_t len = -1;
    JSValue vlen = JS_GetPropertyStr(ctx, value, "length");
    JS_ToInt32(ctx, &len, vlen);
    JS_FreeValue(ctx, vlen);

    if(len > 0) {

      for(int32_t i = 0; i < len; i++) {
        JSValue option = JS_GetPropertyUint32(ctx, value, i);

        if((*ptr = tmp = lws_context_vh_option(ctx, option)))
          ptr = (struct lws_protocol_vhost_options**)&(*ptr)->next;

        JS_FreeValue(ctx, option);

        if(!tmp)
          break;
      }
    }
  }

  return vho;
}

static void
lws_context_vh_options_free(JSRuntime* rt, struct lws_protocol_vhost_options* vho) {

  js_free_rt(rt, (char*)vho->name);
  vho->name = 0;
  js_free_rt(rt, (char*)vho->value);
  vho->value = 0;

  lws_context_vh_options_free(rt, (struct lws_protocol_vhost_options*)vho->next);
  vho->next = 0;

  lws_context_vh_options_free(rt, (struct lws_protocol_vhost_options*)vho->options);
  vho->options = 0;
}

struct context_closure {
  struct lws_context* ctx;
  struct lws_context_creation_info info;
};

JSValue
lws_context_constructor(JSContext* ctx, JSValueConst new_target, int argc, JSValueConst argv[]) {
  JSValue proto, obj;
  struct lws_context_creation_info* ci;
  struct context_closure* lc;

  if(!(lc = js_mallocz(ctx, sizeof(struct context_closure))))
    return JS_EXCEPTION;

  ci = &lc->info;

  /* using new_target to get the prototype is necessary when the class is extended. */
  proto = JS_GetPropertyStr(ctx, new_target, "prototype");
  if(JS_IsException(proto))
    proto = JS_DupValue(ctx, lws_context_proto);

  obj = JS_NewObjectProtoClass(ctx, proto, lws_context_class_id);
  JS_FreeValue(ctx, proto);
  if(JS_IsException(obj))
    goto fail;

  if(JS_IsObject(argv[0])) {
    JSValue value;

    value = JS_GetPropertyStr(ctx, argv[0], "iface");
    ci->iface = value_to_string(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, argv[0], "protocols");
    ci->protocols = protocols_fromarray(ctx, value);
    JS_FreeValue(ctx, value);

#if defined(LWS_ROLE_WS)

#endif
#if defined(LWS_ROLE_H1) || defined(LWS_ROLE_H2)
    value = JS_GetPropertyStr(ctx, argv[0], "http_proxy_address");
    ci->http_proxy_address = value_to_string(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, argv[0], "headers");
    ci->headers = lws_context_vh_options(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, argv[0], "reject_service_keywords");
    ci->reject_service_keywords = lws_context_vh_options(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, argv[0], "pvo");
    ci->pvo = lws_context_vh_options(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, argv[0], "log_filepath");
    ci->log_filepath = value_to_string(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, argv[0], "mounts");
    ci->mounts = http_mounts_fromarray(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, argv[0], "server_string");
    ci->server_string = value_to_string(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, argv[0], "error_document_404");
    ci->error_document_404 = value_to_string(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, argv[0], "port");
    ci->port = value_to_integer(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, argv[0], "http_proxy_port");
    ci->http_proxy_port = value_to_integer(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, argv[0], "keepalive_timeout");
    ci->keepalive_timeout = value_to_integer(ctx, value);
    JS_FreeValue(ctx, value);
#endif

#if defined(LWS_WITH_SYS_ASYNC_DNS)
    value = JS_GetPropertyStr(ctx, argv[0], "async_dns_servers");

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

#if defined(LWS_WITH_TLS)
    value = JS_GetPropertyStr(ctx, argv[0], "ssl_private_key_password");
    ci->ssl_private_key_password = value_to_string(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, argv[0], "ssl_cert_filepath");
    ci->ssl_cert_filepath = value_to_string(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, argv[0], "ssl_private_key_filepath");
    ci->ssl_private_key_filepath = value_to_string(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, argv[0], "ssl_ca_filepath");
    ci->ssl_ca_filepath = value_to_string(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, argv[0], "ssl_cipher_list");
    ci->ssl_cipher_list = value_to_string(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, argv[0], "tls1_3_plus_cipher_list");
    ci->tls1_3_plus_cipher_list = value_to_string(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, argv[0], "client_ssl_private_key_password");
    ci->client_ssl_private_key_password = value_to_string(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, argv[0], "client_ssl_cert_filepath");
    ci->client_ssl_cert_filepath = value_to_string(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, argv[0], "client_ssl_private_key_filepath");
    ci->client_ssl_private_key_filepath = value_to_string(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, argv[0], "client_ssl_ca_filepath");
    ci->client_ssl_ca_filepath = value_to_string(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, argv[0], "client_ssl_cipher_list");
    ci->client_ssl_cipher_list = value_to_string(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, argv[0], "client_tls_1_3_plus_cipher_list");
    ci->client_tls_1_3_plus_cipher_list = value_to_string(ctx, value);
    JS_FreeValue(ctx, value);

#endif

#if defined(LWS_WITH_SOCKS5)
    value = JS_GetPropertyStr(ctx, argv[0], "socks_proxy_address");
    ci->socks_proxy_address = value_to_string(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, argv[0], "socks_proxy_port");
    ci->socks_proxy_port = value_to_integer(ctx, value);
    JS_FreeValue(ctx, value);

#endif

#if defined(LWS_WITH_SYS_ASYNC_DNS)
    value = JS_GetPropertyStr(ctx, argv[0], "async_dns_servers");

    if(JS_IsObject(value)) {
      JS_GetPropertyStr(ctx, value, "length");
      JS_ToInt32(ctx, &i, value);
      JS_FreeValue(ctx, value);

      if(i > 0) {
        ci->async_dns_servers = js_malloc(ctx, (i + 1) * sizeof(const char*));

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

    value = JS_GetPropertyStr(ctx, argv[0], "default_loglevel");
    ci->default_loglevel = value_to_integer(ctx, value);
    JS_FreeValue(ctx, value);

    value = JS_GetPropertyStr(ctx, argv[0], "vh_listen_sockfd");
    ci->vh_listen_sockfd = value_to_integer(ctx, value);
    JS_FreeValue(ctx, value);
  }

  ci->user = JS_VALUE_GET_OBJ(obj);

  lc->ctx = lws_create_context(ci);

  JS_SetOpaque(obj, lc);

  return obj;

fail:
  js_free(ctx, lc);
  JS_FreeValue(ctx, obj);
  return JS_EXCEPTION;
}

static void
lws_context_creation_info_free(JSRuntime* rt, struct lws_context_creation_info* ci) {
  if(ci->iface)
    js_free_rt(rt, (char*)ci->iface);
  if(ci->protocols)
    protocols_free(rt, (struct lws_protocols*)ci->protocols);
  if(ci->http_proxy_address)
    js_free_rt(rt, (char*)ci->http_proxy_address);
  if(ci->headers)
    lws_context_vh_options_free(rt, (struct lws_protocol_vhost_options*)ci->headers);
  if(ci->reject_service_keywords)
    lws_context_vh_options_free(rt, (struct lws_protocol_vhost_options*)ci->reject_service_keywords);
  if(ci->pvo)
    lws_context_vh_options_free(rt, (struct lws_protocol_vhost_options*)ci->pvo);
  if(ci->log_filepath)
    js_free_rt(rt, (char*)ci->log_filepath);
  if(ci->mounts)
    http_mounts_free(rt, (struct lws_http_mount*)ci->mounts);
  if(ci->server_string)
    js_free_rt(rt, (char*)ci->server_string);
  if(ci->error_document_404)
    js_free_rt(rt, (char*)ci->error_document_404);
#if defined(LWS_WITH_SYS_ASYNC_DNS)
  if(ci->async_dns_servers) {
    for(size_t i = 0; ci->async_dns_servers[i]; ++i)
      js_free_rt(rt, (char*)ci->async_dns_servers[i]);
    js_free_rt(rt, ci->async_dns_servers);
  }
#endif
#if defined(LWS_WITH_TLS)
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
#if defined(LWS_WITH_SOCKS5)
  if(ci->socks_proxy_address)
    js_free_rt(rt, (char*)ci->socks_proxy_address);
#endif
}

static void
lws_context_finalizer(JSRuntime* rt, JSValue val) {
  struct context_closure* lc;

  if((lc = JS_GetOpaque(val, lws_context_class_id))) {
    lws_context_destroy(lc->ctx);
    lc->ctx = 0;

    lws_context_creation_info_free(rt, &lc->info);

    js_free_rt(rt, lc);
  }
}

static const JSClassDef lws_context_class = {
    "MinnetWebsocket",
    .finalizer = lws_context_finalizer,
};
static const JSCFunctionListEntry lws_context_proto_funcs[] = {
    JS_PROP_STRING_DEF("[Symbol.toStringTag]", "LwsContext", JS_PROP_CONFIGURABLE),
};

#define JS_CONSTANT(c) JS_PROP_INT32_DEF((#c), (c), JS_PROP_ENUMERABLE)

static const JSCFunctionListEntry lws_funcs[] = {
    JS_PROP_INT32_DEF("LWSMPRO_HTTP", LWSMPRO_HTTP, 0),
    JS_PROP_INT32_DEF("LWSMPRO_HTTPS", LWSMPRO_HTTPS, 0),
    JS_PROP_INT32_DEF("LWSMPRO_FILE", LWSMPRO_FILE, 0),
    JS_CONSTANT(LWS_CALLBACK_PROTOCOL_INIT),
    JS_CONSTANT(LWS_CALLBACK_PROTOCOL_DESTROY),
    JS_CONSTANT(LWS_CALLBACK_WSI_CREATE),
    JS_CONSTANT(LWS_CALLBACK_WSI_DESTROY),
    JS_CONSTANT(LWS_CALLBACK_WSI_TX_CREDIT_GET),
    JS_CONSTANT(LWS_CALLBACK_OPENSSL_LOAD_EXTRA_CLIENT_VERIFY_CERTS),
    JS_CONSTANT(LWS_CALLBACK_OPENSSL_LOAD_EXTRA_SERVER_VERIFY_CERTS),
    JS_CONSTANT(LWS_CALLBACK_OPENSSL_PERFORM_CLIENT_CERT_VERIFICATION),
    JS_CONSTANT(LWS_CALLBACK_SSL_INFO),
    JS_CONSTANT(LWS_CALLBACK_OPENSSL_PERFORM_SERVER_CERT_VERIFICATION),
    JS_CONSTANT(LWS_CALLBACK_SERVER_NEW_CLIENT_INSTANTIATED),
    JS_CONSTANT(LWS_CALLBACK_HTTP),
    JS_CONSTANT(LWS_CALLBACK_HTTP_BODY),
    JS_CONSTANT(LWS_CALLBACK_HTTP_BODY_COMPLETION),
    JS_CONSTANT(LWS_CALLBACK_HTTP_FILE_COMPLETION),
    JS_CONSTANT(LWS_CALLBACK_HTTP_WRITEABLE),
    JS_CONSTANT(LWS_CALLBACK_CLOSED_HTTP),
    JS_CONSTANT(LWS_CALLBACK_FILTER_HTTP_CONNECTION),
    JS_CONSTANT(LWS_CALLBACK_ADD_HEADERS),
    JS_CONSTANT(LWS_CALLBACK_VERIFY_BASIC_AUTHORIZATION),
    JS_CONSTANT(LWS_CALLBACK_CHECK_ACCESS_RIGHTS),
    JS_CONSTANT(LWS_CALLBACK_PROCESS_HTML),
    JS_CONSTANT(LWS_CALLBACK_HTTP_BIND_PROTOCOL),
    JS_CONSTANT(LWS_CALLBACK_HTTP_DROP_PROTOCOL),
    JS_CONSTANT(LWS_CALLBACK_HTTP_CONFIRM_UPGRADE),
    JS_CONSTANT(LWS_CALLBACK_ESTABLISHED_CLIENT_HTTP),
    JS_CONSTANT(LWS_CALLBACK_CLOSED_CLIENT_HTTP),
    JS_CONSTANT(LWS_CALLBACK_RECEIVE_CLIENT_HTTP_READ),
    JS_CONSTANT(LWS_CALLBACK_RECEIVE_CLIENT_HTTP),
    JS_CONSTANT(LWS_CALLBACK_COMPLETED_CLIENT_HTTP),
    JS_CONSTANT(LWS_CALLBACK_CLIENT_HTTP_WRITEABLE),
    JS_CONSTANT(LWS_CALLBACK_CLIENT_HTTP_REDIRECT),
    JS_CONSTANT(LWS_CALLBACK_CLIENT_HTTP_BIND_PROTOCOL),
    JS_CONSTANT(LWS_CALLBACK_CLIENT_HTTP_DROP_PROTOCOL),
    JS_CONSTANT(LWS_CALLBACK_ESTABLISHED),
    JS_CONSTANT(LWS_CALLBACK_CLOSED),
    JS_CONSTANT(LWS_CALLBACK_SERVER_WRITEABLE),
    JS_CONSTANT(LWS_CALLBACK_RECEIVE),
    JS_CONSTANT(LWS_CALLBACK_RECEIVE_PONG),
    JS_CONSTANT(LWS_CALLBACK_WS_PEER_INITIATED_CLOSE),
    JS_CONSTANT(LWS_CALLBACK_FILTER_PROTOCOL_CONNECTION),
    JS_CONSTANT(LWS_CALLBACK_CONFIRM_EXTENSION_OKAY),
    JS_CONSTANT(LWS_CALLBACK_WS_SERVER_BIND_PROTOCOL),
    JS_CONSTANT(LWS_CALLBACK_WS_SERVER_DROP_PROTOCOL),
    JS_CONSTANT(LWS_CALLBACK_CLIENT_CONNECTION_ERROR),
    JS_CONSTANT(LWS_CALLBACK_CLIENT_FILTER_PRE_ESTABLISH),
    JS_CONSTANT(LWS_CALLBACK_CLIENT_ESTABLISHED),
    JS_CONSTANT(LWS_CALLBACK_CLIENT_CLOSED),
    JS_CONSTANT(LWS_CALLBACK_CLIENT_APPEND_HANDSHAKE_HEADER),
    JS_CONSTANT(LWS_CALLBACK_CLIENT_RECEIVE),
    JS_CONSTANT(LWS_CALLBACK_CLIENT_RECEIVE_PONG),
    JS_CONSTANT(LWS_CALLBACK_CLIENT_WRITEABLE),
    JS_CONSTANT(LWS_CALLBACK_CLIENT_CONFIRM_EXTENSION_SUPPORTED),
    JS_CONSTANT(LWS_CALLBACK_WS_EXT_DEFAULTS),
    JS_CONSTANT(LWS_CALLBACK_FILTER_NETWORK_CONNECTION),
    JS_CONSTANT(LWS_CALLBACK_WS_CLIENT_BIND_PROTOCOL),
    JS_CONSTANT(LWS_CALLBACK_WS_CLIENT_DROP_PROTOCOL),
    JS_CONSTANT(LWS_CALLBACK_GET_THREAD_ID),
    JS_CONSTANT(LWS_CALLBACK_ADD_POLL_FD),
    JS_CONSTANT(LWS_CALLBACK_DEL_POLL_FD),
    JS_CONSTANT(LWS_CALLBACK_CHANGE_MODE_POLL_FD),
    JS_CONSTANT(LWS_CALLBACK_LOCK_POLL),
    JS_CONSTANT(LWS_CALLBACK_UNLOCK_POLL),
    JS_CONSTANT(LWS_CALLBACK_CGI),
    JS_CONSTANT(LWS_CALLBACK_CGI_TERMINATED),
    JS_CONSTANT(LWS_CALLBACK_CGI_STDIN_DATA),
    JS_CONSTANT(LWS_CALLBACK_CGI_STDIN_COMPLETED),
    JS_CONSTANT(LWS_CALLBACK_CGI_PROCESS_ATTACH),
    JS_CONSTANT(LWS_CALLBACK_SESSION_INFO),
    JS_CONSTANT(LWS_CALLBACK_GS_EVENT),
    JS_CONSTANT(LWS_CALLBACK_HTTP_PMO),
    JS_CONSTANT(LWS_CALLBACK_RAW_PROXY_CLI_RX),
    JS_CONSTANT(LWS_CALLBACK_RAW_PROXY_SRV_RX),
    JS_CONSTANT(LWS_CALLBACK_RAW_PROXY_CLI_CLOSE),
    JS_CONSTANT(LWS_CALLBACK_RAW_PROXY_SRV_CLOSE),
    JS_CONSTANT(LWS_CALLBACK_RAW_PROXY_CLI_WRITEABLE),
    JS_CONSTANT(LWS_CALLBACK_RAW_PROXY_SRV_WRITEABLE),
    JS_CONSTANT(LWS_CALLBACK_RAW_PROXY_CLI_ADOPT),
    JS_CONSTANT(LWS_CALLBACK_RAW_PROXY_SRV_ADOPT),
    JS_CONSTANT(LWS_CALLBACK_RAW_PROXY_CLI_BIND_PROTOCOL),
    JS_CONSTANT(LWS_CALLBACK_RAW_PROXY_SRV_BIND_PROTOCOL),
    JS_CONSTANT(LWS_CALLBACK_RAW_PROXY_CLI_DROP_PROTOCOL),
    JS_CONSTANT(LWS_CALLBACK_RAW_PROXY_SRV_DROP_PROTOCOL),
    JS_CONSTANT(LWS_CALLBACK_RAW_RX),
    JS_CONSTANT(LWS_CALLBACK_RAW_CLOSE),
    JS_CONSTANT(LWS_CALLBACK_RAW_WRITEABLE),
    JS_CONSTANT(LWS_CALLBACK_RAW_ADOPT),
    JS_CONSTANT(LWS_CALLBACK_RAW_CONNECTED),
    JS_CONSTANT(LWS_CALLBACK_RAW_SKT_BIND_PROTOCOL),
    JS_CONSTANT(LWS_CALLBACK_RAW_SKT_DROP_PROTOCOL),
    JS_CONSTANT(LWS_CALLBACK_RAW_ADOPT_FILE),
    JS_CONSTANT(LWS_CALLBACK_RAW_RX_FILE),
    JS_CONSTANT(LWS_CALLBACK_RAW_WRITEABLE_FILE),
    JS_CONSTANT(LWS_CALLBACK_RAW_CLOSE_FILE),
    JS_CONSTANT(LWS_CALLBACK_RAW_FILE_BIND_PROTOCOL),
    JS_CONSTANT(LWS_CALLBACK_RAW_FILE_DROP_PROTOCOL),
    JS_CONSTANT(LWS_CALLBACK_TIMER),
    JS_CONSTANT(LWS_CALLBACK_EVENT_WAIT_CANCELLED),
    JS_CONSTANT(LWS_CALLBACK_CHILD_CLOSING),
    JS_CONSTANT(LWS_CALLBACK_CONNECTING),
    JS_CONSTANT(LWS_CALLBACK_VHOST_CERT_AGING),
    JS_CONSTANT(LWS_CALLBACK_VHOST_CERT_UPDATE),
    JS_CONSTANT(LWS_CALLBACK_MQTT_NEW_CLIENT_INSTANTIATED),
    JS_CONSTANT(LWS_CALLBACK_MQTT_IDLE),
    JS_CONSTANT(LWS_CALLBACK_MQTT_CLIENT_ESTABLISHED),
    JS_CONSTANT(LWS_CALLBACK_MQTT_SUBSCRIBED),
    JS_CONSTANT(LWS_CALLBACK_MQTT_CLIENT_WRITEABLE),
    JS_CONSTANT(LWS_CALLBACK_MQTT_CLIENT_RX),
    JS_CONSTANT(LWS_CALLBACK_MQTT_UNSUBSCRIBED),
    JS_CONSTANT(LWS_CALLBACK_MQTT_DROP_PROTOCOL),
    JS_CONSTANT(LWS_CALLBACK_MQTT_CLIENT_CLOSED),
    JS_CONSTANT(LWS_CALLBACK_MQTT_ACK),
    JS_CONSTANT(LWS_CALLBACK_MQTT_RESEND),
    JS_CONSTANT(LWS_CALLBACK_MQTT_UNSUBSCRIBE_TIMEOUT),
    JS_CONSTANT(LWS_CALLBACK_MQTT_SHADOW_TIMEOUT),
    JS_CONSTANT(LWS_CALLBACK_USER),
    JS_CONSTANT(WSI_TOKEN_GET_URI), /* 0 */
    JS_CONSTANT(WSI_TOKEN_POST_URI),
#if defined(LWS_WITH_HTTP_UNCOMMON_HEADERS) || defined(LWS_HTTP_HEADERS_ALL)
    JS_CONSTANT(WSI_TOKEN_OPTIONS_URI),
#endif
    JS_CONSTANT(WSI_TOKEN_HOST),
    JS_CONSTANT(WSI_TOKEN_CONNECTION),
    JS_CONSTANT(WSI_TOKEN_UPGRADE), /* 5 */
    JS_CONSTANT(WSI_TOKEN_ORIGIN),
#if defined(LWS_ROLE_WS) || defined(LWS_HTTP_HEADERS_ALL)
    JS_CONSTANT(WSI_TOKEN_DRAFT),
#endif
    JS_CONSTANT(WSI_TOKEN_CHALLENGE),
#if defined(LWS_ROLE_WS) || defined(LWS_HTTP_HEADERS_ALL)
    JS_CONSTANT(WSI_TOKEN_EXTENSIONS),
    JS_CONSTANT(WSI_TOKEN_KEY1), /* 10 */
    JS_CONSTANT(WSI_TOKEN_KEY2),
    JS_CONSTANT(WSI_TOKEN_PROTOCOL),
    JS_CONSTANT(WSI_TOKEN_ACCEPT),
    JS_CONSTANT(WSI_TOKEN_NONCE),
#endif
    JS_CONSTANT(WSI_TOKEN_HTTP),
#if defined(LWS_ROLE_H2) || defined(LWS_HTTP_HEADERS_ALL)
    JS_CONSTANT(WSI_TOKEN_HTTP2_SETTINGS), /* 16 */
#endif
    JS_CONSTANT(WSI_TOKEN_HTTP_ACCEPT),
#if defined(LWS_WITH_HTTP_UNCOMMON_HEADERS) || defined(LWS_HTTP_HEADERS_ALL)
    JS_CONSTANT(WSI_TOKEN_HTTP_AC_REQUEST_HEADERS),
#endif
    JS_CONSTANT(WSI_TOKEN_HTTP_IF_MODIFIED_SINCE),
    JS_CONSTANT(WSI_TOKEN_HTTP_IF_NONE_MATCH), /* 20 */
    JS_CONSTANT(WSI_TOKEN_HTTP_ACCEPT_ENCODING),
    JS_CONSTANT(WSI_TOKEN_HTTP_ACCEPT_LANGUAGE),
    JS_CONSTANT(WSI_TOKEN_HTTP_PRAGMA),
    JS_CONSTANT(WSI_TOKEN_HTTP_CACHE_CONTROL),
    JS_CONSTANT(WSI_TOKEN_HTTP_AUTHORIZATION),
    JS_CONSTANT(WSI_TOKEN_HTTP_COOKIE),
    JS_CONSTANT(WSI_TOKEN_HTTP_CONTENT_LENGTH), /* 27 */
    JS_CONSTANT(WSI_TOKEN_HTTP_CONTENT_TYPE),
    JS_CONSTANT(WSI_TOKEN_HTTP_DATE),
    JS_CONSTANT(WSI_TOKEN_HTTP_RANGE),
#if defined(LWS_WITH_HTTP_UNCOMMON_HEADERS) || defined(LWS_ROLE_H2) || defined(LWS_HTTP_HEADERS_ALL)
    JS_CONSTANT(WSI_TOKEN_HTTP_REFERER),
#endif
#if defined(LWS_ROLE_WS) || defined(LWS_HTTP_HEADERS_ALL)
    JS_CONSTANT(WSI_TOKEN_KEY),
    JS_CONSTANT(WSI_TOKEN_VERSION),
    JS_CONSTANT(WSI_TOKEN_SWORIGIN),
#endif
#if defined(LWS_ROLE_H2) || defined(LWS_HTTP_HEADERS_ALL)
    JS_CONSTANT(WSI_TOKEN_HTTP_COLON_AUTHORITY),
    JS_CONSTANT(WSI_TOKEN_HTTP_COLON_METHOD),
    JS_CONSTANT(WSI_TOKEN_HTTP_COLON_PATH),
    JS_CONSTANT(WSI_TOKEN_HTTP_COLON_SCHEME),
    JS_CONSTANT(WSI_TOKEN_HTTP_COLON_STATUS),
#endif

#if defined(LWS_WITH_HTTP_UNCOMMON_HEADERS) || defined(LWS_ROLE_H2) || defined(LWS_HTTP_HEADERS_ALL)
    JS_CONSTANT(WSI_TOKEN_HTTP_ACCEPT_CHARSET),
#endif
    JS_CONSTANT(WSI_TOKEN_HTTP_ACCEPT_RANGES),
#if defined(LWS_WITH_HTTP_UNCOMMON_HEADERS) || defined(LWS_ROLE_H2) || defined(LWS_HTTP_HEADERS_ALL)
    JS_CONSTANT(WSI_TOKEN_HTTP_ACCESS_CONTROL_ALLOW_ORIGIN),
#endif
    JS_CONSTANT(WSI_TOKEN_HTTP_AGE),
    JS_CONSTANT(WSI_TOKEN_HTTP_ALLOW),
    JS_CONSTANT(WSI_TOKEN_HTTP_CONTENT_DISPOSITION),
    JS_CONSTANT(WSI_TOKEN_HTTP_CONTENT_ENCODING),
    JS_CONSTANT(WSI_TOKEN_HTTP_CONTENT_LANGUAGE),
    JS_CONSTANT(WSI_TOKEN_HTTP_CONTENT_LOCATION),
    JS_CONSTANT(WSI_TOKEN_HTTP_CONTENT_RANGE),
    JS_CONSTANT(WSI_TOKEN_HTTP_ETAG),
    JS_CONSTANT(WSI_TOKEN_HTTP_EXPECT),
    JS_CONSTANT(WSI_TOKEN_HTTP_EXPIRES),
    JS_CONSTANT(WSI_TOKEN_HTTP_FROM),
    JS_CONSTANT(WSI_TOKEN_HTTP_IF_MATCH),
    JS_CONSTANT(WSI_TOKEN_HTTP_IF_RANGE),
    JS_CONSTANT(WSI_TOKEN_HTTP_IF_UNMODIFIED_SINCE),
    JS_CONSTANT(WSI_TOKEN_HTTP_LAST_MODIFIED),
    JS_CONSTANT(WSI_TOKEN_HTTP_LINK),
    JS_CONSTANT(WSI_TOKEN_HTTP_LOCATION),
#if defined(LWS_WITH_HTTP_UNCOMMON_HEADERS) || defined(LWS_ROLE_H2) || defined(LWS_HTTP_HEADERS_ALL)
    JS_CONSTANT(WSI_TOKEN_HTTP_MAX_FORWARDS),
    JS_CONSTANT(WSI_TOKEN_HTTP_PROXY_AUTHENTICATE),
    JS_CONSTANT(WSI_TOKEN_HTTP_PROXY_AUTHORIZATION),
#endif
    JS_CONSTANT(WSI_TOKEN_HTTP_REFRESH),
    JS_CONSTANT(WSI_TOKEN_HTTP_RETRY_AFTER),
    JS_CONSTANT(WSI_TOKEN_HTTP_SERVER),
    JS_CONSTANT(WSI_TOKEN_HTTP_SET_COOKIE),
#if defined(LWS_WITH_HTTP_UNCOMMON_HEADERS) || defined(LWS_ROLE_H2) || defined(LWS_HTTP_HEADERS_ALL)
    JS_CONSTANT(WSI_TOKEN_HTTP_STRICT_TRANSPORT_SECURITY),
#endif
    JS_CONSTANT(WSI_TOKEN_HTTP_TRANSFER_ENCODING),
#if defined(LWS_WITH_HTTP_UNCOMMON_HEADERS) || defined(LWS_ROLE_H2) || defined(LWS_HTTP_HEADERS_ALL)
    JS_CONSTANT(WSI_TOKEN_HTTP_USER_AGENT),
    JS_CONSTANT(WSI_TOKEN_HTTP_VARY),
    JS_CONSTANT(WSI_TOKEN_HTTP_VIA),
    JS_CONSTANT(WSI_TOKEN_HTTP_WWW_AUTHENTICATE),
#endif
#if defined(LWS_WITH_HTTP_UNCOMMON_HEADERS) || defined(LWS_HTTP_HEADERS_ALL)
    JS_CONSTANT(WSI_TOKEN_PATCH_URI),
    JS_CONSTANT(WSI_TOKEN_PUT_URI),
    JS_CONSTANT(WSI_TOKEN_DELETE_URI),
#endif
    JS_CONSTANT(WSI_TOKEN_HTTP_URI_ARGS),
#if defined(LWS_WITH_HTTP_UNCOMMON_HEADERS) || defined(LWS_HTTP_HEADERS_ALL)
    JS_CONSTANT(WSI_TOKEN_PROXY),
    JS_CONSTANT(WSI_TOKEN_HTTP_X_REAL_IP),
#endif
    JS_CONSTANT(WSI_TOKEN_HTTP1_0),
    JS_CONSTANT(WSI_TOKEN_X_FORWARDED_FOR),
    JS_CONSTANT(WSI_TOKEN_CONNECT),
    JS_CONSTANT(WSI_TOKEN_HEAD_URI),
#if defined(LWS_WITH_HTTP_UNCOMMON_HEADERS) || defined(LWS_ROLE_H2) || defined(LWS_HTTP_HEADERS_ALL)
    JS_CONSTANT(WSI_TOKEN_TE),
    JS_CONSTANT(WSI_TOKEN_REPLAY_NONCE), /* ACME */
#endif
#if defined(LWS_ROLE_H2) || defined(LWS_HTTP_HEADERS_ALL)
    JS_CONSTANT(WSI_TOKEN_COLON_PROTOCOL),
#endif
    JS_CONSTANT(WSI_TOKEN_X_AUTH_TOKEN),
    JS_CONSTANT(WSI_TOKEN_DSS_SIGNATURE),
    JS_CONSTANT(_WSI_TOKEN_CLIENT_SENT_PROTOCOLS),
    JS_CONSTANT(_WSI_TOKEN_CLIENT_PEER_ADDRESS),
    JS_CONSTANT(_WSI_TOKEN_CLIENT_URI),
    JS_CONSTANT(_WSI_TOKEN_CLIENT_HOST),
    JS_CONSTANT(_WSI_TOKEN_CLIENT_ORIGIN),
    JS_CONSTANT(_WSI_TOKEN_CLIENT_METHOD),
    JS_CONSTANT(_WSI_TOKEN_CLIENT_IFACE),
    JS_CONSTANT(_WSI_TOKEN_CLIENT_LOCALPORT),
    JS_CONSTANT(_WSI_TOKEN_CLIENT_ALPN),
    JS_CONSTANT(WSI_TOKEN_COUNT),
    JS_CONSTANT(WSI_TOKEN_NAME_PART),
#if defined(LWS_WITH_CUSTOM_HEADERS) || defined(LWS_HTTP_HEADERS_ALL)
    JS_CONSTANT(WSI_TOKEN_UNKNOWN_VALUE_PART),
#endif
    JS_CONSTANT(WSI_TOKEN_SKIPPING),
    JS_CONSTANT(WSI_TOKEN_SKIPPING_SAW_CR),
    JS_CONSTANT(WSI_PARSING_COMPLETE),
    JS_CONSTANT(WSI_INIT_TOKEN_MUXURL),
};

int
lws_context_init(JSContext* ctx, JSModuleDef* m) {
  JS_NewClassID(&lws_context_class_id);
  JS_NewClass(JS_GetRuntime(ctx), lws_context_class_id, &lws_context_class);
  lws_context_proto = JS_NewObject(ctx);
  JS_SetPropertyFunctionList(ctx, lws_context_proto, lws_context_proto_funcs, countof(lws_context_proto_funcs));

  lws_context_ctor = JS_NewCFunction2(ctx, lws_context_constructor, "MinnetRequest", 1, JS_CFUNC_constructor, 0);
  JS_SetConstructor(ctx, lws_context_ctor, lws_context_proto);

  if(m) {
    JS_SetModuleExport(ctx, m, "LwsContext", lws_context_ctor);
    JS_SetModuleExportList(ctx, m, lws_funcs, countof(lws_funcs));
  }

  return 0;
}

__attribute__((visibility("default"))) JSModuleDef*
js_init_module(JSContext* ctx, const char* module_name) {
  JSModuleDef* m;

  if((m = JS_NewCModule(ctx, module_name, lws_context_init))) {
    JS_AddModuleExport(ctx, m, "LwsContext");
    JS_AddModuleExportList(ctx, m, lws_funcs, countof(lws_funcs));
  }

  return m;
}
