#define _XOPEN_SOURCE 500
#include <quickjs.h>
#include <cutils.h>
#include <list.h>
#include <libwebsockets.h>
#include <lws_config.h>
#include <assert.h>
#include <limits.h>
#include <stdlib.h>
#include "lws-socket.h"
#include "lws-context.h"
#include "lws-sockaddr46.h"
#include "lws-tls.h"
#include "lws.h"
#include "js-utils.h"
#include "iohandler.h"
#ifdef USE_EPOLL
#include "lws-epoll.h"
#endif

#define LWS_PLUGIN_STATIC

#ifdef PLUGIN_PROTOCOL_DEADDROP
#include "libwebsockets/plugins/deaddrop/protocol_lws_deaddrop.c"
#endif
#ifdef PLUGIN_PROTOCOL_RAW_PROXY
#include "libwebsockets/plugins/raw-proxy/protocol_lws_raw_proxy.c"
#endif
#ifdef PLUGIN_PROTOCOL_FULLTEXT_DEMO
#include "libwebsockets/plugins/protocol_fulltext_demo.c"
#endif
/*#ifdef PLUGIN_PROTOCOL_LWS_STATUS
#include "libwebsockets/plugins/protocol_lws_status.c"
#endif*/
#ifdef PLUGIN_PROTOCOL_LWS_ACME_CLIENT
#include "libwebsockets/plugins/acme-client/protocol_lws_acme_client.c"
#endif
#ifdef PLUGIN_PROTOCOL_LWS_SSHD_DEMO
#include "libwebsockets/plugins/protocol_lws_sshd_demo.c"
#endif
#ifdef PLUGIN_PROTOCOL_DUMB_INCREMENT
#include "libwebsockets/plugins/protocol_dumb_increment.c"
#endif
#ifdef PLUGIN_PROTOCOL_MIRROR
#include "libwebsockets/plugins/protocol_lws_mirror.c"
#endif
#ifdef PLUGIN_PROTOCOL_LWS_RAW_SSHD
#include "libwebsockets/plugins/ssh-base/sshd.c"
#endif
#ifdef PLUGIN_PROTOCOL_RAW_TEST
#include "libwebsockets/plugins/protocol_lws_raw_test.c"
#endif

typedef struct lws_protocols LWSProtocols;

static int callback_pollfd(struct lws*, enum lws_callback_reasons, void*, void*, size_t);
static int callback_js(struct lws*, enum lws_callback_reasons, void*, void*, size_t);
static int callback_http(struct lws*, enum lws_callback_reasons, void*, void*, size_t);
static int callback_protocol(struct lws*, enum lws_callback_reasons, void*, void*, size_t);
static void patch_system_vhost_pollfd(struct lws_context*);
static void schedule_service_tick(LWSContext*, int);
static void cancel_service_tick(LWSContext*);
static JSValue callback_c(JSContext*, JSValueConst, int, JSValueConst[], int, void*);

static struct lws_protocol_vhost_options* vhost_options_from(JSContext*, JSValueConst);
static struct lws_protocol_vhost_options* vhost_options_fromfree(JSContext*, JSValue);

static void vhost_options_free(JSRuntime*, struct lws_protocol_vhost_options*);

JSClassID lwsjs_context_class_id;
static JSValue lwsjs_context_proto, lwsjs_context_ctor;

static JSValue
protocol_handler(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic, JSValueConst func_data[]) {
  struct lws_context* lws_ctx = to_ptr(ctx, func_data[3]);
  struct lws_pollfd lpfd = {
      .fd = to_int32(ctx, func_data[0]),
      .events = to_int32(ctx, func_data[1]),
      .revents = JS_ToBool(ctx, func_data[2]) ? POLLOUT : POLLIN,
  };

  lws_service_fd(lws_ctx, &lpfd);

  /*
   * A serviced wsi may still have buffered data left to parse (e.g. a
   * full response that arrived in one read(), where lws only advances
   * its role state machine one step per lws_service_fd() call) or other
   * work pending that isn't tied to new socket activity. lws calls this
   * "forced service": with lws's own poll()/libuv/libev loops it's
   * handled internally, but external-poll integrations (this one) must
   * drive it explicitly, or such a wsi silently waits forever for a
   * poll() event that will never come - see lws_service_adjust_timeout()
   * in lws-service.h.
   */
  while(lws_service_adjust_timeout(lws_ctx, 1, 0) == 0)
    lws_service_tsi(lws_ctx, -1, 0);

  return JS_UNDEFINED;
}

/*
 * Base interval (ms) for the periodic forced-service tick below. The
 * forced-service check in protocol_handler() above only runs when some fd
 * belonging to this context happens to fire - but lws can leave a wsi
 * needing service (e.g. a scheduled retry/timeout, or an internal state
 * that couldn't be resolved from within a single lws_service_fd() call)
 * with no new socket activity ever occurring to trigger that check again.
 * This periodic tick is the safety net: it re-checks regardless of fd
 * activity, same as lws's own poll()/libuv/libev loops do internally.
 */
#define SERVICE_TICK_MS 250

static JSValue
service_tick(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic, JSValueConst func_data[]) {
  LWSContext* lc = to_ptr(ctx, func_data[0]);

  /* The timer that invoked this callback has already fired (and
     quickjs-libc frees its own OSTimer state internally once it does) -
     drop our reference to it before schedule_service_tick() below
     overwrites service_timer_id with the next one. */
  JS_FreeValue(ctx, lc->service_timer_id);
  lc->service_timer_id = JS_UNDEFINED;

  if(!lc->ctx)
    return JS_UNDEFINED;

  if(lws_service_adjust_timeout(lc->ctx, SERVICE_TICK_MS, 0) == 0) {
    lws_service_tsi(lc->ctx, -1, 0);
    schedule_service_tick(lc, 1);
  } else {
    schedule_service_tick(lc, SERVICE_TICK_MS);
  }

  return JS_UNDEFINED;
}

static void
schedule_service_tick(LWSContext* lc, int delay_ms) {
  JSValue glob = JS_GetGlobalObject(lc->js);
  JSValue os = JS_GetPropertyStr(lc->js, glob, "os");
  JS_FreeValue(lc->js, glob);
  JSValue fn = JS_GetPropertyStr(lc->js, os, "setTimeout");
  JS_FreeValue(lc->js, os);

  JSValueConst data[] = {JS_NewInt64(lc->js, (intptr_t)lc)};
  JSValue cb = JS_NewCFunctionData(lc->js, service_tick, 0, 0, countof(data), data);

  JSValue args[2] = {cb, JS_NewInt32(lc->js, delay_ms)};

  /* os.setTimeout() returns an opaque "OSTimer" JS object in this
     quickjs-libc, not a plain numeric id (unlike, say, Node's timer
     handles being coercible to a number) - JS_ToInt32-ing it throws a
     stray, never-checked "toPrimitive" TypeError, since the object has
     no valueOf/toString. Keep the object itself; it goes back into
     os.clearTimeout() unchanged in cancel_service_tick(). */
  lc->service_timer_id = JS_Call(lc->js, fn, JS_NULL, 2, args);

  JS_FreeValue(lc->js, cb);
  JS_FreeValue(lc->js, fn);
}

static void
cancel_service_tick(LWSContext* lc) {
  if(JS_IsUndefined(lc->service_timer_id) || !lc->js)
    return;

  JSValue glob = JS_GetGlobalObject(lc->js);
  JSValue os = JS_GetPropertyStr(lc->js, glob, "os");
  JS_FreeValue(lc->js, glob);
  JSValue fn = JS_GetPropertyStr(lc->js, os, "clearTimeout");
  JS_FreeValue(lc->js, os);

  JSValue ret = JS_Call(lc->js, fn, JS_NULL, 1, &lc->service_timer_id);

  JS_FreeValue(lc->js, ret);
  JS_FreeValue(lc->js, fn);

  JS_FreeValue(lc->js, lc->service_timer_id);
  lc->service_timer_id = JS_UNDEFINED;
}

JSValue
protocol_obj(JSContext* ctx, const LWSProtocols* proto) {
  JSValue ret = JS_UNDEFINED;

  /*if(proto->user)
    return ptr_obj(ctx, ((LWSProtocol*)proto->user)->obj);*/

  ret = JS_NewObjectProto(ctx, JS_NULL);

  JS_SetPropertyStr(ctx, ret, "name", JS_NewString(ctx, proto->name));
  JS_SetPropertyStr(ctx, ret, "perSessionDataSize", JS_NewUint32(ctx, proto->per_session_data_size));
  JS_SetPropertyStr(ctx, ret, "rxBufferSize", JS_NewUint32(ctx, proto->rx_buffer_size));
  JS_SetPropertyStr(ctx, ret, "id", JS_NewUint32(ctx, proto->id));
  JS_SetPropertyStr(ctx, ret, "txPacketSize", JS_NewUint32(ctx, proto->tx_packet_size));

  JSValue cb = JS_NULL;

  if(proto->callback)
    cb = js_function_cclosure(ctx, callback_c, 4, 0, (void*)proto, 0);

  JS_SetPropertyStr(ctx, ret, "callback", cb);

  return ret;
}

static LWSProtocols
protocol_from(JSContext* ctx, JSValueConst obj) {
  LWSProtocols pro = {0};
  LWSProtocol* closure;

  if(!(closure = js_mallocz(ctx, sizeof(LWSProtocol))))
    return pro;

  BOOL is_array = JS_IsArray(ctx, obj);
  JSValue value = is_array ? JS_GetPropertyUint32(ctx, obj, 0) : JS_GetPropertyStr(ctx, obj, "name");
  pro.name = to_stringfree(ctx, value);

  value = is_array ? JS_GetPropertyUint32(ctx, obj, 1) : JS_GetPropertyStr(ctx, obj, "callback");

  closure->ctx = ctx;
  closure->callback = value;
  closure->obj = obj_ptr(ctx, obj);

  pro.callback = callback_protocol;
  pro.user = closure;

  lwsjs_get_lws_callbacks(ctx, obj, closure->callbacks, countof(closure->callbacks));

  pro.per_session_data_size = sizeof(JSValue);

  value = is_array ? JS_GetPropertyUint32(ctx, obj, 2) : js_get_property(ctx, obj, "rx_buffer_size");
  pro.rx_buffer_size = to_integerfree(ctx, value);

  value = is_array ? JS_GetPropertyUint32(ctx, obj, 3) : JS_GetPropertyStr(ctx, obj, "id");
  pro.id = to_integerfree(ctx, value);

  value = is_array ? JS_GetPropertyUint32(ctx, obj, 4) : js_get_property(ctx, obj, "tx_packet_size");
  pro.tx_packet_size = to_integerfree(ctx, value);

  return pro;
}

static void
protocol_free(JSRuntime* rt, LWSProtocols* pro) {
  LWSProtocol* closure = pro->user;

  if(closure) {
    JS_FreeValueRT(rt, closure->callback);

    if(closure->obj)
      obj_free(rt, closure->obj);

    js_free_rt(rt, closure);
  }

  pro->user = 0;
  pro->callback = 0;

  if(pro->name) {
    js_free_rt(rt, (char*)pro->name);
    pro->name = 0;
  }
}

static const LWSProtocols*
protocols_fromarray(JSContext* ctx, JSValueConst value) {
  size_t len = 0;
  JSValue* values = to_valuearray(ctx, value, &len);
  LWSProtocols* pro = js_mallocz(ctx, (len + 13) * sizeof(LWSProtocols));
  size_t j = 0;

  if(len == 0)
    pro[j++] = (LWSProtocols){
        "http-only",
        callback_http,
        0,
        0,
        0,
        NULL,
        0,
    };

  for(size_t i = 0; i < len; i++) {
    pro[j++] = protocol_from(ctx, values[i]);

    JS_FreeValue(ctx, values[i]);
  }

  /*#ifdef PLUGIN_PROTOCOL_DEADDROP
    pro[j++] = (LWSProtocols)LWS_PLUGIN_PROTOCOL_DEADDROP;
  #endif
  #ifdef PLUGIN_PROTOCOL_RAW_PROXY
    pro[j++] = (LWSProtocols)LWS_PLUGIN_PROTOCOL_RAW_PROXY;
  #endif
  #ifdef PLUGIN_PROTOCOL_FULLTEXT_DEMO
    pro[j++] = (LWSProtocols)LWS_PLUGIN_PROTOCOL_FULLTEXT_DEMO;
  #endif
  #ifdef PLUGIN_PROTOCOL_LWS_STATUS
    pro[j++] = (LWSProtocols)LWS_PLUGIN_PROTOCOL_LWS_STATUS;
  #endif
  #ifdef PLUGIN_PROTOCOL_LWS_ACME_CLIENT
    pro[j++] = (LWSProtocols)LWS_PLUGIN_PROTOCOL_LWS_ACME_CLIENT;
  #endif
  #ifdef PLUGIN_PROTOCOL_LWS_SSHD_DEMO
    pro[j++] = (LWSProtocols)LWS_PLUGIN_PROTOCOL_LWS_SSHD_DEMO;
  #endif
  #ifdef PLUGIN_PROTOCOL_DUMB_INCREMENT
    pro[j++] = (LWSProtocols)LWS_PLUGIN_PROTOCOL_DUMB_INCREMENT;
  #endif
  #ifdef PLUGIN_PROTOCOL_MIRROR
    pro[j++] = (LWSProtocols)LWS_PLUGIN_PROTOCOL_MIRROR;
  #endif
  #ifdef PLUGIN_PROTOCOL_LWS_RAW_SSHD
    pro[j++] = (LWSProtocols)LWS_PLUGIN_PROTOCOL_LWS_RAW_SSHD;
  #endif
  #ifdef PLUGIN_PROTOCOL_RAW_TEST
    pro[j++] = (LWSProtocols)LWS_PLUGIN_PROTOCOL_RAW_TEST;
  #endif
  */
  if(values)
    js_free(ctx, values);

  return pro;
}

static void
protocols_free(JSRuntime* rt, LWSProtocols* pro) {
  size_t i;

  for(i = 0; pro[i].name; ++i)
    protocol_free(rt, &pro[i]);

  js_free_rt(rt, pro);
}

static struct lws_http_mount*
http_mount_from(JSContext* ctx, JSValueConst obj, const char* name) {
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
    mnt->cgienv = vhost_options_fromfree(ctx, value);

    value = js_get_property(ctx, obj, "extra_mimetypes");
    mnt->extra_mimetypes = vhost_options_fromfree(ctx, value);

    value = JS_GetPropertyStr(ctx, obj, "interpret");
    mnt->interpret = vhost_options_fromfree(ctx, value);

    value = js_get_property(ctx, obj, "cgi_timeout");
    mnt->cgi_timeout = to_integerfree(ctx, value);

    value = js_get_property(ctx, obj, "cache_max_age");
    mnt->cache_max_age = to_integerfree(ctx, value);

    value = js_get_property(ctx, obj, "auth_mask");
    mnt->auth_mask = to_integerfree(ctx, value);

    value = js_get_property(ctx, obj, "cache_reusable");
    mnt->cache_reusable = to_boolfree(ctx, value);

    value = js_get_property(ctx, obj, "cache_revalidate");
    mnt->cache_revalidate = to_boolfree(ctx, value);

    value = js_get_property(ctx, obj, "cache_intermediaries");
    mnt->cache_intermediaries = to_boolfree(ctx, value);

    /*value = js_get_property(ctx, obj, "cache_no");
    mnt->cache_no = to_boolfree(ctx, value);*/

    value = js_get_property(ctx, obj, "origin_protocol");
    mnt->origin_protocol = to_integerfree(ctx, value);

    value = js_get_property(ctx, obj, "basic_auth_login_file");
    mnt->basic_auth_login_file = to_stringfree(ctx, value);
  }

  return mnt;
}

static const struct lws_http_mount*
http_mounts_from(JSContext* ctx, JSValueConst value) {
  const struct lws_http_mount *mnt = 0, **ptr = &mnt, *tmp;

  if(JS_IsArray(ctx, value)) {
    int32_t len = to_int32free(ctx, JS_GetPropertyStr(ctx, value, "length"));

    if(len > 0) {
      mnt = js_malloc(ctx, sizeof(struct lws_http_mount));

      for(int32_t i = 0; i < len; i++) {
        JSValue mount = JS_GetPropertyUint32(ctx, value, i);

        if((*ptr = tmp = http_mount_from(ctx, mount, 0)))
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

        if((*ptr = tmp = http_mount_from(ctx, mount, name)))
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
      vhost_options_free(rt, (struct lws_protocol_vhost_options*)mnt->cgienv);
      mnt->cgienv = 0;
    }

    if(mnt->extra_mimetypes) {
      vhost_options_free(rt, (struct lws_protocol_vhost_options*)mnt->extra_mimetypes);
      mnt->extra_mimetypes = 0;
    }

    if(mnt->interpret) {
      vhost_options_free(rt, (struct lws_protocol_vhost_options*)mnt->interpret);
      mnt->interpret = 0;
    }

    if(mnt->basic_auth_login_file) {
      js_free_rt(rt, (char*)mnt->basic_auth_login_file);
      mnt->basic_auth_login_file = 0;
    }
  }
}

static struct lws_protocol_vhost_options*
vhost_option_from(JSContext* ctx, JSValueConst obj) {
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
    vho->options = vhost_options_from(ctx, options);
    vho->next = JS_IsObject(next) ? vhost_option_from(ctx, next) : NULL;
  }

  JS_FreeValue(ctx, name);
  JS_FreeValue(ctx, value);
  JS_FreeValue(ctx, options);
  JS_FreeValue(ctx, next);
  return vho;
}

static struct lws_protocol_vhost_options*
vhost_options_from(JSContext* ctx, JSValueConst value) {
  struct lws_protocol_vhost_options *vho = 0, **ptr = &vho, *tmp;
  JSValue first = JS_UNDEFINED;

  if(JS_IsArray(ctx, value) && ((first = JS_GetPropertyUint32(ctx, value, 0)), JS_IsObject(first))) {
    int32_t len = to_int32free(ctx, JS_GetPropertyStr(ctx, value, "length"));

    if(len > 0) {
      for(int32_t i = 0; i < len; i++) {
        JSValue option = JS_GetPropertyUint32(ctx, value, i);

        if((*ptr = tmp = vhost_option_from(ctx, option))) {
          do
            ptr = (struct lws_protocol_vhost_options**)&(*ptr)->next;
          while(*ptr);
        }

        JS_FreeValue(ctx, option);

        if(!tmp)
          break;
      }
    }
  } else if(JS_IsObject(value)) {
    vho = vhost_option_from(ctx, value);
  }

  JS_FreeValue(ctx, first);

  return vho;
}

static struct lws_protocol_vhost_options*
vhost_options_fromfree(JSContext* ctx, JSValue value) {
  struct lws_protocol_vhost_options* vho = vhost_options_from(ctx, value);
  JS_FreeValue(ctx, value);
  return vho;
}

static void
vhost_options_free(JSRuntime* rt, struct lws_protocol_vhost_options* vho) {
  do {
    js_free_rt(rt, (char*)vho->name);
    vho->name = 0;

    js_free_rt(rt, (char*)vho->value);
    vho->value = 0;

    vhost_options_free(rt, (struct lws_protocol_vhost_options*)vho->options);
    vho->options = 0;

  } while((vho = (struct lws_protocol_vhost_options*)vho->next));
}

static void
client_connect_info_fromobj(JSContext* ctx, JSValueConst obj, struct lws_client_connect_info* ci) {
  JSValue value;

  if(js_has_property(ctx, obj, "context")) {
    value = JS_GetPropertyStr(ctx, obj, "context");
    ci->context = lws_context_data(value);
    JS_FreeValue(ctx, value);
  }

  str_property(&ci->address, ctx, obj, "address");

  if(js_has_property(ctx, obj, "port"))
    ci->port = to_integerfree(ctx, js_get_property(ctx, obj, "port"));

  tls_connect_info_fromobj(ctx, obj, ci);

  str_property(&ci->path, ctx, obj, "path");
  str_property(&ci->host, ctx, obj, "host");
  str_property(&ci->origin, ctx, obj, "origin");
  str_property(&ci->protocol, ctx, obj, "protocol");
  str_property(&ci->method, ctx, obj, "method");
  str_property(&ci->iface, ctx, obj, "iface");

  if(js_has_property(ctx, obj, "local_port"))
    ci->local_port = to_integerfree(ctx, js_get_property(ctx, obj, "local_port"));

  str_property(&ci->local_protocol_name, ctx, obj, "local_protocol_name");
  str_property(&ci->alpn, ctx, obj, "alpn");

  if(js_has_property(ctx, obj, "keep_warm_secs"))
    ci->keep_warm_secs = to_integerfree(ctx, js_get_property(ctx, obj, "keep_warm_secs"));

  str_property(&ci->auth_username, ctx, obj, "auth_username");
  str_property(&ci->auth_password, ctx, obj, "auth_password");
}

static void
client_connect_info_free(JSRuntime* rt, struct lws_client_connect_info* ci) {
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

void
context_creation_info_fromobj(JSContext* ctx, JSValueConst obj, struct lws_context_creation_info* ci) {
  JSValue value;

  str_property(&ci->iface, ctx, obj, "iface");
  str_property(&ci->vhost_name, ctx, obj, "vhost_name");

  value = JS_GetPropertyStr(ctx, obj, "protocols");
  ci->protocols = protocols_fromarray(ctx, value);
  JS_FreeValue(ctx, value);

#ifdef LWS_ROLE_WS
  /* permessage-deflate was previously forced on unconditionally for every
     context. lws's own decompression-chunk boundaries get conflated with
     WS message/frame boundaries once it's active: lws_is_final_fragment()
     (wsi->ws->final && !wsi->ws->rx_packet_length) tracks the current
     *decompression step*, not the underlying wire frame, so it reports
     "final" for every intermediate fragment of an explicitly-fragmented
     message, and a single large message can get delivered to JS as
     several separate LWS_CALLBACK_CLIENT_RECEIVE/RECEIVE calls with no
     reliable way to tell they belong together. Opt-in only now, off by
     default, so callers who don't need compression get correct fragment
     boundaries. */
  if(to_boolfree(ctx, JS_GetPropertyStr(ctx, obj, "permessageDeflate"))) {
    struct lws_extension* exts;

    if((exts = js_mallocz(ctx, sizeof(struct lws_extension) * 2)))
      exts[0] = (struct lws_extension){
          "permessage-deflate",
          lws_extension_callback_pm_deflate,
          "permessage-deflate; client_no_context_takeover; client_max_window_bits",
      };

    ci->extensions = exts;
  }
#endif

#if defined(LWS_ROLE_H1) || defined(LWS_ROLE_H2)
  str_property(&ci->http_proxy_address, ctx, obj, "http_proxy_address");

  value = JS_GetPropertyStr(ctx, obj, "headers");
  ci->headers = vhost_options_fromfree(ctx, value);

  value = js_get_property(ctx, obj, "reject_service_keywords");
  ci->reject_service_keywords = vhost_options_from(ctx, value);
  JS_FreeValue(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "pvo");
  ci->pvo = vhost_options_fromfree(ctx, value);

  str_property(&ci->log_filepath, ctx, obj, "log_filepath");

  value = JS_GetPropertyStr(ctx, obj, "mounts");
  ci->mounts = http_mounts_from(ctx, value);
  JS_FreeValue(ctx, value);

  str_property(&ci->server_string, ctx, obj, "server_string");

  str_property(&ci->error_document_404, ctx, obj, "error_document_404");

  value = JS_GetPropertyStr(ctx, obj, "port");
  ci->port = to_integerfree(ctx, value);

  value = js_get_property(ctx, obj, "http_proxy_port");
  ci->http_proxy_port = to_integerfree(ctx, value);

  value = js_get_property(ctx, obj, "keepalive_timeout");
  ci->keepalive_timeout = to_integerfree(ctx, value);
#endif

#ifdef LWS_WITH_SYS_ASYNC_DNS
  value = js_get_property(ctx, obj, "async_dns_servers");
  ci->async_dns_servers = (const char**)to_stringarrayfree(ctx, value);
#endif

  tls_creation_info_fromobj(ctx, obj, ci);

#ifdef LWS_WITH_SOCKS5
  str_property(&ci->socks_proxy_address, ctx, obj, "socks_proxy_address");

  value = js_get_property(ctx, obj, "socks_proxy_port");
  ci->socks_proxy_port = to_integerfree(ctx, value);
#endif

  value = js_get_property(ctx, obj, "default_loglevel");
  ci->default_loglevel = to_integerfree(ctx, value);

  value = js_get_property(ctx, obj, "vh_listen_sockfd");
  ci->vh_listen_sockfd = to_integerfree(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "options");
  ci->options = to_integerfree(ctx, value);

  if(ci->options & LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG) {
    str_property(&ci->listen_accept_role, ctx, obj, "listen_accept_role");

    str_property(&ci->listen_accept_protocol, ctx, obj, "listen_accept_protocol");
  }
}

void
context_creation_info_free(JSRuntime* rt, struct lws_context_creation_info* ci) {
  if(ci->iface)
    js_free_rt(rt, (char*)ci->iface);

  if(ci->protocols)
    protocols_free(rt, (LWSProtocols*)ci->protocols);

  if(ci->http_proxy_address)
    js_free_rt(rt, (char*)ci->http_proxy_address);

  if(ci->headers)
    vhost_options_free(rt, (struct lws_protocol_vhost_options*)ci->headers);

  if(ci->reject_service_keywords)
    vhost_options_free(rt, (struct lws_protocol_vhost_options*)ci->reject_service_keywords);

  if(ci->pvo)
    vhost_options_free(rt, (struct lws_protocol_vhost_options*)ci->pvo);

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

  tls_creation_info_free(rt, ci);

#ifdef LWS_WITH_SOCKS5
  if(ci->socks_proxy_address)
    js_free_rt(rt, (char*)ci->socks_proxy_address);
#endif

  if(ci->listen_accept_role)
    js_free_rt(rt, (char*)ci->listen_accept_role);

  if(ci->listen_accept_protocol)
    js_free_rt(rt, (char*)ci->listen_accept_protocol);
}

static LWSContext*
context_new(JSContext* ctx) {
  LWSContext* lc;

  if((lc = js_mallocz(ctx, sizeof(LWSContext)))) {
    init_list_head(&lc->handlers);
    /* js_mallocz() zero-fills, which isn't guaranteed to be JS_UNDEFINED's
       actual bit pattern - set it explicitly rather than relying on that. */
    lc->service_timer_id = JS_UNDEFINED;
  }

  return lc;
}

static void
context_free(JSRuntime* rt, LWSContext* lc) {
#ifdef USE_EPOLL
  lws_epoll_destroy(lc);
#endif

  if(lc->js) {
    cancel_service_tick(lc);
    JS_FreeContext(lc->js);
    lc->js = NULL;
  }

  if(lc->info.user) {
    obj_free(rt, lc->info.user);
    lc->info.user = NULL;
  }

  if(lc->ctx) {
    lws_context_destroy(lc->ctx);
    lc->ctx = NULL;
  }

  context_creation_info_free(rt, &lc->info);

  js_free_rt(rt, lc);
}

static JSValue
lwsjs_context_constructor(JSContext* ctx, JSValueConst new_target, int argc, JSValueConst argv[]) {
  LWSContext* lc;

  if(!(lc = context_new(ctx)))
    return JS_EXCEPTION;

  /* using new_target to get the prototype is necessary when the class is extended. */
  JSValue proto = JS_GetPropertyStr(ctx, new_target, "prototype");
  if(JS_IsException(proto))
    proto = JS_DupValue(ctx, lwsjs_context_proto);

  JSValue obj = JS_NewObjectProtoClass(ctx, proto, lwsjs_context_class_id);
  JS_FreeValue(ctx, proto);
  if(JS_IsException(obj))
    goto fail;

  if(JS_IsObject(argv[0]))
    context_creation_info_fromobj(ctx, argv[0], &lc->info);

  JS_SetOpaque(obj, lc);

  lc->js = JS_DupContext(ctx);
  lc->info.user = obj_ptr(ctx, obj);

  if(!js_has_property(ctx, argv[0], "port"))
    lc->info.port = CONTEXT_PORT_NO_LISTEN;

  /* This must be called last, because it can trigger callbacks already */
  lc->ctx = lws_create_context(&lc->info);

  patch_system_vhost_pollfd(lc->ctx);

  if(lc->ctx)
    schedule_service_tick(lc, SERVICE_TICK_MS);

  JS_DefinePropertyValueStr(ctx, obj, "info", JS_DupValue(ctx, argv[0]), JS_PROP_CONFIGURABLE);

  return obj;

fail:
  js_free(ctx, lc);
  JS_FreeValue(ctx, obj);
  return JS_EXCEPTION;
}

static JSValue
lwsjs_create_server(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[]) {
  return JS_CallConstructor(ctx, lwsjs_context_ctor, argc, argv);
}

static const JSCFunctionListEntry lws_context_funcs[] = {
    JS_CFUNC_DEF("createServer", 1, lwsjs_create_server),
};

enum {
  METHOD_DESTROY,
  METHOD_GET_VHOST_BY_NAME,
  METHOD_ADOPT_SOCKET,
  METHOD_ADOPT_SOCKET_READBUF,
  METHOD_CANCEL_SERVICE,
  METHOD_CLIENT_CONNECT,
  METHOD_GET_RANDOM,
  METHOD_ASYNC_DNS_SERVER_ADD,
  METHOD_ASYNC_DNS_SERVER_REMOVE,
  METHOD_WSI_FROM_FD,
};

static JSValue
lwsjs_context_methods(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[], int magic) {
  LWSContext* lc;
  JSValue ret = JS_UNDEFINED;

  if(!(lc = lwsjs_context_data2(ctx, this_val)))
    return JS_EXCEPTION;

  if(lc->ctx == NULL && magic != METHOD_DESTROY)
    return JS_ThrowInternalError(ctx, "LWSContext internal lws_context has been destroyed");

  switch(magic) {
    case METHOD_DESTROY: {
      if(lc->ctx) {
        lws_context_destroy(lc->ctx);
        lc->ctx = NULL;
        ret = JS_TRUE;
      }

      break;
    }

    case METHOD_GET_VHOST_BY_NAME: {
      const char* name;

      if((name = JS_ToCString(ctx, argv[0]))) {
        struct lws_vhost* vho;

        if((vho = lws_get_vhost_by_name(lc->ctx, name)))
          ret = ptr_obj(ctx, lws_get_vhost_user(vho));

        JS_FreeCString(ctx, name);
      }

      break;
    }

    case METHOD_ADOPT_SOCKET: {
      int32_t arg = to_int32(ctx, argv[0]);
      struct lws* wsi;

      if(wsi_from_fd(lc->ctx, arg))
        return JS_ThrowInternalError(ctx, "socket %" PRIi32 " already adopted", arg);

      if((wsi = lws_adopt_socket(lc->ctx, arg)))
        ret = lwsjs_socket_create(ctx, wsi);

      break;
    }

    case METHOD_ADOPT_SOCKET_READBUF: {
      int32_t arg = to_int32(ctx, argv[0]);
      struct lws* wsi;
      size_t len;
      uint8_t* buf;

      if(wsi_from_fd(lc->ctx, arg))
        return JS_ThrowInternalError(ctx, "socket %" PRIi32 " already adopted", arg);

      if(!(buf = get_buffer(ctx, argc - 1, argv + 1, &len)))
        return JS_ThrowTypeError(ctx, "argument 2 must be an arraybuffer");

      if((wsi = lws_adopt_socket_readbuf(lc->ctx, arg, (const char*)buf, len)))
        ret = lwsjs_socket_create(ctx, wsi);

      break;
    }

    case METHOD_CANCEL_SERVICE: {
      lws_cancel_service(lc->ctx);

      iohandler_cleanup(lc);
      cancel_service_tick(lc);
      break;
    }

    case METHOD_CLIENT_CONNECT: {
      struct lws_client_connect_info info = {0};
      char* uri = 0;
      JSValue obj = JS_IsString(argv[0]) ? (argc > 1 && JS_IsObject(argv[1]) ? JS_DupValue(ctx, argv[1]) : JS_NewObject(ctx)) : JS_DupValue(ctx, argv[0]);

      if(argc > 0 && JS_IsString(argv[0])) {
        char* tmp;

        if((tmp = to_string(ctx, argv[0]))) {
          uri = js_strdup(ctx, tmp);
          lwsjs_uri_toconnectinfo(ctx, tmp, &info);
          js_free(ctx, tmp);
        }
      }

      client_connect_info_fromobj(ctx, obj, &info);

      LWSSocket* sock = socket_alloc(ctx);

      sock->client = TRUE;
      sock->type = info.method ? SOCKET_HTTP : SOCKET_WS;
      sock->method = info.method ? lwsjs_method_index(info.method) : 0;

      ret = lwsjs_socket_wrap(ctx, sock);

      info.context = lc->ctx;
      info.pwsi = &sock->wsi;
      info.opaque_user_data = obj_ptr(ctx, ret);

      if(info.address == 0 && info.host)
        info.address = js_strdup(ctx, info.host);

      if(!uri)
        uri = lwsjs_connectinfo_to_uri(ctx, &info);

      sock->uri = uri;

      lws_client_connect_via_info(&info);

      client_connect_info_free(JS_GetRuntime(ctx), &info);
      JS_FreeValue(ctx, obj);
      break;
    }

    case METHOD_GET_RANDOM: {
      size_t n;
      uint8_t* p;

      if((p = get_buffer(ctx, argc, argv, &n)))
        lws_get_random(lc->ctx, p, n);

      break;
    }

    case METHOD_ASYNC_DNS_SERVER_ADD: {
      JSValue addr = lwsjs_sockaddr46_value(ctx, argv[0]);
      lws_sockaddr46* sa46 = lwsjs_sockaddr46_data(ctx, addr);

      ret = JS_NewInt32(ctx, lws_async_dns_server_add(lc->ctx, sa46));

      JS_FreeValue(ctx, addr);
      break;
    }

    case METHOD_ASYNC_DNS_SERVER_REMOVE: {
      JSValue addr = lwsjs_sockaddr46_value(ctx, argv[0]);
      lws_sockaddr46* sa46 = lwsjs_sockaddr46_data(ctx, addr);

      lws_async_dns_server_remove(lc->ctx, sa46);

      JS_FreeValue(ctx, addr);
      break;
    }

    case METHOD_WSI_FROM_FD: {
      struct lws* wsi;

      if((wsi = wsi_from_fd(lc->ctx, to_int32(ctx, argv[0]))))
        ret = js_socket_get(ctx, wsi);
      break;
    }
  }

  return ret;
}

enum {
  PROP_HOSTNAME = 0,
  PROP_DEPRECATED,
  PROP_EUID,
  PROP_EGID,
  PROP_PROTOCOLS,
};

static JSValue
lwsjs_context_get(JSContext* ctx, JSValueConst this_val, int magic) {
  LWSContext* lc;
  JSValue ret = JS_UNDEFINED;

  if(!(lc = lwsjs_context_data2(ctx, this_val)))
    return JS_EXCEPTION;

  switch(magic) {
    case PROP_HOSTNAME: {
      const char* s;

      if((s = lws_canonical_hostname(lc->ctx)))
        ret = JS_NewString(ctx, s);

      break;
    }

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

    case PROP_PROTOCOLS: {
      ret = JS_NewArray(ctx);

      for(uint32_t i = 0; lc->info.protocols[i].name; i++) {
        JSValue protocol = protocol_obj(ctx, &lc->info.protocols[i]);
        JS_SetPropertyUint32(ctx, ret, i, protocol);
      }

      break;
    }
  }

  return ret;
}

static void
lwsjs_context_finalizer(JSRuntime* rt, JSValue val) {
  LWSContext* lc;

  if((lc = lwsjs_context_data(val)))
    context_free(rt, lc);
}

static const JSClassDef lws_context_class = {
    "LWSContext",
    .finalizer = lwsjs_context_finalizer,
};

static const JSCFunctionListEntry lws_context_proto_funcs[] = {
    JS_CFUNC_MAGIC_DEF("destroy", 0, lwsjs_context_methods, METHOD_DESTROY),
    JS_CFUNC_MAGIC_DEF("getVhostByName", 1, lwsjs_context_methods, METHOD_GET_VHOST_BY_NAME),
    JS_CFUNC_MAGIC_DEF("adoptSocket", 1, lwsjs_context_methods, METHOD_ADOPT_SOCKET),
    JS_CFUNC_MAGIC_DEF("adoptSocketReadbuf", 2, lwsjs_context_methods, METHOD_ADOPT_SOCKET_READBUF),
    JS_CFUNC_MAGIC_DEF("cancelService", 0, lwsjs_context_methods, METHOD_CANCEL_SERVICE),
    JS_CFUNC_MAGIC_DEF("clientConnect", 1, lwsjs_context_methods, METHOD_CLIENT_CONNECT),
    JS_CFUNC_MAGIC_DEF("getRandom", 1, lwsjs_context_methods, METHOD_GET_RANDOM),
    JS_CFUNC_MAGIC_DEF("asyncDnsServerAdd", 1, lwsjs_context_methods, METHOD_ASYNC_DNS_SERVER_ADD),
    JS_CFUNC_MAGIC_DEF("asyncDnsServerRemove", 1, lwsjs_context_methods, METHOD_ASYNC_DNS_SERVER_REMOVE),
    JS_CFUNC_MAGIC_DEF("wsiFromFd", 1, lwsjs_context_methods, METHOD_WSI_FROM_FD),
    JS_CGETSET_MAGIC_DEF("hostname", lwsjs_context_get, 0, PROP_HOSTNAME),
    // JS_CGETSET_MAGIC_DEF("vhost", lwsjs_context_get, 0, PROP_VHOST),
    JS_CGETSET_MAGIC_DEF("deprecated", lwsjs_context_get, 0, PROP_DEPRECATED),
    JS_CGETSET_MAGIC_DEF("euid", lwsjs_context_get, 0, PROP_EUID),
    JS_CGETSET_MAGIC_DEF("egid", lwsjs_context_get, 0, PROP_EGID),
    JS_CGETSET_MAGIC_DEF("protocols", lwsjs_context_get, 0, PROP_PROTOCOLS),
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
    JS_SetModuleExportList(ctx, m, lws_context_funcs, countof(lws_context_funcs));
  }

  return 0;
}

static int
callback_pollfd(struct lws* wsi, enum lws_callback_reasons reason, void* user, void* in, size_t len) {
  /*LWSContext* lc = wsi ? lwsjs_wsi_context(wsi) : 0;
  JSContext* ctx = lc && lc->js ? lc->js : wsi ? lwsjs_wsi_jscontext(wsi) : 0;*/

  LWSProtocols const* pro = wsi ? lws_get_protocol(wsi) : 0;
  LWSProtocol* closure = pro ? pro->user : 0;

  LWSContext* lc = wsi ? lwsjs_wsi_context(wsi) : 0;
  JSContext* ctx = closure && closure->ctx ? closure->ctx : lc ? lc->js : 0;

  if(!ctx && lc && lc->ctx) {
    JSObject* obj = lws_context_user(lc->ctx);
    LWSContext* lwsctx;

    if((lwsctx = JS_GetOpaque(JS_MKPTR(JS_TAG_OBJECT, obj), lwsjs_context_class_id)))
      ctx = lwsctx->js;
  }

  switch(reason) {
    case LWS_CALLBACK_LOCK_POLL:
    case LWS_CALLBACK_UNLOCK_POLL: {
      return 0;
    }

    case LWS_CALLBACK_DEL_POLL_FD: {
      struct lws_pollargs* x = in;

#ifdef USE_EPOLL
      lws_epoll_del(lc, x->fd);
#else
      iohandler_set(lc, x->fd, JS_NULL, 0);
      iohandler_set(lc, x->fd, JS_NULL, 1);
#endif
      return 0;
    }

    case LWS_CALLBACK_ADD_POLL_FD:
    case LWS_CALLBACK_CHANGE_MODE_POLL_FD: {
      struct lws_pollargs* x = in;

      if(x->events == x->prev_events)
        return 0;

#ifdef USE_EPOLL
      lws_epoll_ctl(lc, x->fd, x->events);
#else
      BOOL write = !!(x->events & POLLOUT);
      JSValueConst data[] = {
          JS_NewInt32(ctx, x->fd),
          JS_NewInt32(ctx, x->events),
          JS_NewBool(ctx, write),
          JS_NewInt64(ctx, (intptr_t)lws_get_context(wsi)),
      };
      JSValue fn = JS_NewCFunctionData(ctx, protocol_handler, 0, 0, countof(data), data);

      if(reason == LWS_CALLBACK_CHANGE_MODE_POLL_FD)
        iohandler_set(lc, x->fd, JS_NULL, !write);

      iohandler_set(lc, x->fd, fn, write);

      JS_FreeValue(ctx, fn);
#endif
      return 0;
    }

    default: break;
  }

  return -1;
}

/*
 * lws_create_context() always creates its own internal "system" vhost
 * (context->vhost_system) for async-dns/ntp/dhcp/stdin, built from lws's
 * own protocol list - entirely separate from the vhost(s) our own
 * protocols_fromarray() builds. Since pollfd management (LOCK_POLL,
 * ADD_POLL_FD, etc.) is always dispatched via vhost->protocols[0].callback
 * regardless of which protocol a given wsi is actually bound to, poll-fd
 * events for wsi living on the system vhost (e.g. the async-DNS resolver's
 * UDP socket) were never reaching callback_pollfd()/iohandler_set() at
 * all - they went to lws's own internal protocol callback instead, which
 * has no idea about our iohandler-driven event loop. That left async DNS
 * lookups (and hence any fetch() to a hostname rather than a literal IP)
 * silently stuck forever waiting for a write-ready notification that
 * never arrived. Fix: after context creation, wrap the system vhost's
 * protocols[0] callback so pollfd-management reasons go to
 * callback_pollfd() first, falling through to the original callback
 * (real DNS/ntp/etc. protocol logic) for everything else.
 */
static lws_callback_function* system_vhost_orig_callback;

static int
callback_system_vhost_pollfd_wrap(struct lws* wsi, enum lws_callback_reasons reason, void* user, void* in, size_t len) {
  switch(reason) {
    case LWS_CALLBACK_LOCK_POLL:
    case LWS_CALLBACK_UNLOCK_POLL:
    case LWS_CALLBACK_ADD_POLL_FD:
    case LWS_CALLBACK_DEL_POLL_FD:
    case LWS_CALLBACK_CHANGE_MODE_POLL_FD: {
      if(callback_pollfd(wsi, reason, user, in, len) == 0)
        return 0;
      break;
    }
    default: break;
  }

  return system_vhost_orig_callback ? system_vhost_orig_callback(wsi, reason, user, in, len) : 0;
}

static void
patch_system_vhost_pollfd(struct lws_context* ctx) {
  struct lws_vhost* vh;
  const struct lws_protocols* pro;

  if(!ctx || !(vh = lws_get_vhost_by_name(ctx, "system")))
    return;

  if(!(pro = lws_vhost_name_to_protocol(vh, "lws-async-dns")))
    return;

  if(pro->callback == callback_system_vhost_pollfd_wrap)
    return;

  system_vhost_orig_callback = pro->callback;
  ((struct lws_protocols*)pro)->callback = callback_system_vhost_pollfd_wrap;
}

static int
callback_js(struct lws* wsi, enum lws_callback_reasons reason, void* user, void* in, size_t len) {
  if(!wsi)
    return -1;

  JSValue* jsval = user;
  LWSProtocols const* pro = lws_get_protocol(wsi);

  switch(reason) {
    case LWS_CALLBACK_WSI_CREATE:
    case LWS_CALLBACK_HTTP_BIND_PROTOCOL:
    case LWS_CALLBACK_CLIENT_HTTP_BIND_PROTOCOL:
    case LWS_CALLBACK_WS_SERVER_BIND_PROTOCOL:
    case LWS_CALLBACK_WS_CLIENT_BIND_PROTOCOL:
    case LWS_CALLBACK_RAW_PROXY_CLI_BIND_PROTOCOL:
    case LWS_CALLBACK_RAW_PROXY_SRV_BIND_PROTOCOL:
    case LWS_CALLBACK_RAW_SKT_BIND_PROTOCOL:
    case LWS_CALLBACK_RAW_FILE_BIND_PROTOCOL: {
      if(user && pro->per_session_data_size == sizeof(JSValue)) {
        JSContext* ctx = lwsjs_wsi_jscontext(wsi);

        if(JS_VALUE_GET_TAG(*jsval) == 0 && JS_VALUE_GET_PTR(*jsval) == 0)
          *jsval = JS_NewObjectProto(ctx, JS_NULL);

        return 0;
      }
      break;
    }

    case LWS_CALLBACK_WSI_DESTROY: {
      if(user && pro->per_session_data_size == sizeof(JSValue)) {
        JSContext* ctx = lwsjs_wsi_jscontext(wsi);

        if(JS_IsObject(*jsval)) {
          JS_FreeValue(ctx, *jsval);
          *jsval = JS_MKPTR(0, 0);
        }

        lwsjs_socket_destroy(ctx, wsi);
        return 0;
      }
      break;
    }

    default: break;
  }

  return -1;
}

static int
callback_http(struct lws* wsi, enum lws_callback_reasons reason, void* user, void* in, size_t len) {
  if(callback_js(wsi, reason, user, in, len) == 0)
    return 0;
  if(callback_pollfd(wsi, reason, user, in, len) == 0)
    return 0;

  LWSSocket* sock;
  BOOL client = FALSE;

  if((sock = socket_get(wsi)))
    client = sock->client;

  int ret = client ? 0 : lws_callback_http_dummy(wsi, reason, user, in, len);

  return ret;
}

static int
callback_protocol(struct lws* wsi, enum lws_callback_reasons reason, void* user, void* in, size_t len) {
  if(reason == LWS_CALLBACK_OPENSSL_LOAD_EXTRA_CLIENT_VERIFY_CERTS || reason == LWS_CALLBACK_OPENSSL_LOAD_EXTRA_SERVER_VERIFY_CERTS)
    return 0;

  if(callback_js(wsi, reason, user, in, len) == 0)
    return 0;
  if(callback_pollfd(wsi, reason, user, in, len) == 0)
    return 0;

  LWSProtocols const* pro = wsi ? lws_get_protocol(wsi) : 0;
  LWSProtocol* closure = pro ? pro->user : 0;
  JSValue* cb = closure ? &closure->callback : 0;
  LWSContext* lc = wsi ? lwsjs_wsi_context(wsi) : 0;
  JSContext* ctx = lc && lc->js ? lc->js : wsi ? lwsjs_wsi_jscontext(wsi) : 0;
  int32_t ret = 0;
  JSValue* jsval = user && pro && pro->per_session_data_size == sizeof(JSValue) && JS_IsObject(*(JSValue*)user) ? user : 0;

  DEBUG_WSI(wsi, "\x1b[1;33m%-24s\x1b[0m %p %p %zu", lwsjs_callback_name(reason), user, in, len);

  /* Pollfd-management reasons (LOCK_POLL/UNLOCK_POLL/ADD_POLL_FD/DEL_POLL_FD/
     CHANGE_MODE_POLL_FD) never reach this point: callback_js() never handles
     them, so the callback_pollfd() call a few lines above this function's
     entry already returns 0 for all five - there used to be a second,
     unreachable copy of that same switch statement here. */
  if(closure && countof(closure->callbacks) > reason && !is_nullish(closure->callbacks[reason]))
    cb = &closure->callbacks[reason];

  /*if(((int32_t*)wsi)[58] & 2)
    return lws_callback_http_dummy(wsi, reason, user, in, len);*/

  JSValue sock = wsi && reason != LWS_CALLBACK_CLIENT_HTTP_BIND_PROTOCOL && reason != LWS_CALLBACK_PROTOCOL_INIT ? lwsjs_socket_get_or_create(ctx, wsi) : JS_UNDEFINED;
  LWSSocket* s = lwsjs_socket_data(sock);

  if(reason == LWS_CALLBACK_HTTP_WRITEABLE || reason == LWS_CALLBACK_CLIENT_HTTP_WRITEABLE || reason == LWS_CALLBACK_SERVER_WRITEABLE || reason == LWS_CALLBACK_CLIENT_WRITEABLE ||
     reason == LWS_CALLBACK_RAW_PROXY_CLI_WRITEABLE || reason == LWS_CALLBACK_RAW_PROXY_SRV_WRITEABLE || reason == LWS_CALLBACK_RAW_WRITEABLE || reason == LWS_CALLBACK_RAW_WRITEABLE_FILE ||
     reason == LWS_CALLBACK_MQTT_CLIENT_WRITEABLE) {
    /* Drain any queued wsi.write() chunks first; socket_flush re-arms the
       writeable callback if it couldn't push everything out this round. */
    if(s)
      socket_flush(s);

    /* Only fire the user's wantWrite() handler once our internal queue is
       empty — that way waitWrite() semantically means "drained", not
       "ready for the first byte" while a backlog is still going out.
       socket_flush already re-armed if the queue isn't empty yet, so this
       fires on a subsequent WRITEABLE callback. */
    if(s && s->want_write && list_empty(&s->write_queue)) {
      s->want_write = FALSE;

      if(!JS_IsUndefined(s->write_handler)) {
        JSValue fn = s->write_handler;
        s->write_handler = JS_UNDEFINED;
        JSValue result = JS_Call(ctx, fn, JS_UNDEFINED, 1, &sock);
        ret = to_int32(ctx, result);
        JS_FreeValue(ctx, result);
        JS_FreeValue(ctx, fn);
        goto end;
      }
    }

    if(reason == LWS_CALLBACK_CLIENT_APPEND_HANDSHAKE_HEADER)
      s->redirected_to_get = lws_http_is_redirected_to_get(wsi);

    if(reason == LWS_CALLBACK_CLIENT_HTTP_WRITEABLE)
      if(s->redirected_to_get)
        goto end;
  }

  if(reason == LWS_CALLBACK_CLIENT_FILTER_PRE_ESTABLISH || reason == LWS_CALLBACK_ESTABLISHED_CLIENT_HTTP || reason == LWS_CALLBACK_FILTER_HTTP_CONNECTION || reason == LWS_CALLBACK_HTTP) {
    if(s && is_nullish(s->headers)) {
      s->headers = lwsjs_socket_headers(ctx, s->wsi, &s->proto);
    }
  }

  if(reason == LWS_CALLBACK_HTTP || reason == LWS_CALLBACK_FILTER_HTTP_CONNECTION || reason == LWS_CALLBACK_CLIENT_FILTER_PRE_ESTABLISH) {
    if(s && (s->uri == 0 || s->method == -1)) {
      char* uri_ptr = 0;
      int uri_len = 0;

      int method = lws_http_get_uri_and_method(s->wsi, &uri_ptr, &uri_len);

      if(uri_ptr && s->uri == 0)
        s->uri = js_strndup(ctx, uri_ptr, uri_len);

      if(method >= 0 && s->method == -1)
        s->method = method;
    }
  }

  if(cb && !is_nullish(*cb)) {
    int argi = 1, buffer_index = -1;
    JSValue argv[5] = {
        JS_DupValue(ctx, sock),
    };

    if(cb == &closure->callback)
      argv[argi++] = JS_NewInt32(ctx, reason);

    /*argv[argi++] = (user && pro->per_session_data_size == sizeof(JSValue) && (JS_VALUE_GET_OBJ(*(JSValue*)user) && JS_VALUE_GET_TAG(*(JSValue*)user) == JS_TAG_OBJECT)) ? *(JSValue*)user : JS_NULL;*/

    if(reason == LWS_CALLBACK_HTTP_CONFIRM_UPGRADE) {
      if(s && !strcmp(in, "websocket"))
        s->type = SOCKET_WS;
    }

    if(reason == LWS_CALLBACK_FILTER_HTTP_CONNECTION) {
      if(s && !strcmp(in, "ws"))
        s->type = SOCKET_WS;
    }

    if(reason == LWS_CALLBACK_CLIENT_ESTABLISHED || reason == LWS_CALLBACK_FILTER_PROTOCOL_CONNECTION) {
      if(s)
        s->type = SOCKET_WS;
    }

    BOOL process_html_args = reason == LWS_CALLBACK_ADD_HEADERS || reason == LWS_CALLBACK_CHECK_ACCESS_RIGHTS || reason == LWS_CALLBACK_PROCESS_HTML;

    /* This rewrite has to happen before the switch below, not as one of its
       cases, since it decides *which* reason to dispatch as. Note it builds
       its own args here rather than falling into the switch's
       WS_PEER_INITIATED_CLOSE case below: that case's real (non-rewritten)
       dispatch pushes the reason text as an ArrayBuffer and guards `code` on
       len >= 2, while this synthesized-from-a-close-frame path has always
       pushed it as a plain string and always pushed `code` - two genuinely
       different argument shapes for the same reason value, so they can't
       share one case. */
    BOOL args_built = FALSE;

    if(reason == LWS_CALLBACK_CLIENT_RECEIVE && (((char*)in)[-2] & 0x7f) == 8) {
      BOOL has_reason = cb == &closure->callback;
      int code = (int)(((uint8_t*)in)[0]) << 8 | ((uint8_t*)in)[1];

      reason = LWS_CALLBACK_WS_PEER_INITIATED_CLOSE;
      cb = is_nullish(closure->callbacks[reason]) ? &closure->callback : &closure->callbacks[reason];

      if(!has_reason && cb == &closure->callback)
        argv[argi++] = JS_NewInt32(ctx, reason);

      argv[argi++] = JS_NewInt32(ctx, code);

      if(len > 2)
        argv[argi++] = JS_NewStringLen(ctx, (char*)in + 2, len - 2);

      args_built = TRUE;
    }

    if(!args_built) {
    switch(reason) {
      case LWS_CALLBACK_CLIENT_HTTP_REDIRECT: {
        argv[argi++] = JS_NewString(ctx, in);
        argv[argi++] = JS_NewInt32(ctx, len);
        break;
      }

      case LWS_CALLBACK_ADD_HEADERS:
      case LWS_CALLBACK_CHECK_ACCESS_RIGHTS:
      case LWS_CALLBACK_PROCESS_HTML: {
        struct lws_process_html_args* pha = (struct lws_process_html_args*)in;

        if(reason == LWS_CALLBACK_ADD_HEADERS)
          pha->len = 0;

        if(pha->len < pha->max_len)
          memset(&pha->p[pha->len], 0, pha->max_len - pha->len);

        argv[buffer_index = argi++] = JS_NewArrayBuffer(ctx, (uint8_t*)pha->p, pha->max_len, 0, 0, FALSE);
        argv[argi] = JS_NewArray(ctx);
        JS_SetPropertyUint32(ctx, argv[argi], 0, JS_NewUint32(ctx, pha->len));
        argi++;
        break;
      }

      case LWS_CALLBACK_ESTABLISHED: {
        argv[argi++] = js_fmt_pointer(ctx, in, "(SSL*)");
        argv[argi++] = JS_NewInt32(ctx, len);
        break;
      }

      case LWS_CALLBACK_CLIENT_APPEND_HANDSHAKE_HEADER: {
        memset(*(uint8_t**)in, 0, len);
        argv[buffer_index = argi++] = JS_NewArrayBuffer(ctx, *(uint8_t**)in, len, 0, 0, FALSE);
        argv[argi] = JS_NewArray(ctx);
        JS_SetPropertyUint32(ctx, argv[argi], 0, JS_NewUint32(ctx, 0));
        argi++;
        break;
      }

      case LWS_CALLBACK_OPENSSL_PERFORM_SERVER_CERT_VERIFICATION: {
        argv[argi++] = JS_NewInt64(ctx, (int64_t)(intptr_t)in);
        argv[argi++] = JS_NewInt32(ctx, len);
        break;
      }

      case LWS_CALLBACK_ESTABLISHED_CLIENT_HTTP: {
        int response = lws_http_client_http_response(wsi);

        assert(s);
        s->response_code = response;

        argv[argi++] = JS_NewInt32(ctx, response);
        break;
      }

      case LWS_CALLBACK_CONNECTING: {
        argv[argi++] = JS_NewInt32(ctx, (int32_t)(intptr_t)in);
        break;
      }

      case LWS_CALLBACK_WS_PEER_INITIATED_CLOSE: {
        if(len >= 2)
          argv[argi++] = JS_NewInt32(ctx, ntohs(*(uint16_t*)in));

        if(len > 2)
          argv[argi++] = JS_NewArrayBufferCopy(ctx, (const uint8_t*)in + 2, len - 2);
        break;
      }

      case LWS_CALLBACK_FILTER_NETWORK_CONNECTION: {
        argv[argi++] = JS_NewInt32(ctx, (int32_t)(intptr_t)in);
        break;
      }

      default: {
        if(in && (len > 0) && reason != LWS_CALLBACK_FILTER_HTTP_CONNECTION && reason != LWS_CALLBACK_CLIENT_CONNECTION_ERROR) {
          BOOL is_ws = reason == LWS_CALLBACK_CLIENT_RECEIVE || reason == LWS_CALLBACK_RECEIVE;

          argv[argi++] = in ? ((!is_ws || lws_frame_is_binary(wsi))) ? JS_NewArrayBufferCopy(ctx, in, len) : JS_NewStringLen(ctx, in, len) : JS_NULL;
          argv[argi++] = JS_NewInt64(ctx, len);

          /* lws_is_first_fragment()/lws_is_final_fragment() are receive-side
             (unlike lws_ws_sending_multifragment(), which reports our own send
             state and is never true here). A plain single-frame message is
             simultaneously first and final; only surface `frame` when that's
             not the case, matching the documented "only present for
             multi-fragment messages" contract. */
          if(is_ws && !(lws_is_first_fragment(wsi) && lws_is_final_fragment(wsi))) {
            argv[argi] = JS_NewObjectProto(ctx, JS_NULL);
            JS_SetPropertyStr(ctx, argv[argi], "multifragment", JS_TRUE);
            JS_SetPropertyStr(ctx, argv[argi], "first", JS_NewBool(ctx, lws_is_first_fragment(wsi)));
            JS_SetPropertyStr(ctx, argv[argi], "final", JS_NewBool(ctx, lws_is_final_fragment(wsi)));
            argi++;
          }
        } else if(in && (len == 0 || reason == LWS_CALLBACK_FILTER_HTTP_CONNECTION || reason == LWS_CALLBACK_CLIENT_CONNECTION_ERROR)) {
          argv[argi++] = JS_NewString(ctx, in);
        }
        break;
      }
    }
    }

    if(reason == LWS_CALLBACK_CLIENT_CONNECTION_ERROR) {
      argv[argi++] = JS_NewInt32(ctx, errno);
    }

    if(reason == LWS_CALLBACK_RAW_CLOSE) {
      /*JS_FreeValue(ctx, argv[--argi]);
      JS_FreeValue(ctx, argv[--argi]);*/

      argv[argi++] = JS_NewInt32(ctx, errno);
    }

    JSValue result = JS_Call(ctx, *cb, jsval ? *jsval : JS_NULL, argi, argv);

    if(JS_IsException(result)) {
      JSValue error = JS_GetException(ctx);
      js_error_print(ctx, error);
      JS_FreeValue(ctx, error);
      /*  ret = -1;
        goto end;*/
    }

    if(reason == LWS_CALLBACK_CLIENT_APPEND_HANDSHAKE_HEADER) {
      int64_t n = to_int64(ctx, JS_GetPropertyUint32(ctx, argv[argi - 1], 0));

      *(uint8_t**)in += MIN(MAX(0, n), (int64_t)len);

    } else if(process_html_args) {
      struct lws_process_html_args* pha = (struct lws_process_html_args*)in;
      int64_t n = to_int64(ctx, JS_GetPropertyUint32(ctx, argv[argi - 1], 0));

      pha->p += MIN(MAX(0, n), (int64_t)(pha->max_len - pha->len));
    }

    for(int j = 0; j < argi; j++) {
      /* Detach the one ArrayBuffer that wraps lws's own transient
         stack/heap memory (pha->p / *(uint8_t**)in) at its own index -
         comparing against argi here instead of j would never match, since
         every branch that sets buffer_index pushes at least one more arg
         afterward, leaving buffer_index < argi always. Without detaching,
         JS code that retains this ArrayBuffer past the callback returning
         could read/write memory lws has already reused for something else. */
      if(buffer_index == j)
        JS_DetachArrayBuffer(ctx, argv[j]);
      JS_FreeValue(ctx, argv[j]);
    }

    ret = to_int32free(ctx, result);
  }

  if(s && s->closed)
    ret = -1;

  /*  if(reason == LWS_CALLBACK_CLIENT_APPEND_HANDSHAKE_HEADER)
      if(s && s->method == WSI_TOKEN_POST_URI)
        if(!lws_http_is_redirected_to_get(wsi)) {
          lwsl_user("%s: doing POST flow\n", __func__);
          lws_client_http_body_pending(wsi, 1);
          lws_callback_on_writable(wsi);
        }*/

  if(reason != LWS_CALLBACK_PROTOCOL_INIT && reason != LWS_CALLBACK_HTTP_BIND_PROTOCOL) {
    if(s && s->completed)
      ret = -1;
  }

  if(ret != 0) {
    int fd = lws_get_socket_fd(wsi);

    if(fd != -1)
      iohandler_clear(lc, fd);

    lws_wsi_close(wsi, LWS_TO_KILL_ASYNC);
    // lws_close_free_wsi(wsi, LWS_CLOSE_STATUS_NOSTATUS, __func__);
  }

end:
  JS_FreeValue(ctx, sock);

  /*if(ret == 0)
    return lws_callback_http_dummy(wsi, reason, user, in, len);*/

  return ret;
}

static JSValue
callback_c(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[], int magic, void* closure) {
  const LWSProtocols* proto = closure;
  struct lws* wsi = 0;
  int reason = -1;
  char* str = 0;
  void *user = 0, *in = 0;
  size_t len = 0;

  if(argc > 0)
    wsi = lwsjs_socket_wsi(argv[0]);

  if(argc > 1)
    reason = to_int32(ctx, argv[1]);

  if(JS_IsObject(this_val) && !JS_IsNull(this_val))
    user = &this_val;

  if(argc > 2)
    if(!(in = JS_GetArrayBuffer(ctx, &len, argv[2])))
      in = str = to_stringlen(ctx, &len, argv[2]);

  if(argc > 3)
    len = to_uint32(ctx, argv[3]);

  JSValue ret = JS_NewInt32(ctx, proto->callback(wsi, reason, user, in, len));

  if(str)
    js_free(ctx, str);

  return ret;
}
