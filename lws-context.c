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
#include "lws-vhost.h"
#include "lws-sockaddr46.h"
#include "lws-tls.h"
#include "lws.h"
#include "js-utils.h"
#include "iohandler.h"
#ifdef USE_EPOLL
#include "lws-epoll.h"
#endif
#include "lws-mount.h"
#include "lws-vhost-option.h"
#include "lws-protocol.h"

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

static int callback_pollfd(struct lws*, enum lws_callback_reasons, void*, void*, size_t);
static JSValue callback_c(JSContext*, JSValueConst, int, JSValueConst[], int, void*);

static void callback_patch_system_vhost(struct lws_context*);
static void service_tick_schedule(LWSContext*, int);
static void service_tick_cancel(LWSContext*);

static JSValue
pollfd_handler(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic, JSValueConst data[]) {
  struct lws_context* lws = to_ptr(ctx, data[3]);
  struct lws_pollfd pf = {
      .fd = to_int32(ctx, data[0]),
      .events = to_int32(ctx, data[1]),
      .revents = JS_ToBool(ctx, data[2]) ? POLLOUT : POLLIN,
  };

  lws_service_fd(lws, &pf);

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
  while(lws_service_adjust_timeout(lws, 1, 0) == 0)
    lws_service_tsi(lws, -1, 0);

  return JS_UNDEFINED;
}

/*
 * Base interval (ms) for the periodic forced-service tick below. The
 * forced-service check in pollfd_handler() above only runs when some fd
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
  LWSContext* lws = to_ptr(ctx, func_data[0]);

  /* The timer that invoked this callback has already fired (and
     quickjs-libc frees its own OSTimer state internally once it does) -
     drop our reference to it before service_tick_schedule() below
     overwrites service_timer_id with the next one. */
  JS_FreeValue(ctx, lws->service_timer_id);
  lws->service_timer_id = JS_UNDEFINED;

  if(!lws->ctx)
    return JS_UNDEFINED;

  if(lws_service_adjust_timeout(lws->ctx, SERVICE_TICK_MS, 0) == 0) {
    lws_service_tsi(lws->ctx, -1, 0);
    service_tick_schedule(lws, 1);
  } else {
    service_tick_schedule(lws, SERVICE_TICK_MS);
  }

  return JS_UNDEFINED;
}

static void
service_tick_schedule(LWSContext* lws, int delay_ms) {
  JSValue glob = JS_GetGlobalObject(lws->js);
  JSValue os = JS_GetPropertyStr(lws->js, glob, "os");
  JS_FreeValue(lws->js, glob);
  JSValue fn = JS_GetPropertyStr(lws->js, os, "setTimeout");
  JS_FreeValue(lws->js, os);
  JSValueConst data[] = {
      JS_NewInt64(lws->js, (intptr_t)lws),
  };
  JSValue cb = JS_NewCFunctionData(lws->js, service_tick, 0, 0, countof(data), data);
  JSValue args[2] = {cb, JS_NewInt32(lws->js, delay_ms)};

  /* os.setTimeout() returns an opaque "OSTimer" JS object in this
     quickjs-libc, not a plain numeric id (unlike, say, Node's timer
     handles being coercible to a number) - JS_ToInt32-ing it throws a
     stray, never-checked "toPrimitive" TypeError, since the object has
     no valueOf/toString. Keep the object itself; it goes back into
     os.clearTimeout() unchanged in service_tick_cancel(). */
  lws->service_timer_id = JS_Call(lws->js, fn, JS_NULL, 2, args);

  JS_FreeValue(lws->js, cb);
  JS_FreeValue(lws->js, fn);
}

static void
service_tick_cancel(LWSContext* lws) {
  if(JS_IsUndefined(lws->service_timer_id) || !lws->js)
    return;

  JSValue glob = JS_GetGlobalObject(lws->js);
  JSValue os = JS_GetPropertyStr(lws->js, glob, "os");
  JS_FreeValue(lws->js, glob);
  JSValue fn = JS_GetPropertyStr(lws->js, os, "clearTimeout");
  JS_FreeValue(lws->js, os);

  JSValue ret = JS_Call(lws->js, fn, JS_NULL, 1, &lws->service_timer_id);

  JS_FreeValue(lws->js, ret);
  JS_FreeValue(lws->js, fn);

  JS_FreeValue(lws->js, lws->service_timer_id);
  lws->service_timer_id = JS_UNDEFINED;
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
  str_property(&ci->iface, ctx, obj, "iface");
  str_property(&ci->vhost_name, ctx, obj, "vhost_name");

  JSValue value = JS_GetPropertyStr(ctx, obj, "protocols");
  ci->protocols = lwsjs_protocols_fromarray(ctx, value);
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
  ci->headers = lwsjs_vhost_options_fromfree(ctx, value);

  value = js_get_property(ctx, obj, "reject_service_keywords");
  ci->reject_service_keywords = lwsjs_vhost_options_from(ctx, value);
  JS_FreeValue(ctx, value);

  value = JS_GetPropertyStr(ctx, obj, "pvo");
  ci->pvo = lwsjs_vhost_options_fromfree(ctx, value);

  str_property(&ci->log_filepath, ctx, obj, "log_filepath");

  value = JS_GetPropertyStr(ctx, obj, "mounts");
  ci->mounts = lwsjs_mount_from(ctx, value, NULL);
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
    lwsjs_protocols_free(rt, (struct lws_protocols*)ci->protocols);

  if(ci->http_proxy_address)
    js_free_rt(rt, (char*)ci->http_proxy_address);

  if(ci->headers)
    lwsjs_vhost_options_free(rt, (struct lws_protocol_vhost_options*)ci->headers);

  if(ci->reject_service_keywords)
    lwsjs_vhost_options_free(rt, (struct lws_protocol_vhost_options*)ci->reject_service_keywords);

  if(ci->pvo)
    lwsjs_vhost_options_free(rt, (struct lws_protocol_vhost_options*)ci->pvo);

  if(ci->log_filepath)
    js_free_rt(rt, (char*)ci->log_filepath);

  if(ci->mounts)
    lwsjs_mounts_free(rt, (struct lws_http_mount*)ci->mounts);

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
  LWSContext* lws;

  if((lws = js_mallocz(ctx, sizeof(LWSContext)))) {
    init_list_head(&lws->handlers);

    /* js_mallocz() zero-fills, which isn't guaranteed to be JS_UNDEFINED's
       actual bit pattern - set it explicitly rather than relying on that. */
    lws->service_timer_id = JS_UNDEFINED;
  }

  return lws;
}

static void
context_free(JSRuntime* rt, LWSContext* lws) {
#ifdef USE_EPOLL
  lws_epoll_destroy(lws);
#endif

  if(lws->js) {
    service_tick_cancel(lws);
    JS_FreeContext(lws->js);
    lws->js = NULL;
  }

  if(lws->info.user) {
    obj_free(rt, lws->info.user);
    lws->info.user = NULL;
  }

  if(lws->ctx) {
    lws_context_destroy(lws->ctx);
    lws->ctx = NULL;
  }

  context_creation_info_free(rt, &lws->info);

  js_free_rt(rt, lws);
}

JSClassID lwsjs_context_class_id;
static JSValue lwsjs_context_proto, lwsjs_context_ctor;

static JSValue
lwsjs_context_constructor(JSContext* ctx, JSValueConst new_target, int argc, JSValueConst argv[]) {
  LWSContext* lws;

  if(!(lws = context_new(ctx)))
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
    context_creation_info_fromobj(ctx, argv[0], &lws->info);

  JS_SetOpaque(obj, lws);

  lws->js = JS_DupContext(ctx);
  lws->info.user = obj_ptr(ctx, obj);

  if(!js_has_property(ctx, argv[0], "port"))
    lws->info.port = CONTEXT_PORT_NO_LISTEN;

  /* This must be called last, because it can trigger callbacks already */
  lws->ctx = lws_create_context(&lws->info);

  callback_patch_system_vhost(lws->ctx);

  if(lws->ctx)
    service_tick_schedule(lws, SERVICE_TICK_MS);

  JS_DefinePropertyValueStr(ctx, obj, "info", JS_DupValue(ctx, argv[0]), JS_PROP_CONFIGURABLE);

  return obj;

fail:
  js_free(ctx, lws);
  JS_FreeValue(ctx, obj);
  return JS_EXCEPTION;
}

enum {
  METHOD_DESTROY,
  METHOD_GETVHOSTBYNAME,
  METHOD_ADOPTSOCKET,
  METHOD_ADOPTSOCKET_READBUF,
  METHOD_CANCELSERVICE,
  METHOD_CLIENTCONNECT,
  METHOD_GETRANDOM,
  METHOD_ASYNCDNSSERVER_ADD,
  METHOD_ASYNCDNSSERVER_REMOVE,
  METHOD_WSIFROMFD,
#ifdef LWS_WITH_UDP
  METHOD_CREATEUDP,
#endif
};

static JSValue
lwsjs_context_methods(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[], int magic) {
  LWSContext* lws;
  JSValue ret = JS_UNDEFINED;

  if(!(lws = lwsjs_context_data2(ctx, this_val)))
    return JS_EXCEPTION;

  if(lws->ctx == NULL && magic != METHOD_DESTROY)
    return JS_ThrowInternalError(ctx, "LWSContext internal lws_context has been destroyed");

  switch(magic) {
    case METHOD_DESTROY: {
      if(lws->ctx) {
        lws_context_destroy(lws->ctx);
        lws->ctx = NULL;
        ret = JS_TRUE;
      }

      break;
    }

    case METHOD_GETVHOSTBYNAME: {
      const char* name;

      if((name = JS_ToCString(ctx, argv[0]))) {
        struct lws_vhost* vho;

        if((vho = lws_get_vhost_by_name(lws->ctx, name)))
          ret = lws_vhost_object(ctx, vho);

        JS_FreeCString(ctx, name);
      }

      break;
    }

    case METHOD_ADOPTSOCKET: {
      int32_t arg = to_int32(ctx, argv[0]);
      struct lws* wsi;

      if(wsi_from_fd(lws->ctx, arg))
        return JS_ThrowInternalError(ctx, "socket %" PRIi32 " already adopted", arg);

      if((wsi = lws_adopt_socket(lws->ctx, arg)))
        ret = lwsjs_socket_create(ctx, wsi);

      break;
    }

    case METHOD_ADOPTSOCKET_READBUF: {
      int32_t arg = to_int32(ctx, argv[0]);
      struct lws* wsi;
      size_t len;
      uint8_t* buf;

      if(wsi_from_fd(lws->ctx, arg))
        return JS_ThrowInternalError(ctx, "socket %" PRIi32 " already adopted", arg);

      if(!(buf = get_buffer(ctx, argc - 1, argv + 1, &len)))
        return JS_ThrowTypeError(ctx, "argument 2 must be an arraybuffer");

      if((wsi = lws_adopt_socket_readbuf(lws->ctx, arg, (const char*)buf, len)))
        ret = lwsjs_socket_create(ctx, wsi);

      break;
    }

    case METHOD_CANCELSERVICE: {
      lws_cancel_service(lws->ctx);
      iohandler_cleanup(lws);
      service_tick_cancel(lws);
      break;
    }

    case METHOD_CLIENTCONNECT: {
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

      info.context = lws->ctx;
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

    case METHOD_GETRANDOM: {
      size_t n;
      uint8_t* p;

      if((p = get_buffer(ctx, argc, argv, &n)))
        lws_get_random(lws->ctx, p, n);

      break;
    }

    case METHOD_ASYNCDNSSERVER_ADD: {
      JSValue addr = lwsjs_sockaddr46_value(ctx, argv[0]);
      lws_sockaddr46* sa46 = lwsjs_sockaddr46_data(ctx, addr);

      ret = JS_NewInt32(ctx, lws_async_dns_server_add(lws->ctx, sa46));

      JS_FreeValue(ctx, addr);
      break;
    }

    case METHOD_ASYNCDNSSERVER_REMOVE: {
      JSValue addr = lwsjs_sockaddr46_value(ctx, argv[0]);
      lws_sockaddr46* sa46 = lwsjs_sockaddr46_data(ctx, addr);

      lws_async_dns_server_remove(lws->ctx, sa46);

      JS_FreeValue(ctx, addr);
      break;
    }

    case METHOD_WSIFROMFD: {
      struct lws* wsi;

      if((wsi = wsi_from_fd(lws->ctx, to_int32(ctx, argv[0]))))
        ret = js_socket_get(ctx, wsi);
      break;
    }

#ifdef LWS_WITH_UDP
    case METHOD_CREATEUDP: {
      /* lws_create_adopt_udp() has no client-connect equivalent of its own:
         UDP is connectionless, so both "bind a listening socket that will
         receive datagrams from any peer" and "create a socket pre-connected
         to one fixed remote peer" go through this single entry point,
         distinguished only by whether an address was given / LWS_CAUDP_BIND
         is set. See onRawRx's extra sockaddr46 argument (below, in
         lwsjs_protocol_callback) for how a listener tells its many peers apart -
         a single UDP wsi, unlike TCP, never gets one child wsi per peer. */
      JSValueConst opts = argv[0];
      char *address = 0, *protocol = 0, *iface = 0, *vhost_name = 0;
      int32_t port = -1;
      BOOL bind = FALSE, broadcast = FALSE;
      struct lws_vhost* vh;

      if(JS_IsObject(opts)) {
        str_property((const char**)&address, ctx, opts, "address");
        str_property((const char**)&protocol, ctx, opts, "protocol");
        str_property((const char**)&iface, ctx, opts, "iface");
        str_property((const char**)&vhost_name, ctx, opts, "vhost");

        if(js_has_property(ctx, opts, "port"))
          port = to_integerfree(ctx, js_get_property(ctx, opts, "port"));

        bind = to_boolfree(ctx, js_get_property(ctx, opts, "bind"));
        broadcast = to_boolfree(ctx, js_get_property(ctx, opts, "broadcast"));
      }

      if(!protocol) {
        ret = JS_ThrowTypeError(ctx, "createUdp: 'protocol' is required (name of a protocol on the vhost)");
        goto udp_out;
      }

      if(!(vh = lws_get_vhost_by_name(lws->ctx, vhost_name ? vhost_name : (lws->info.vhost_name ? lws->info.vhost_name : "default")))) {
        ret = JS_ThrowInternalError(ctx, "createUdp: no such vhost");
        goto udp_out;
      }

      {
        int flags = ((bind || !address) ? LWS_CAUDP_BIND : 0) | (broadcast ? LWS_CAUDP_BROADCAST : 0);
        LWSSocket* sock = socket_alloc(ctx);

        sock->type = SOCKET_RAW;
        ret = lwsjs_socket_wrap(ctx, sock);

        /* lws_create_adopt_udp2() (adopt.c) runs whatever `ads` resolves to
           through lws_sort_dns(), and lws_sort_dns() unconditionally
           returns "failed" for a NULL addrinfo list (sort-dns.c) - so a
           NULL `ads` (the natural way to ask for "bind any interface")
           makes wsi creation fail outright, regardless of LWS_CAUDP_BIND.
           Passing an explicit "any" address instead gives it a one-result
           addrinfo list to sort (even a literal numeric address still
           round-trips through getaddrinfo()/async-dns), which works. */
        struct lws* wsi = lws_create_adopt_udp(vh, address ? address : "0.0.0.0", port, flags, protocol, iface, NULL, obj_ptr(ctx, ret), NULL, NULL);

        if(!wsi) {
          JS_FreeValue(ctx, ret);
          ret = JS_ThrowInternalError(ctx, "createUdp: lws_create_adopt_udp failed");
        } else {
          sock->wsi = wsi;
        }
      }

    udp_out:
      if(address)
        js_free(ctx, address);
      if(protocol)
        js_free(ctx, protocol);
      if(iface)
        js_free(ctx, iface);
      if(vhost_name)
        js_free(ctx, vhost_name);

      break;
    }
#endif
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
  LWSContext* lws;
  JSValue ret = JS_UNDEFINED;

  if(!(lws = lwsjs_context_data2(ctx, this_val)))
    return JS_EXCEPTION;

  switch(magic) {
    case PROP_HOSTNAME: {
      const char* s;

      if((s = lws_canonical_hostname(lws->ctx)))
        ret = JS_NewString(ctx, s);

      break;
    }

    case PROP_DEPRECATED: {
      ret = JS_NewBool(ctx, lws_context_is_deprecated(lws->ctx));
      break;
    }

    case PROP_EUID:
    case PROP_EGID: {
      uid_t uid;
      gid_t gid;

      lws_get_effective_uid_gid(lws->ctx, &uid, &gid);

      ret = JS_NewInt32(ctx, magic == PROP_EUID ? uid : gid);

      break;
    }

    case PROP_PROTOCOLS: {
      ret = JS_NewArray(ctx);

      for(uint32_t i = 0; lws->info.protocols[i].name; i++)
        JS_SetPropertyUint32(ctx, ret, i, lwsjs_protocol_obj(ctx, &lws->info.protocols[i]));

      break;
    }
  }

  return ret;
}

static void
lwsjs_context_finalizer(JSRuntime* rt, JSValue val) {
  LWSContext* lws;

  if((lws = lwsjs_context_data(val)))
    context_free(rt, lws);
}

static const JSClassDef lws_context_class = {
    "LWSContext",
    .finalizer = lwsjs_context_finalizer,
};

static const JSCFunctionListEntry lws_context_proto_funcs[] = {
    JS_CFUNC_MAGIC_DEF("destroy", 0, lwsjs_context_methods, METHOD_DESTROY),
    JS_CFUNC_MAGIC_DEF("getVhostByName", 1, lwsjs_context_methods, METHOD_GETVHOSTBYNAME),
    JS_CFUNC_MAGIC_DEF("adoptSocket", 1, lwsjs_context_methods, METHOD_ADOPTSOCKET),
    JS_CFUNC_MAGIC_DEF("adoptSocketReadbuf", 2, lwsjs_context_methods, METHOD_ADOPTSOCKET_READBUF),
    JS_CFUNC_MAGIC_DEF("cancelService", 0, lwsjs_context_methods, METHOD_CANCELSERVICE),
    JS_CFUNC_MAGIC_DEF("clientConnect", 1, lwsjs_context_methods, METHOD_CLIENTCONNECT),
    JS_CFUNC_MAGIC_DEF("getRandom", 1, lwsjs_context_methods, METHOD_GETRANDOM),
    JS_CFUNC_MAGIC_DEF("asyncDnsServerAdd", 1, lwsjs_context_methods, METHOD_ASYNCDNSSERVER_ADD),
    JS_CFUNC_MAGIC_DEF("asyncDnsServerRemove", 1, lwsjs_context_methods, METHOD_ASYNCDNSSERVER_REMOVE),
    JS_CFUNC_MAGIC_DEF("wsiFromFd", 1, lwsjs_context_methods, METHOD_WSIFROMFD),
#ifdef LWS_WITH_UDP
    JS_CFUNC_MAGIC_DEF("createUdp", 1, lwsjs_context_methods, METHOD_CREATEUDP),
#endif
    JS_CGETSET_MAGIC_DEF("hostname", lwsjs_context_get, 0, PROP_HOSTNAME),
    JS_CGETSET_MAGIC_DEF("deprecated", lwsjs_context_get, 0, PROP_DEPRECATED),
    JS_CGETSET_MAGIC_DEF("euid", lwsjs_context_get, 0, PROP_EUID),
    JS_CGETSET_MAGIC_DEF("egid", lwsjs_context_get, 0, PROP_EGID),
    JS_CGETSET_MAGIC_DEF("protocols", lwsjs_context_get, 0, PROP_PROTOCOLS),
    JS_PROP_STRING_DEF("[Symbol.toStringTag]", "LWSContext", JS_PROP_CONFIGURABLE),
};

static JSValue
lwsjs_create_server(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[]) {
  return JS_CallConstructor(ctx, lwsjs_context_ctor, argc, argv);
}

static const JSCFunctionListEntry lws_context_funcs[] = {
    JS_CFUNC_DEF("createServer", 1, lwsjs_create_server),
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
  struct lws_protocols const* pro = wsi ? lws_get_protocol(wsi) : NULL;
  LWSHandlers* handlers = pro ? pro->user : NULL;
  LWSContext* lws = lwsjs_wsi_context(wsi);
  JSContext* ctx = handlers && handlers->ctx ? handlers->ctx : lwsjs_context_jsctx(lws);

  switch(reason) {
    case LWS_CALLBACK_LOCK_POLL:
    case LWS_CALLBACK_UNLOCK_POLL: {
      return 0;
    }

    case LWS_CALLBACK_DEL_POLL_FD: {
      struct lws_pollargs* x = in;

#ifdef USE_EPOLL
      lws_epoll_del(lws, x->fd);
#else
      iohandler_set(lws, x->fd, JS_NULL, 0);
      iohandler_set(lws, x->fd, JS_NULL, 1);
#endif
      return 0;
    }

    case LWS_CALLBACK_ADD_POLL_FD:
    case LWS_CALLBACK_CHANGE_MODE_POLL_FD: {
      struct lws_pollargs* x = in;

      if(x->events == x->prev_events)
        return 0;

#ifdef USE_EPOLL
      lws_epoll_ctl(lws, x->fd, x->events);
#else
      BOOL write = !!(x->events & POLLOUT);
      JSValueConst data[] = {
          JS_NewInt32(ctx, x->fd),
          JS_NewInt32(ctx, x->events),
          JS_NewBool(ctx, write),
          JS_NewInt64(ctx, (intptr_t)lws_get_context(wsi)),
      };
      JSValue fn = JS_NewCFunctionData(ctx, pollfd_handler, 0, 0, countof(data), data);

      if(reason == LWS_CALLBACK_CHANGE_MODE_POLL_FD)
        iohandler_set(lws, x->fd, JS_NULL, !write);

      iohandler_set(lws, x->fd, fn, write);

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
 * lwsjs_protocols_fromarray() builds. Since pollfd management (LOCK_POLL,
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
static lws_callback_function* callback_asyncdns_system_vhost;

static int
callback_pollfd_system_vhost(struct lws* wsi, enum lws_callback_reasons reason, void* user, void* in, size_t len) {
  if(is_pollfd_reason(reason))
    if(callback_pollfd(wsi, reason, user, in, len) == 0)
      return 0;

  return callback_asyncdns_system_vhost ? callback_asyncdns_system_vhost(wsi, reason, user, in, len) : 0;
}

static void
callback_patch_system_vhost(struct lws_context* ctx) {
  struct lws_vhost* vh;
  const struct lws_protocols* pro;

  if(!ctx || !(vh = lws_get_vhost_by_name(ctx, "system")))
    return;

  if(!(pro = lws_vhost_name_to_protocol(vh, "lws-async-dns")))
    return;

  if(pro->callback == callback_pollfd_system_vhost)
    return;

  callback_asyncdns_system_vhost = pro->callback;
  ((struct lws_protocols*)pro)->callback = callback_pollfd_system_vhost;
}
