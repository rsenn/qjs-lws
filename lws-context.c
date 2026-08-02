#define _XOPEN_SOURCE 600
#include <quickjs.h>
#include <cutils.h>
#include <list.h>
#include <libwebsockets.h>
#include <lws_config.h>
#include <assert.h>
#include <limits.h>
#include <stdlib.h>
#include <strings.h>
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
#include "lws-protocol.h"

static void callback_patch_system_vhost(struct lws_context*);
static void service_tick_schedule(LWSContext*, int);
static void service_tick_cancel(LWSContext*);

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

/* Backoff/connection-validity policy - `retry: { retryMsTable: [...],
   concealCount, jitterPercent, secsSinceValidPing, secsSinceValidHangup }`
   on context-creation info (LWSContext-/vhost-lifetime), or on a single
   client-connect call (wsi-lifetime - see the METHOD_CLIENTCONNECT comment
   on why that one is owned by the LWSSocket, not freed alongside the rest
   of the connect-info struct). lws stores the *pointer* we return here on
   the vhost/wsi (vhost.c/connect.c: `vh->retry_policy = info->…`), not a
   copy of its contents, so whatever we allocate must outlive the
   vhost/wsi it's attached to - that's why this returns a heap object for
   the caller to own, rather than filling in a caller-supplied struct. */
static lws_retry_bo_t*
retry_bo_from_retryobj(JSContext* ctx, JSValueConst retry_obj) {
  lws_retry_bo_t* bo = NULL;

  if(JS_IsObject(retry_obj)) {
    JSValue table_val = JS_GetPropertyStr(ctx, retry_obj, "retryMsTable");
    uint32_t* table = NULL;
    uint32_t count = 0;

    if(JS_IsArray(ctx, table_val)) {
      JSValue len_val = JS_GetPropertyStr(ctx, table_val, "length");
      JS_ToUint32(ctx, &count, len_val);
      JS_FreeValue(ctx, len_val);

      if(count > 0 && (table = js_mallocz(ctx, sizeof(uint32_t) * count)))
        for(uint32_t i = 0; i < count; i++)
          table[i] = to_integerfree(ctx, JS_GetPropertyUint32(ctx, table_val, i));
    }

    JS_FreeValue(ctx, table_val);

    if(table) {
      if((bo = js_mallocz(ctx, sizeof(lws_retry_bo_t)))) {
        bo->retry_ms_table = table;
        bo->retry_ms_table_count = (uint16_t)count;
        /* Default conceal_count to the whole table (don't report failure
           to the app until every entry's been tried once) unless given
           explicitly. */
        bo->conceal_count = (uint16_t)(js_has_property(ctx, retry_obj, "concealCount") ? to_integerfree(ctx, js_get_property(ctx, retry_obj, "concealCount")) : count);
        bo->secs_since_valid_ping = (uint16_t)to_integerfree(ctx, js_get_property(ctx, retry_obj, "secsSinceValidPing"));
        bo->secs_since_valid_hangup = (uint16_t)to_integerfree(ctx, js_get_property(ctx, retry_obj, "secsSinceValidHangup"));
        bo->jitter_percent = (uint8_t)to_integerfree(ctx, js_get_property(ctx, retry_obj, "jitterPercent"));
      } else {
        js_free(ctx, table);
      }
    }
  }

  return bo;
}

static lws_retry_bo_t*
retry_bo_fromobj(JSContext* ctx, JSValueConst obj) {
  JSValue retry_obj = JS_GetPropertyStr(ctx, obj, "retry");
  lws_retry_bo_t* bo = retry_bo_from_retryobj(ctx, retry_obj);

  JS_FreeValue(ctx, retry_obj);
  return bo;
}

static void
retry_bo_free(JSRuntime* rt, const lws_retry_bo_t* bo) {
  if(bo) {
    if(bo->retry_ms_table)
      js_free_rt(rt, (void*)bo->retry_ms_table);

    js_free_rt(rt, (void*)bo);
  }
}

#if defined(LWS_WITH_UDP) && defined(LWS_WITH_NETWORK)
typedef struct {
  JSContext* ctx;
  JSValue resolving_funcs[2];
} LWSDnsQuery;

/* lws_async_dns_cb_t - fires exactly once, either synchronously from inside
   lws_async_dns_query() (cache hit / immediate failure to start) or later
   from the event loop, so `q` must already be fully set up (both promise
   resolving funcs stashed) before that call is made. Since no wsi is
   involved (a standalone lookup, not tied to a client connection), we pass
   wsi=NULL and lws routes the callback through q->standalone_cb instead of
   binding it to a wsi - see lws_async_dns_query() in async-dns.c. */
static struct lws*
lwsjs_resolve_cb(struct lws* wsi, const char* ads, const struct addrinfo* result, int n, void* opaque) {
  LWSDnsQuery* q = opaque;
  JSContext* ctx = q->ctx;
  JSValue ret;

  /* n is LADNS_RET_FOUND (0) on success, possibly OR'd with the
     LWS_ADNS_DNSSEC_VALID/INVALID high bits - so a plain ==0 check would
     wrongly treat a DNSSEC-flagged success as failure. Negative values are
     the LADNS_RET_* error codes. */
  if(n >= 0) {
    JSValue arr = JS_NewArray(ctx);
    uint32_t i = 0;
    const struct addrinfo* p;

    for(p = result; p; p = p->ai_next) {
      lws_sockaddr46 sa46;

      if(p->ai_addr && p->ai_addrlen <= sizeof(sa46)) {
        char buf[64];

        memset(&sa46, 0, sizeof(sa46));
        memcpy(&sa46, p->ai_addr, p->ai_addrlen);

        if(lws_sa46_write_numeric_address(&sa46, buf, sizeof(buf)) > 0)
          JS_SetPropertyUint32(ctx, arr, i++, JS_NewString(ctx, buf));
      }
    }

    ret = JS_Call(ctx, q->resolving_funcs[0], JS_UNDEFINED, 1, (JSValueConst*)&arr);
    JS_FreeValue(ctx, ret);
    JS_FreeValue(ctx, arr);

    if(result)
      lws_async_dns_freeaddrinfo(&result);
  } else {
    JSValue err = JS_NewError(ctx);

    JS_SetPropertyStr(ctx, err, "message", JS_NewString(ctx, "DNS resolve failed"));
    ret = JS_Call(ctx, q->resolving_funcs[1], JS_UNDEFINED, 1, (JSValueConst*)&err);
    JS_FreeValue(ctx, ret);
    JS_FreeValue(ctx, err);
  }

  JS_FreeValue(ctx, q->resolving_funcs[0]);
  JS_FreeValue(ctx, q->resolving_funcs[1]);
  js_free_rt(JS_GetRuntime(ctx), q);

  return NULL;
}
#endif

/* ctx.schedule(fn, ms) - a one-shot timer backed by lws's own sul scheduler
   (lws-timeout-timer.h), so it fires on the same event-loop tick as
   everything else this context does, instead of running through a second,
   unrelated timer source (os.setTimeout). `t` is tracked on lws->timers
   (list_head, lws-context.h) purely so .cancel() can look the pointer up
   before touching it - firing removes it from that list and frees it, so a
   .cancel() call arriving after the fact (or a second .cancel() call) finds
   nothing and safely no-ops instead of dereferencing freed memory. */
typedef struct {
  struct list_head link;
  lws_sorted_usec_list_t sul;
  LWSContext* lws;
  JSValue callback;
} LWSTimer;

static void
lwsjs_timer_fire(lws_sorted_usec_list_t* sul) {
  LWSTimer* t = lws_container_of(sul, LWSTimer, sul);
  JSContext* ctx = t->lws->js;
  JSValue callback = t->callback;
  JSValue ret;

  list_del(&t->link);
  js_free_rt(JS_GetRuntime(ctx), t);

  ret = JS_Call(ctx, callback, JS_UNDEFINED, 0, NULL);
  JS_FreeValue(ctx, ret);
  JS_FreeValue(ctx, callback);
}

static JSValue
lwsjs_timer_cancel(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[], int magic, JSValueConst func_data[]) {
  LWSContext* lws = to_ptr(ctx, func_data[0]);
  LWSTimer* target = to_ptr(ctx, func_data[1]);
  struct list_head* el;

  list_for_each(el, &lws->timers) {
    LWSTimer* t = list_entry(el, LWSTimer, link);

    if(t == target) {
      list_del(&t->link);
      lws_sul_cancel(&t->sul);
      JS_FreeValue(ctx, t->callback);
      js_free_rt(JS_GetRuntime(ctx), t);
      break;
    }
  }

  return JS_UNDEFINED;
}

/* Cancels and frees every still-pending ctx.schedule() timer - called from
   METHOD_DESTROY and context_free() before the lws_context itself goes
   away, since lws_sul_cancel() on a sul belonging to an already-destroyed
   context is unsafe (its owning scheduler list is gone), and leaving the
   JSValue callbacks unreleased would otherwise leak them. */
static void
timers_cleanup(LWSContext* lws) {
  struct list_head *el, *next;

  list_for_each_safe(el, next, &lws->timers) {
    LWSTimer* t = list_entry(el, LWSTimer, link);

    list_del(&t->link);

    if(lws->ctx)
      lws_sul_cancel(&t->sul);

    JS_FreeValue(lws->js, t->callback);
    js_free_rt(JS_GetRuntime(lws->js), t);
  }
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

  /* Not freed by client_connect_info_free() below: lws stores this pointer
     on the wsi itself (connect.c: `wsi->retry_policy = i->…`), which
     outlives this stack-allocated info struct - ownership is moved onto
     the LWSSocket instead (see METHOD_CLIENTCONNECT) and freed there when
     the socket itself is destroyed. */
  ci->retry_and_idle_policy = retry_bo_fromobj(ctx, obj);
}

static void
client_connect_info_from_uri(JSContext* ctx, char* uri, struct lws_client_connect_info* info) {
  const char *protocol, *host, *path;
  int port;
  int r = lws_parse_uri(uri, &protocol, &host, &port, &path);

  if(protocol) {
    BOOL ssl = !strcmp(protocol, "https") || !strcmp(protocol, "wss");
    BOOL http = !strncmp(protocol, "http", 4);

    if(http)
      str_replace(ctx, &info->method, js_strdup(ctx, "GET"));

    if(ssl)
      info->ssl_connection |= LCCSCF_USE_SSL | LCCSCF_ALLOW_SELFSIGNED | LCCSCF_ALLOW_EXPIRED | LCCSCF_SKIP_SERVER_CERT_HOSTNAME_CHECK | LCCSCF_ALLOW_INSECURE;
    else
      info->ssl_connection &= ~(LCCSCF_USE_SSL | LCCSCF_ALLOW_SELFSIGNED | LCCSCF_ALLOW_EXPIRED | LCCSCF_SKIP_SERVER_CERT_HOSTNAME_CHECK | LCCSCF_ALLOW_INSECURE);
  }

  if(host)
    str_replace(ctx, &info->host, js_strdup(ctx, host));

  info->port = port;

  if(path)
    str_replace(ctx, &info->path, js_strdup(ctx, path));
}

static char*
client_connect_info_to_uri(JSContext* ctx, const struct lws_client_connect_info* info) {
  DynBuf db = {0};
  dbuf_init2(&db, ctx, (void*)&js_realloc);

  dbuf_putstr(&db, info->method ? (info->ssl_connection ? "https" : "http") : (info->ssl_connection ? "wss" : "ws"));
  dbuf_putstr(&db, "://");

  dbuf_putstr(&db, info->host ? info->host : "0.0.0.0");

  if(info->port) {
    dbuf_putc(&db, ':');
    dbuf_printf(&db, "%u", info->port);
  }

  if(info->path)
    dbuf_putstr(&db, info->path);

  dbuf_putc(&db, '\0');
  return (char*)db.buf;
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
lwsjs_context_creation_info_fromobj(JSContext* ctx, JSValueConst obj, struct lws_context_creation_info* ci) {
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
  ci->mounts = lwsjs_mounts_from(ctx, value);
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

#if defined(LWS_WITH_CACHE_NSCOOKIEJAR) && defined(LWS_WITH_CLIENT)
  /* Persistent client cookie jar (Netscape-format file), shared by every
     connection this context makes. Per-connection opt-in is the separate
     LCCSCF_CACHE_COOKIES ssl_connection flag (tls_connect_info_fromobj(),
     lws-tls.c) - setting cookieJar here just makes the jar exist, it
     doesn't turn cookie capture/replay on for any given request. */
  value = JS_GetPropertyStr(ctx, obj, "cookieJar");

  if(JS_IsObject(value)) {
    str_property(&ci->http_nsc_filepath, ctx, value, "path");

    if(js_has_property(ctx, value, "maxFootprint"))
      ci->http_nsc_heap_max_footprint = to_integerfree(ctx, js_get_property(ctx, value, "maxFootprint"));

    if(js_has_property(ctx, value, "maxItems"))
      ci->http_nsc_heap_max_items = to_integerfree(ctx, js_get_property(ctx, value, "maxItems"));

    if(js_has_property(ctx, value, "maxPayload"))
      ci->http_nsc_heap_max_payload = to_integerfree(ctx, js_get_property(ctx, value, "maxPayload"));
  }

  JS_FreeValue(ctx, value);
#endif

  /* Context/vhost-lifetime backoff/connection-validity policy, applied to
     every client connection made on this context unless overridden per-call
     by `.clientConnect({retry: {...}})` (see client_connect_info_fromobj()
     below). Same raw-pointer-outlives-the-creation-info caveat applies -
     see the comment on retry_bo_from_retryobj(). Freed in
     lwsjs_context_creation_info_free(). */
  ci->retry_and_idle_policy = retry_bo_fromobj(ctx, obj);

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
lwsjs_context_creation_info_free(JSRuntime* rt, struct lws_context_creation_info* ci) {
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

#if defined(LWS_WITH_CACHE_NSCOOKIEJAR) && defined(LWS_WITH_CLIENT)
  if(ci->http_nsc_filepath)
    js_free_rt(rt, (char*)ci->http_nsc_filepath);
#endif

  retry_bo_free(rt, ci->retry_and_idle_policy);

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
    init_list_head(&lws->timers);

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
    timers_cleanup(lws);
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

  lwsjs_context_creation_info_free(rt, &lws->info);

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
    lwsjs_context_creation_info_fromobj(ctx, argv[0], &lws->info);

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
  METHOD_RETRYDELAY,
#if defined(LWS_WITH_UDP) && defined(LWS_WITH_NETWORK)
  METHOD_RESOLVE,
#endif
  METHOD_SCHEDULE,
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
        service_tick_cancel(lws);
        timers_cleanup(lws);
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
          client_connect_info_from_uri(ctx, tmp, &info);
          js_free(ctx, tmp);
        }
      }

      client_connect_info_fromobj(ctx, obj, &info);

      LWSSocket* sock = socket_alloc(ctx);

      sock->client = TRUE;
      sock->type = info.method ? SOCKET_HTTP : SOCKET_WS;
      sock->method = info.method ? lwsjs_method_index(info.method) : 0;
      /* Ownership moves here, not freed by client_connect_info_free()
         below - see the comment on client_connect_info_fromobj()'s
         retry_and_idle_policy assignment. */
      sock->retry = (struct lws_retry_bo*)info.retry_and_idle_policy;

      ret = lwsjs_socket_wrap(ctx, sock);

      info.context = lws->ctx;
      info.pwsi = &sock->wsi;
      info.opaque_user_data = obj_ptr(ctx, ret);

      if(info.address == 0 && info.host)
        info.address = js_strdup(ctx, info.host);

      if(!uri)
        uri = client_connect_info_to_uri(ctx, &info);

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

    case METHOD_RETRYDELAY: {
      /* ctx.retryDelay(policy, tryCount) -> {delayMs, tryCount, conceal}
         Stateless wrapper around lws_retry_get_delay_ms(): builds a
         throwaway lws_retry_bo_t from `policy` (or passes NULL for lws'
         built-in default table if `policy` isn't an object), doesn't
         retain it anywhere. */
      lws_retry_bo_t* bo = retry_bo_from_retryobj(ctx, argv[0]);
      uint16_t ctry = (uint16_t)to_int32(ctx, argv[1]);
      char conceal = 0;
      unsigned int delay_ms = lws_retry_get_delay_ms(lws->ctx, bo, &ctry, &conceal);

      ret = JS_NewObject(ctx);
      JS_SetPropertyStr(ctx, ret, "delayMs", JS_NewUint32(ctx, delay_ms));
      JS_SetPropertyStr(ctx, ret, "tryCount", JS_NewUint32(ctx, ctry));
      JS_SetPropertyStr(ctx, ret, "conceal", JS_NewBool(ctx, conceal != 0));

      retry_bo_free(JS_GetRuntime(ctx), bo);
      break;
    }

#if defined(LWS_WITH_UDP) && defined(LWS_WITH_NETWORK)
    case METHOD_RESOLVE: {
      /* ctx.resolve(hostname, {type}) -> Promise<string[]>
         `type` is "A" (default) or "AAAA"; result is an array of numeric
         address strings, empty if the name resolved but had no records of
         that type. Rejects on NXDOMAIN/timeout/other lookup failure. */
      const char* name = JS_ToCString(ctx, argv[0]);
      adns_query_type_t qtype = LWS_ADNS_RECORD_A;

      if(argc > 1 && JS_IsObject(argv[1])) {
        JSValue type_val = JS_GetPropertyStr(ctx, argv[1], "type");

        if(JS_IsString(type_val)) {
          const char* type_str = JS_ToCString(ctx, type_val);

          if(type_str && !strcasecmp(type_str, "AAAA"))
            qtype = LWS_ADNS_RECORD_AAAA;

          JS_FreeCString(ctx, type_str);
        }

        JS_FreeValue(ctx, type_val);
      }

      if(name) {
        LWSDnsQuery* q = js_mallocz(ctx, sizeof(LWSDnsQuery));

        if(q) {
          JSValue promise = JS_NewPromiseCapability(ctx, q->resolving_funcs);

          q->ctx = ctx;
          lws_async_dns_query(lws->ctx, 0, name, qtype, lwsjs_resolve_cb, NULL, q, NULL);
          ret = promise;
        }
      }

      JS_FreeCString(ctx, name);
      break;
    }
#endif

    case METHOD_SCHEDULE: {
      /* ctx.schedule(fn, ms) -> { cancel() }
         One-shot timer via lws's own sul scheduler - see the LWSTimer
         comment above client_connect_info_fromobj() for the lifetime/
         cancel-safety design. */
      LWSTimer* t;

      if(!JS_IsFunction(ctx, argv[0]))
        return JS_ThrowTypeError(ctx, "argument 1 must be a function");

      if((t = js_mallocz(ctx, sizeof(LWSTimer)))) {
        JSValueConst data[2];

        t->lws = lws;
        t->callback = JS_DupValue(ctx, argv[0]);
        t->sul.cb = lwsjs_timer_fire;
        list_add(&t->link, &lws->timers);

        lws_sul_schedule(lws->ctx, 0, &t->sul, lwsjs_timer_fire, (lws_usec_t)to_int64(ctx, argv[1]) * LWS_US_PER_MS);

        ret = JS_NewObject(ctx);
        data[0] = JS_NewInt64(ctx, (intptr_t)lws);
        data[1] = JS_NewInt64(ctx, (intptr_t)t);
        JS_SetPropertyStr(ctx, ret, "cancel", JS_NewCFunctionData(ctx, lwsjs_timer_cancel, 0, 0, countof(data), data));
      }

      break;
    }

    case METHOD_WSIFROMFD: {
      struct lws* wsi = wsi_from_fd(lws->ctx, to_int32(ctx, argv[0]));

      ret = wsi ? lwsjs_socket_fromwsi(ctx, wsi) : JS_NULL;
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
         lwsjs_callback_protocol) for how a listener tells its many peers apart -
         a single UDP wsi, unlike TCP, never gets one child wsi per peer. */
      JSValueConst opts = argv[0];
      char *address = 0, *protocol = 0, *iface = 0, *vhost_name = 0;
      int32_t port = -1;
      BOOL bind = FALSE, broadcast = FALSE;
      struct lws_vhost* vh;
      LWSSocket* parent = 0;

      if(JS_IsObject(opts)) {
        str_property((const char**)&address, ctx, opts, "address");
        str_property((const char**)&protocol, ctx, opts, "protocol");
        str_property((const char**)&iface, ctx, opts, "iface");
        str_property((const char**)&vhost_name, ctx, opts, "vhost");

        if(js_has_property(ctx, opts, "port"))
          port = to_integerfree(ctx, js_get_property(ctx, opts, "port"));

        bind = to_boolfree(ctx, js_get_property(ctx, opts, "bind"));
        broadcast = to_boolfree(ctx, js_get_property(ctx, opts, "broadcast"));

        JSValue pwsi = js_get_property(ctx, opts, "parent_wsi");
        parent = lwsjs_socket_data(pwsi);
        JS_FreeValue(ctx, pwsi);
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
        struct lws* wsi = lws_create_adopt_udp(vh, address ? address : "0.0.0.0", port, flags, protocol, iface, parent ? parent->wsi : NULL, obj_ptr(ctx, ret), NULL, NULL);

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

      if(lws->info.protocols == NULL) {
        ret = JS_NULL;
        break;
      }

      ret = JS_NewArray(ctx);

      for(int i = 0; lws->info.protocols[i].name; i++)
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
    JS_CFUNC_MAGIC_DEF("retryDelay", 2, lwsjs_context_methods, METHOD_RETRYDELAY),
#if defined(LWS_WITH_UDP) && defined(LWS_WITH_NETWORK)
    JS_CFUNC_MAGIC_DEF("resolve", 1, lwsjs_context_methods, METHOD_RESOLVE),
#endif
    JS_CFUNC_MAGIC_DEF("schedule", 2, lwsjs_context_methods, METHOD_SCHEDULE),
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

/*
 * lws_create_context() always creates its own internal "system" vhost
 * (context->vhost_system) for async-dns/ntp/dhcp/stdin, built from lws's
 * own protocol list - entirely separate from the vhost(s) our own
 * lwsjs_protocols_fromarray() builds. Since pollfd management (LOCK_POLL,
 * ADD_POLL_FD, etc.) is always dispatched via vhost->protocols[0].callback
 * regardless of which protocol a given wsi is actually bound to, poll-fd
 * events for wsi living on the system vhost (e.g. the async-DNS resolver's
 * UDP socket) were never reaching lwsjs_callback_pollfd()/iohandler_set() at
 * all - they went to lws's own internal protocol callback instead, which
 * has no idea about our iohandler-driven event loop. That left async DNS
 * lookups (and hence any fetch() to a hostname rather than a literal IP)
 * silently stuck forever waiting for a write-ready notification that
 * never arrived. Fix: after context creation, wrap the system vhost's
 * protocols[0] callback so pollfd-management reasons go to
 * lwsjs_callback_pollfd() first, falling through to the original callback
 * (real DNS/ntp/etc. protocol logic) for everything else.
 */
static lws_callback_function* callback_asyncdns_system_vhost;

static int
callback_pollfd_system_vhost(struct lws* wsi, enum lws_callback_reasons reason, void* user, void* in, size_t len) {
  if(is_pollfd_reason(reason))
    if(lwsjs_callback_pollfd(wsi, reason, user, in, len) == 0)
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
