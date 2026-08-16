#include "lws-protocol.h"
#include "lws-socket.h"
#include "lws-context.h"
#include "lws-sockaddr46.h"
#include "lws-tls.h"
#include "js-utils.h"
#include "iohandler.h"
#include <assert.h>
#include <stdlib.h>

#ifdef USE_EPOLL
#include "lws-epoll.h"
#endif

/* libwebsockets/lib/core-net/vhost.c - not part of any public lws header,
   see lwsjs_register_pipe_fds()'s doc comment below for why it's needed */
int lws_context_get_pipe_fd(struct lws_context*, int tsi);

#define LWS_PLUGIN_STATIC

#ifdef PLUGIN_PROTOCOL_DEADDROP
#include "libwebsockets/plugins/protocol_deaddrop/protocol_lws_deaddrop.c"
#endif
#ifdef PLUGIN_PROTOCOL_RAW_PROXY
#include "libwebsockets/plugins/protocol_lws_raw_proxy/protocol_lws_raw_proxy.c"
#endif
#ifdef PLUGIN_PROTOCOL_FULLTEXT_DEMO
#include "libwebsockets/plugins/protocol_fulltext_demo/protocol_fulltext_demo.c"
#endif
/*#ifdef PLUGIN_PROTOCOL_LWS_STATUS
#include "libwebsockets/plugins/protocol_lws_status/protocol_lws_status.c"
#endif*/
#ifdef PLUGIN_PROTOCOL_LWS_ACME_CLIENT
#include "libwebsockets/plugins/protocol_lws_acme_client/protocol_lws_acme_client.c"
#endif
#ifdef PLUGIN_PROTOCOL_LWS_SSHD_DEMO
#include "libwebsockets/plugins/protocol_lws_sshd_demo/protocol_lws_sshd_demo.c"
#endif
#ifdef PLUGIN_PROTOCOL_DUMB_INCREMENT
#include "libwebsockets/plugins/protocol_dumb_increment/protocol_dumb_increment.c"
#endif
#ifdef PLUGIN_PROTOCOL_MIRROR
#include "libwebsockets/plugins/protocol_lws_mirror/protocol_lws_mirror.c"
#endif
#ifdef PLUGIN_PROTOCOL_LWS_RAW_SSHD
#include "libwebsockets/plugins/protocol_lws_ssh_base/sshd.c"
#endif
#ifdef PLUGIN_PROTOCOL_RAW_TEST
#include "libwebsockets/plugins/protocol_lws_raw_test/protocol_lws_raw_test.c"
#endif

typedef struct {
  int fd, events;
  BOOL write;
  struct lws_context* lws;
} LWSPollfdClosure;

static JSValue
pollfd_handler(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic, void* opaque) {
  LWSPollfdClosure* pc = opaque;
  struct lws_pollfd pf = {
      .fd = pc->fd,
      .events = pc->events,
      .revents = pc->write ? POLLOUT : POLLIN,
  };

  lws_service_fd(pc->lws, &pf);

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
  while(lws_service_adjust_timeout(pc->lws, 1, 0) == 0)
    lws_service_tsi(pc->lws, -1, 0);

  return JS_UNDEFINED;
}

static JSValue
callback_c(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[], int magic, void* closure) {
  const struct lws_protocols* proto = closure;
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

static const char* callback_names[] = {
    [LWS_CALLBACK_ESTABLISHED] = "ESTABLISHED",
    [LWS_CALLBACK_CLIENT_CONNECTION_ERROR] = "CLIENT_CONNECTION_ERROR",
    [LWS_CALLBACK_CLIENT_FILTER_PRE_ESTABLISH] = "CLIENT_FILTER_PRE_ESTABLISH",
    [LWS_CALLBACK_CLIENT_ESTABLISHED] = "CLIENT_ESTABLISHED",
    [LWS_CALLBACK_CLOSED] = "CLOSED",
    [LWS_CALLBACK_CLOSED_HTTP] = "CLOSED_HTTP",
    [LWS_CALLBACK_RECEIVE] = "RECEIVE",
    [LWS_CALLBACK_RECEIVE_PONG] = "RECEIVE_PONG",
    [LWS_CALLBACK_CLIENT_RECEIVE] = "CLIENT_RECEIVE",
    [LWS_CALLBACK_CLIENT_RECEIVE_PONG] = "CLIENT_RECEIVE_PONG",
    [LWS_CALLBACK_CLIENT_WRITEABLE] = "CLIENT_WRITEABLE",
    [LWS_CALLBACK_SERVER_WRITEABLE] = "SERVER_WRITEABLE",
    [LWS_CALLBACK_HTTP] = "HTTP",
    [LWS_CALLBACK_HTTP_BODY] = "HTTP_BODY",
    [LWS_CALLBACK_HTTP_BODY_COMPLETION] = "HTTP_BODY_COMPLETION",
    [LWS_CALLBACK_HTTP_FILE_COMPLETION] = "HTTP_FILE_COMPLETION",
    [LWS_CALLBACK_HTTP_WRITEABLE] = "HTTP_WRITEABLE",
    [LWS_CALLBACK_FILTER_NETWORK_CONNECTION] = "FILTER_NETWORK_CONNECTION",
    [LWS_CALLBACK_FILTER_HTTP_CONNECTION] = "FILTER_HTTP_CONNECTION",
    [LWS_CALLBACK_SERVER_NEW_CLIENT_INSTANTIATED] = "SERVER_NEW_CLIENT_INSTANTIATED",
    [LWS_CALLBACK_FILTER_PROTOCOL_CONNECTION] = "FILTER_PROTOCOL_CONNECTION",
    [LWS_CALLBACK_OPENSSL_LOAD_EXTRA_CLIENT_VERIFY_CERTS] = "OPENSSL_LOAD_EXTRA_CLIENT_VERIFY_CERTS",
    [LWS_CALLBACK_OPENSSL_LOAD_EXTRA_SERVER_VERIFY_CERTS] = "OPENSSL_LOAD_EXTRA_SERVER_VERIFY_CERTS",
    [LWS_CALLBACK_OPENSSL_PERFORM_CLIENT_CERT_VERIFICATION] = "OPENSSL_PERFORM_CLIENT_CERT_VERIFICATION",
    [LWS_CALLBACK_CLIENT_APPEND_HANDSHAKE_HEADER] = "CLIENT_APPEND_HANDSHAKE_HEADER",
    [LWS_CALLBACK_CONFIRM_EXTENSION_OKAY] = "CONFIRM_EXTENSION_OKAY",
    [LWS_CALLBACK_CLIENT_CONFIRM_EXTENSION_SUPPORTED] = "CLIENT_CONFIRM_EXTENSION_SUPPORTED",
    [LWS_CALLBACK_PROTOCOL_INIT] = "PROTOCOL_INIT",
    [LWS_CALLBACK_PROTOCOL_DESTROY] = "PROTOCOL_DESTROY",
    [LWS_CALLBACK_WSI_CREATE] = "WSI_CREATE",
    [LWS_CALLBACK_WSI_DESTROY] = "WSI_DESTROY",
    [LWS_CALLBACK_GET_THREAD_ID] = "GET_THREAD_ID",
    [LWS_CALLBACK_ADD_POLL_FD] = "ADD_POLL_FD",
    [LWS_CALLBACK_DEL_POLL_FD] = "DEL_POLL_FD",
    [LWS_CALLBACK_CHANGE_MODE_POLL_FD] = "CHANGE_MODE_POLL_FD",
    [LWS_CALLBACK_LOCK_POLL] = "LOCK_POLL",
    [LWS_CALLBACK_UNLOCK_POLL] = "UNLOCK_POLL",
    [LWS_CALLBACK_WS_PEER_INITIATED_CLOSE] = "WS_PEER_INITIATED_CLOSE",
    [LWS_CALLBACK_WS_EXT_DEFAULTS] = "WS_EXT_DEFAULTS",
    [LWS_CALLBACK_CGI] = "CGI",
    [LWS_CALLBACK_CGI_TERMINATED] = "CGI_TERMINATED",
    [LWS_CALLBACK_CGI_STDIN_DATA] = "CGI_STDIN_DATA",
    [LWS_CALLBACK_CGI_STDIN_COMPLETED] = "CGI_STDIN_COMPLETED",
    [LWS_CALLBACK_ESTABLISHED_CLIENT_HTTP] = "ESTABLISHED_CLIENT_HTTP",
    [LWS_CALLBACK_CLOSED_CLIENT_HTTP] = "CLOSED_CLIENT_HTTP",
    [LWS_CALLBACK_RECEIVE_CLIENT_HTTP] = "RECEIVE_CLIENT_HTTP",
    [LWS_CALLBACK_COMPLETED_CLIENT_HTTP] = "COMPLETED_CLIENT_HTTP",
    [LWS_CALLBACK_RECEIVE_CLIENT_HTTP_READ] = "RECEIVE_CLIENT_HTTP_READ",
    [LWS_CALLBACK_HTTP_BIND_PROTOCOL] = "HTTP_BIND_PROTOCOL",
    [LWS_CALLBACK_HTTP_DROP_PROTOCOL] = "HTTP_DROP_PROTOCOL",
    [LWS_CALLBACK_CHECK_ACCESS_RIGHTS] = "CHECK_ACCESS_RIGHTS",
    [LWS_CALLBACK_PROCESS_HTML] = "PROCESS_HTML",
    [LWS_CALLBACK_ADD_HEADERS] = "ADD_HEADERS",
    [LWS_CALLBACK_SESSION_INFO] = "SESSION_INFO",
    [LWS_CALLBACK_GS_EVENT] = "GS_EVENT",
    [LWS_CALLBACK_HTTP_PMO] = "HTTP_PMO",
    [LWS_CALLBACK_CLIENT_HTTP_WRITEABLE] = "CLIENT_HTTP_WRITEABLE",
    [LWS_CALLBACK_OPENSSL_PERFORM_SERVER_CERT_VERIFICATION] = "OPENSSL_PERFORM_SERVER_CERT_VERIFICATION",
    [LWS_CALLBACK_RAW_RX] = "RAW_RX",
    [LWS_CALLBACK_RAW_CLOSE] = "RAW_CLOSE",
    [LWS_CALLBACK_RAW_WRITEABLE] = "RAW_WRITEABLE",
    [LWS_CALLBACK_RAW_ADOPT] = "RAW_ADOPT",
    [LWS_CALLBACK_RAW_ADOPT_FILE] = "RAW_ADOPT_FILE",
    [LWS_CALLBACK_RAW_RX_FILE] = "RAW_RX_FILE",
    [LWS_CALLBACK_RAW_WRITEABLE_FILE] = "RAW_WRITEABLE_FILE",
    [LWS_CALLBACK_RAW_CLOSE_FILE] = "RAW_CLOSE_FILE",
    [LWS_CALLBACK_SSL_INFO] = "SSL_INFO",
    [LWS_CALLBACK_CHILD_CLOSING] = "CHILD_CLOSING",
    [LWS_CALLBACK_CGI_PROCESS_ATTACH] = "CGI_PROCESS_ATTACH",
    [LWS_CALLBACK_EVENT_WAIT_CANCELLED] = "EVENT_WAIT_CANCELLED",
    [LWS_CALLBACK_VHOST_CERT_AGING] = "VHOST_CERT_AGING",
    [LWS_CALLBACK_TIMER] = "TIMER",
    [LWS_CALLBACK_VHOST_CERT_UPDATE] = "VHOST_CERT_UPDATE",
    [LWS_CALLBACK_CLIENT_CLOSED] = "CLIENT_CLOSED",
    [LWS_CALLBACK_CLIENT_HTTP_DROP_PROTOCOL] = "CLIENT_HTTP_DROP_PROTOCOL",
    [LWS_CALLBACK_WS_SERVER_BIND_PROTOCOL] = "WS_SERVER_BIND_PROTOCOL",
    [LWS_CALLBACK_WS_SERVER_DROP_PROTOCOL] = "WS_SERVER_DROP_PROTOCOL",
    [LWS_CALLBACK_WS_CLIENT_BIND_PROTOCOL] = "WS_CLIENT_BIND_PROTOCOL",
    [LWS_CALLBACK_WS_CLIENT_DROP_PROTOCOL] = "WS_CLIENT_DROP_PROTOCOL",
    [LWS_CALLBACK_RAW_SKT_BIND_PROTOCOL] = "RAW_SKT_BIND_PROTOCOL",
    [LWS_CALLBACK_RAW_SKT_DROP_PROTOCOL] = "RAW_SKT_DROP_PROTOCOL",
    [LWS_CALLBACK_RAW_FILE_BIND_PROTOCOL] = "RAW_FILE_BIND_PROTOCOL",
    [LWS_CALLBACK_RAW_FILE_DROP_PROTOCOL] = "RAW_FILE_DROP_PROTOCOL",
    [LWS_CALLBACK_CLIENT_HTTP_BIND_PROTOCOL] = "CLIENT_HTTP_BIND_PROTOCOL",
    [LWS_CALLBACK_HTTP_CONFIRM_UPGRADE] = "HTTP_CONFIRM_UPGRADE",
    [LWS_CALLBACK_RAW_PROXY_CLI_RX] = "RAW_PROXY_CLI_RX",
    [LWS_CALLBACK_RAW_PROXY_SRV_RX] = "RAW_PROXY_SRV_RX",
    [LWS_CALLBACK_RAW_PROXY_CLI_CLOSE] = "RAW_PROXY_CLI_CLOSE",
    [LWS_CALLBACK_RAW_PROXY_SRV_CLOSE] = "RAW_PROXY_SRV_CLOSE",
    [LWS_CALLBACK_RAW_PROXY_CLI_WRITEABLE] = "RAW_PROXY_CLI_WRITEABLE",
    [LWS_CALLBACK_RAW_PROXY_SRV_WRITEABLE] = "RAW_PROXY_SRV_WRITEABLE",
    [LWS_CALLBACK_RAW_PROXY_CLI_ADOPT] = "RAW_PROXY_CLI_ADOPT",
    [LWS_CALLBACK_RAW_PROXY_SRV_ADOPT] = "RAW_PROXY_SRV_ADOPT",
    [LWS_CALLBACK_RAW_PROXY_CLI_BIND_PROTOCOL] = "RAW_PROXY_CLI_BIND_PROTOCOL",
    [LWS_CALLBACK_RAW_PROXY_SRV_BIND_PROTOCOL] = "RAW_PROXY_SRV_BIND_PROTOCOL",
    [LWS_CALLBACK_RAW_PROXY_CLI_DROP_PROTOCOL] = "RAW_PROXY_CLI_DROP_PROTOCOL",
    [LWS_CALLBACK_RAW_PROXY_SRV_DROP_PROTOCOL] = "RAW_PROXY_SRV_DROP_PROTOCOL",
    [LWS_CALLBACK_RAW_CONNECTED] = "RAW_CONNECTED",
    [LWS_CALLBACK_VERIFY_BASIC_AUTHORIZATION] = "VERIFY_BASIC_AUTHORIZATION",
    [LWS_CALLBACK_WSI_TX_CREDIT_GET] = "WSI_TX_CREDIT_GET",
    [LWS_CALLBACK_CLIENT_HTTP_REDIRECT] = "CLIENT_HTTP_REDIRECT",
    [LWS_CALLBACK_CONNECTING] = "CONNECTING",
    [LWS_CALLBACK_MQTT_NEW_CLIENT_INSTANTIATED] = "MQTT_NEW_CLIENT_INSTANTIATED",
    [LWS_CALLBACK_MQTT_IDLE] = "MQTT_IDLE",
    [LWS_CALLBACK_MQTT_CLIENT_ESTABLISHED] = "MQTT_CLIENT_ESTABLISHED",
    [LWS_CALLBACK_MQTT_SUBSCRIBED] = "MQTT_SUBSCRIBED",
    [LWS_CALLBACK_MQTT_CLIENT_WRITEABLE] = "MQTT_CLIENT_WRITEABLE",
    [LWS_CALLBACK_MQTT_CLIENT_RX] = "MQTT_CLIENT_RX",
    [LWS_CALLBACK_MQTT_UNSUBSCRIBED] = "MQTT_UNSUBSCRIBED",
    [LWS_CALLBACK_MQTT_DROP_PROTOCOL] = "MQTT_DROP_PROTOCOL",
    [LWS_CALLBACK_MQTT_CLIENT_CLOSED] = "MQTT_CLIENT_CLOSED",
    [LWS_CALLBACK_MQTT_ACK] = "MQTT_ACK",
    [LWS_CALLBACK_MQTT_RESEND] = "MQTT_RESEND",
    [LWS_CALLBACK_MQTT_UNSUBSCRIBE_TIMEOUT] = "MQTT_UNSUBSCRIBE_TIMEOUT",
    [LWS_CALLBACK_MQTT_SHADOW_TIMEOUT] = "MQTT_SHADOW_TIMEOUT",
    [LWS_CALLBACK_USER] = "USER",
};

const char*
lwsjs_callback_name(enum lws_callback_reasons reason) {
  if(reason >= 0 && reason < countof(callback_names))
    return callback_names[reason];

  return 0;
}

/*enum lws_callback_reasons*/ int
lwsjs_callback_find(const char* name) {
  char buf[128];

  decamelize(buf, sizeof(buf), name);

  for(size_t i = 0; i < countof(callback_names); i++)
    if(callback_names[i])
      if(!strcmp(callback_names[i], buf))
        return i;

  return -1;
}

static void
callbacks_from_obj(JSContext* ctx, JSValueConst obj, JSValue callbacks[], size_t callback_count) {
  for(size_t i = 0; i < callback_count; i++) {
    if(callback_names[i]) {
      char buf[128];

      buf[0] = 'o';
      buf[1] = 'n';

      camelize(&buf[2], sizeof(buf) - 2, callback_names[i]);
      buf[2] = toupper(buf[2]);

      callbacks[i] = JS_GetPropertyStr(ctx, obj, buf);
      continue;
    }

    callbacks[i] = JS_NULL;
  }
}

JSValue
lwsjs_protocol_obj(JSContext* ctx, const struct lws_protocols* proto) {
  JSValue ret = JS_NewObjectProto(ctx, JS_NULL);

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

int
lwsjs_protocol_from(JSContext* ctx, JSValueConst obj, struct lws_protocols* pro) {
  LWSHandlers* handlers;

  if(!(handlers = js_mallocz(ctx, sizeof(LWSHandlers))))
    return -1;

  BOOL is_array = JS_IsArray(ctx, obj);
  JSValue value = is_array ? JS_GetPropertyUint32(ctx, obj, 0) : JS_GetPropertyStr(ctx, obj, "name");
  pro->name = to_stringfree(ctx, value);

  value = is_array ? JS_GetPropertyUint32(ctx, obj, 1) : JS_GetPropertyStr(ctx, obj, "callback");

  handlers->ctx = ctx;
  handlers->callback = value;
  handlers->obj = obj_ptr(ctx, obj);

  pro->callback = lwsjs_callback_protocol;
  pro->user = handlers;

  callbacks_from_obj(ctx, obj, handlers->callbacks, countof(handlers->callbacks));

  pro->per_session_data_size = sizeof(JSValue);

  value = is_array ? JS_GetPropertyUint32(ctx, obj, 2) : js_get_property(ctx, obj, "rx_buffer_size");
  pro->rx_buffer_size = to_uint32free(ctx, value);

  value = is_array ? JS_GetPropertyUint32(ctx, obj, 3) : JS_GetPropertyStr(ctx, obj, "id");
  pro->id = to_uint32free(ctx, value);

  value = is_array ? JS_GetPropertyUint32(ctx, obj, 4) : js_get_property(ctx, obj, "tx_packet_size");
  pro->tx_packet_size = to_uint32free(ctx, value);

  return 0;
}

void
lwsjs_protocol_free(JSRuntime* rt, struct lws_protocols* pro) {
  LWSHandlers* handlers = pro ? pro->user : NULL;

  if(handlers) {
    JS_FreeValueRT(rt, handlers->callback);

    if(handlers->obj)
      obj_free(rt, handlers->obj);

    js_free_rt(rt, handlers);
  }

  pro->user = 0;
  pro->callback = 0;

  if(pro->name) {
    js_free_rt(rt, (char*)pro->name);
    pro->name = 0;
  }
}

const struct lws_protocols*
lwsjs_protocols_fromarray(JSContext* ctx, JSValueConst value) {
  size_t len = 0;
  JSValue* values = to_valuearray(ctx, value, &len);
  struct lws_protocols* pro = js_mallocz(ctx, (len + 13) * sizeof(struct lws_protocols));
  size_t j = 0;

  if(!pro)
    return NULL;

  if(len == 0)
    pro[j++] = (struct lws_protocols){
        "http-only",
        lwsjs_callback_dummy,
        0,
        0,
        0,
        NULL,
        0,
    };

  for(size_t i = 0; i < len; i++) {
    lwsjs_protocol_from(ctx, values[i], &pro[j++]);

    JS_FreeValue(ctx, values[i]);
  }

  /*#ifdef PLUGIN_PROTOCOL_DEADDROP
    pro[j++] = (struct lws_protocols)LWS_PLUGIN_PROTOCOL_DEADDROP;
  #endif
  #ifdef PLUGIN_PROTOCOL_RAW_PROXY
    pro[j++] = (struct lws_protocols)LWS_PLUGIN_PROTOCOL_RAW_PROXY;
  #endif
  #ifdef PLUGIN_PROTOCOL_FULLTEXT_DEMO
    pro[j++] = (struct lws_protocols)LWS_PLUGIN_PROTOCOL_FULLTEXT_DEMO;
  #endif
  #ifdef PLUGIN_PROTOCOL_LWS_STATUS
    pro[j++] = (struct lws_protocols)LWS_PLUGIN_PROTOCOL_LWS_STATUS;
  #endif
  #ifdef PLUGIN_PROTOCOL_LWS_ACME_CLIENT
    pro[j++] = (struct lws_protocols)LWS_PLUGIN_PROTOCOL_LWS_ACME_CLIENT;
  #endif
  #ifdef PLUGIN_PROTOCOL_LWS_SSHD_DEMO
    pro[j++] = (struct lws_protocols)LWS_PLUGIN_PROTOCOL_LWS_SSHD_DEMO;
  #endif
  #ifdef PLUGIN_PROTOCOL_DUMB_INCREMENT
    pro[j++] = (struct lws_protocols)LWS_PLUGIN_PROTOCOL_DUMB_INCREMENT;
  #endif
  #ifdef PLUGIN_PROTOCOL_MIRROR
    pro[j++] = (struct lws_protocols)LWS_PLUGIN_PROTOCOL_MIRROR;
  #endif
  #ifdef PLUGIN_PROTOCOL_LWS_RAW_SSHD
    pro[j++] = (struct lws_protocols)LWS_PLUGIN_PROTOCOL_LWS_RAW_SSHD;
  #endif
  #ifdef PLUGIN_PROTOCOL_RAW_TEST
    pro[j++] = (struct lws_protocols)LWS_PLUGIN_PROTOCOL_RAW_TEST;
  #endif*/

  if(values)
    js_free(ctx, values);

  return pro;
}

void
lwsjs_protocols_free(JSRuntime* rt, struct lws_protocols* pro) {
  for(int i = 0; pro[i].name; i++)
    lwsjs_protocol_free(rt, &pro[i]);

  js_free_rt(rt, pro);
}

int
lwsjs_callback_dummy(struct lws* wsi, enum lws_callback_reasons reason, void* user, void* in, size_t len) {
  if(lwsjs_callback_js(wsi, reason, user, in, len) == 0)
    return 0;

  if(is_pollfd_reason(reason) && lwsjs_callback_pollfd(wsi, reason, user, in, len) == 0)
    return 0;

  LWSSocket* sock;
  BOOL client = FALSE;

  if((sock = socket_get(wsi)))
    client = sock->client;

  return client ? 0 : lws_callback_http_dummy(wsi, reason, user, in, len);
}

int
lwsjs_callback_js(struct lws* wsi, enum lws_callback_reasons reason, void* user, void* in, size_t len) {
  if(!wsi)
    return -1;

  JSValue* jsval = user;
  struct lws_protocols const* pro = lws_get_protocol(wsi);

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

int
lwsjs_callback_pollfd(struct lws* wsi, enum lws_callback_reasons reason, void* user, void* in, size_t len) {
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
      LWSPollfdClosure* pc;

      if(!(pc = malloc(sizeof(LWSPollfdClosure))))
        return -1;

      pc->fd = x->fd;
      pc->events = x->events;
      pc->write = write;
      pc->lws = lws_get_context(wsi);

      JSValue fn = js_function_cclosure(ctx, pollfd_handler, 0, 0, pc, free);

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
 * lws_create_context() creates its per-thread "cancel service" event pipe
 * (context->pt[tsi].pipe_wsi, libwebsockets/lib/core-net/vhost.c's
 * __lws_create_event_pipes()) before any vhost exists, and that wsi is
 * deliberately left with vhost == protocol == NULL. lws's own
 * __insert_wsi_socket_into_fds() (libwebsockets/lib/core-net/pollfd.c)
 * only invokes the external-poll ADD_POLL_FD callback when wsi->a.vhost is
 * non-NULL, so this pipe's fd is added to lws's internal pt->fds[] but
 * lwsjs_callback_pollfd()/iohandler_set() above never learns about it -
 * this project's event loop never polls it. Any thread that wakes the
 * service loop from outside via lws_cancel_service() (e.g. the
 * LWS_WITH_ASYNC_QUEUE background worker threads used to offload blocking
 * LWSMPRO_FILE reads, libwebsockets/lib/core-net/service.c's
 * lws_async_worker_worker()) writes to that pipe expecting it to wake the
 * service loop - but nothing is listening, so the wakeup is silently lost
 * and the wsi waiting on that job hangs forever (BUGS:
 * fetch-client-http-body-never-delivered). Fix: manually register the
 * pipe fd with the same iohandler/pollfd_handler machinery ADD_POLL_FD
 * would have used, right after context (and so vhost) creation.
 */
void
lwsjs_register_pipe_fds(LWSContext* lws) {
  int n, fd, count = lws_get_count_threads(lws->ctx);

  for(n = 0; n < count; n++) {
    if((fd = lws_context_get_pipe_fd(lws->ctx, n)) < 0)
      continue;

#ifdef USE_EPOLL
    lws_epoll_ctl(lws, fd, POLLIN);
#else
    {
      LWSPollfdClosure* pc;

      if(!(pc = malloc(sizeof(LWSPollfdClosure))))
        continue;

      pc->fd = fd;
      pc->events = POLLIN;
      pc->write = FALSE;
      pc->lws = lws->ctx;

      JSValue fn = js_function_cclosure(lws->js, pollfd_handler, 0, 0, pc, free);
      iohandler_set(lws, fd, fn, FALSE);
      JS_FreeValue(lws->js, fn);
    }
#endif
  }
}

int
lwsjs_callback_protocol(struct lws* wsi, enum lws_callback_reasons reason, void* user, void* in, size_t len) {
  if(is_loadcerts_reason(reason))
    return 0;

  if(lwsjs_callback_js(wsi, reason, user, in, len) == 0)
    return 0;

  if(is_pollfd_reason(reason) && lwsjs_callback_pollfd(wsi, reason, user, in, len) == 0)
    return 0;

  if(wsi) {
    if(is_rx_reason(reason)) {
      if(in && len > 0) {
        char preview[len + (len >> 2)];

        log_preview(preview, sizeof(preview), in, len);
        lwsl_wsi_user(wsi, "%s: %zu bytes: %s%s\n", lwsjs_callback_name(reason), len, preview, len > sizeof(preview) - 1 ? "..." : "");
      } else {
        lwsl_wsi_user(wsi, "%s\n", lwsjs_callback_name(reason));
      }
    } else /*if(is_connected_reason(reason)) {
      lwsl_wsi_user(wsi, "%s\n", lwsjs_callback_name(reason));
    } else if(is_closed_reason(reason)) {
      lwsl_wsi_user(wsi, "%s\n", lwsjs_callback_name(reason));
    } else*/
    {
      lwsl_wsi_user(wsi, "%s\n", lwsjs_callback_name(reason));
    }
  }

  struct lws_protocols const* pro = wsi ? lws_get_protocol(wsi) : NULL;
  LWSHandlers* handlers = pro ? pro->user : NULL;
  JSValue* cb = handlers ? &handlers->callback : NULL;
  LWSContext* lws = lwsjs_wsi_context(wsi);
  JSContext* ctx = lws ? lwsjs_context_jsctx(lws) : wsi ? lwsjs_wsi_jscontext(wsi) : NULL;
  int32_t ret = 0;
  JSValue* jsval = user && pro && pro->per_session_data_size == sizeof(JSValue) && JS_IsObject(*(JSValue*)user) ? user : NULL;

  DEBUG_WSI(wsi, "\x1b[1;33m%-24s\x1b[0m %p %p %zu", lwsjs_callback_name(reason), user, in, len);

  /* Pollfd-management reasons (LOCK_POLL/UNLOCK_POLL/ADD_POLL_FD/DEL_POLL_FD/
     CHANGE_MODE_POLL_FD) never reach this point: lwsjs_callback_js() never handles
     them, so the lwsjs_callback_pollfd() call a few lines above this function's
     entry already returns 0 for all five - there used to be a second,
     unreachable copy of that same switch statement here. */
  if(handlers && countof(handlers->callbacks) > reason && !is_nullish(handlers->callbacks[reason]))
    cb = &handlers->callbacks[reason];

  JSValue sock = wsi && reason != LWS_CALLBACK_CLIENT_HTTP_BIND_PROTOCOL && reason != LWS_CALLBACK_PROTOCOL_INIT ? lwsjs_socket_get_or_create(ctx, wsi) : JS_UNDEFINED;
  LWSSocket* s = lwsjs_socket_data(sock);

  if(is_writeable_reason(reason)) {
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
        s->dispatching = TRUE;
        s->dispatch_reason = reason;
        JSValue result = JS_Call(ctx, fn, JS_UNDEFINED, 1, &sock);
        s->dispatching = FALSE;
        s->dispatch_reason = -1;
        ret = to_int32free(ctx, result);
        JS_FreeValue(ctx, fn);

        if(s->closed)
          ret = -1;

        goto end;
      }
    }

    if(reason == LWS_CALLBACK_CLIENT_APPEND_HANDSHAKE_HEADER)
      s->redirected_to_get = lws_http_is_redirected_to_get(wsi);

    if(reason == LWS_CALLBACK_CLIENT_HTTP_WRITEABLE)
      if(s->redirected_to_get)
        goto end;
  }

  /* LWSSocket `s` is allocated once per connection, not once per HTTP
     transaction - with keep-alive, a single wsi now carries several
     requests in turn (see lib/lws/response.js's Content-Length fix). The
     uri/method/headers/proto cached below assume a wsi only ever sees one
     transaction; without dropping the previous transaction's values first,
     every request after the first on a reused wsi would keep reading the
     *first* request's cached uri/method/headers forever. LWS_CALLBACK_HTTP
     fires once per transaction, including subsequent ones on a reused wsi,
     so this is the right point to reset them back to "not yet derived"
     before the population logic below runs. */
  if(reason == LWS_CALLBACK_HTTP && s) {
    if(s->uri) {
      js_free(ctx, s->uri);
      s->uri = 0;
    }

    if(s->proto) {
      js_free(ctx, s->proto);
      s->proto = 0;
    }

    if(!is_nullish(s->headers)) {
      JS_FreeValue(ctx, s->headers);
      s->headers = JS_UNDEFINED;
    }

    s->method = -1;
  }

  /* Unconditional (unlike the HTTP_CONFIRM_UPGRADE/FILTER_HTTP_CONNECTION
     heuristics above, both nested inside the `if(cb...)` block below and so
     skipped whenever the protocol has no handler for that specific reason):
     LWS_CALLBACK_ESTABLISHED/CLIENT_ESTABLISHED is the one point every
     successful ws connection - client or server, mounted or not - always
     passes through, so it's the only reliable place to tag s->type. Without
     this, s->type stays SOCKET_RAW whenever the protocol doesn't happen to
     define a handler for ESTABLISHED/CLIENT_ESTABLISHED/
     FILTER_PROTOCOL_CONNECTION specifically (e.g. one with only onReceive/
     onClosed), silently disabling every SOCKET_WS-gated feature (e.g.
     onClosed()'s close code/reason, below) for that connection. */
  if(reason == LWS_CALLBACK_ESTABLISHED || reason == LWS_CALLBACK_CLIENT_ESTABLISHED || reason == LWS_CALLBACK_FILTER_PROTOCOL_CONNECTION)
    if(s)
      s->type = SOCKET_WS;

  if(is_headers_reason(reason) || reason == LWS_CALLBACK_HTTP) {
    if(s && is_nullish(s->headers))
      s->headers = lwsjs_socket_headers(ctx, s->wsi, &s->proto);

    if(s && (s->uri == 0 || s->method == -1)) {
      char* uri = 0;
      int len = 0, method = lws_http_get_uri_and_method(s->wsi, &uri, &len);

      if(uri && s->uri == 0)
        s->uri = js_strndup(ctx, uri, len);

      if(method >= 0 && s->method == -1)
        s->method = method;
    }
  }

  if(cb && !is_nullish(*cb)) {
    int i = 1, buffer_index = -1;
    JSValue argv[5] = {
        JS_DupValue(ctx, sock),
    };

    if(cb == &handlers->callback)
      argv[i++] = JS_NewInt32(ctx, reason);

    if(reason == LWS_CALLBACK_HTTP_CONFIRM_UPGRADE)
      if(s && !strcmp(in, "websocket"))
        s->type = SOCKET_WS;

    if(reason == LWS_CALLBACK_FILTER_HTTP_CONNECTION)
      if(s && !strcmp(in, "ws"))
        s->type = SOCKET_WS;

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

    /*if(reason == LWS_CALLBACK_CLIENT_RECEIVE && (((char*)in)[-2] & 0x7f) == 8) {
      BOOL has_reason = cb == &handlers->callback;
      int code = (int)(((uint8_t*)in)[0]) << 8 | ((uint8_t*)in)[1];

      reason = LWS_CALLBACK_WS_PEER_INITIATED_CLOSE;
      cb = is_nullish(handlers->callbacks[reason]) ? &handlers->callback : &handlers->callbacks[reason];

      if(!has_reason && cb == &handlers->callback)
        argv[i++] = JS_NewInt32(ctx, reason);

      argv[i++] = JS_NewInt32(ctx, code);

      if(len > 2)
        argv[i++] = JS_NewStringLen(ctx, (char*)in + 2, len - 2);

      args_built = TRUE;
    }*/

    if(!args_built) {
      switch(reason) {
        case LWS_CALLBACK_CLIENT_HTTP_REDIRECT: {
          argv[i++] = JS_NewString(ctx, in);
          argv[i++] = JS_NewInt32(ctx, len);
          break;
        }

        /* LWS_CALLBACK_CHECK_ACCESS_RIGHTS does NOT share ADD_HEADERS/
           PROCESS_HTML's arg shape below, despite reusing the same
           struct lws_process_html_args - confirmed against
           libwebsockets/lib/roles/http/server/server.c: for this reason,
           args.max_len is set to the mount's auth_mask bitmask, not a
           buffer capacity, and args.p/args.len already point at the real,
           correctly-sized URI bytes in lws's own header-parse buffer.
           Treating max_len as a capacity here (as the merged case below
           used to) memset and ArrayBuffer past the real buffer's end
           whenever the auth_mask bitmask value exceeds the URI length. */
        case LWS_CALLBACK_CHECK_ACCESS_RIGHTS: {
          struct lws_process_html_args* pha = (struct lws_process_html_args*)in;

          argv[buffer_index = i++] = JS_NewArrayBuffer(ctx, (uint8_t*)pha->p, pha->len, 0, 0, FALSE);
          argv[i++] = JS_NewUint32(ctx, pha->max_len); /* the mount's auth_mask bitmask */
          break;
        }

        case LWS_CALLBACK_ADD_HEADERS:
        case LWS_CALLBACK_PROCESS_HTML: {
          struct lws_process_html_args* pha = (struct lws_process_html_args*)in;

          if(reason == LWS_CALLBACK_ADD_HEADERS)
            pha->len = 0;

          if(pha->len < pha->max_len)
            memset(&pha->p[pha->len], 0, pha->max_len - pha->len);

          argv[buffer_index = i++] = JS_NewArrayBuffer(ctx, (uint8_t*)pha->p, pha->max_len, 0, 0, FALSE);
          argv[i] = JS_NewArray(ctx);
          JS_SetPropertyUint32(ctx, argv[i], 0, JS_NewUint32(ctx, pha->len));
          i++;
          break;
        }

        case LWS_CALLBACK_ESTABLISHED: {
          argv[i++] = js_fmt_pointer(ctx, in, "(SSL*)");
          argv[i++] = JS_NewInt32(ctx, len);
          break;
        }

        case LWS_CALLBACK_CLIENT_APPEND_HANDSHAKE_HEADER: {
          // memset(*(uint8_t**)in, 0, len);
          argv[buffer_index = i++] = JS_NewArrayBuffer(ctx, *(uint8_t**)in, len, 0, 0, FALSE);
          argv[i] = JS_NewArray(ctx);
          JS_SetPropertyUint32(ctx, argv[i], 0, JS_NewUint32(ctx, 0));
          i++;
          break;
        }

        case LWS_CALLBACK_ESTABLISHED_CLIENT_HTTP: {
          int response = lws_http_client_http_response(wsi);

          assert(s);
          s->response_code = response;

          argv[i++] = JS_NewInt32(ctx, response);
          break;
        }

        case LWS_CALLBACK_CONNECTING: {
          argv[i++] = JS_NewInt32(ctx, (int32_t)(intptr_t)in);
          break;
        }

        case LWS_CALLBACK_WS_PEER_INITIATED_CLOSE: {
          if(len >= 2)
            argv[i++] = JS_NewInt32(ctx, ntohs(*(uint16_t*)in));

          if(len > 2)
            argv[i++] = JS_NewArrayBufferCopy(ctx, (const uint8_t*)in + 2, len - 2);
          break;
        }

        case LWS_CALLBACK_CLOSED:
        case LWS_CALLBACK_CLIENT_CLOSED: {
          /* Only ever reports the code/reason from OUR OWN local .close()
             call (see close_code/close_reason on LWSSocket, lws-socket.h) -
             not a peer-initiated close, which is what
             WS_PEER_INITIATED_CLOSE above already handles. Deliberately
             NOT read back via lws_get_close_length()/lws_get_close_payload():
             that reads wsi->ws->ping_payload_buf, which is also the buffer
             lws reuses (and mutates in place - WS frame masking is applied
             to it when a client sends the close frame, including this
             process's own close ack of a peer-initiated close) to actually
             put the close frame on the wire, so by the time CLOSED/
             CLIENT_CLOSED fires it may no longer hold the bytes it was
             given. Confirmed empirically: a client-side self-close came
             back with a scrambled code every time despite the right byte
             count. Stashing our own copy in lwsjs_socket_close(), before
             lws ever gets a chance to reuse that buffer, sidesteps it. */
          if(s && s->close_code_set) {
            argv[i++] = JS_NewInt32(ctx, s->close_code);

            if(s->close_reason && s->close_reason_len > 0)
              argv[i++] = JS_NewArrayBufferCopy(ctx, s->close_reason, s->close_reason_len);
          }
          break;
        }

        case LWS_CALLBACK_OPENSSL_PERFORM_CLIENT_CERT_VERIFICATION:
        case LWS_CALLBACK_OPENSSL_PERFORM_SERVER_CERT_VERIFICATION: {
          /* user/in/len here are X509_STORE_CTX* / SSL* / preverify_ok, not
             the generic buffer+length shape the default case below assumes -
             deliberately left a no-op (not just left to fall into that
             default case) since there's no backend-agnostic way to expose
             those raw OpenSSL pointers to JS (see lws-tls.h's
             X509Certificate comment) - this project no longer has a
             per-connection cert-verify-override binding at all. */
          break;
        }

        case LWS_CALLBACK_FILTER_NETWORK_CONNECTION: {
          argv[i++] = JS_NewInt32(ctx, (int32_t)(intptr_t)in);
          break;
        }

#ifdef LWS_WITH_UDP
        case LWS_CALLBACK_RAW_RX: {
          const struct lws_udp* udp;

          argv[i++] = in ? JS_NewArrayBufferCopy(ctx, in, len) : JS_NULL;
          argv[i++] = JS_NewInt64(ctx, len);

          /* A UDP listener wsi fields datagrams from many different peers on
             one socket (unlike TCP, which gets a separate wsi per accepted
             connection) - wsi->udp->sa46 only ever holds the *most recent*
             sender, so it can't be relied on later (e.g. once a recursive
             resolver's upstream reply comes back and it's time to answer the
             original client - other clients' datagrams may have arrived on
             this wsi in the meantime). Snapshot the sender's address here,
             at RX time, so JS can hold onto it and hand it back to
             wsi.sendTo() whenever the reply is actually ready. NULL for a
             non-UDP (plain TCP raw) wsi - lws_get_udp() only returns
             non-NULL for UDP. */
          if((udp = lws_get_udp(wsi)) && udp->sa46.sa4.sin_family)
            argv[i++] = lwsjs_sockaddr46_wrap(ctx, udp->sa46);

          break;
        }
#endif

        default: {
          if(in && (len > 0) && reason != LWS_CALLBACK_FILTER_HTTP_CONNECTION && reason != LWS_CALLBACK_CLIENT_CONNECTION_ERROR) {
            BOOL is_ws = reason == LWS_CALLBACK_CLIENT_RECEIVE || reason == LWS_CALLBACK_RECEIVE;

            argv[i++] = in ? ((!is_ws || lws_frame_is_binary(wsi))) ? JS_NewArrayBufferCopy(ctx, in, len) : JS_NewStringLen(ctx, in, len) : JS_NULL;
            argv[i++] = JS_NewInt64(ctx, len);

            /* lws_is_first_fragment()/lws_is_final_fragment() are receive-side
               (unlike lws_ws_sending_multifragment(), which reports our own send
               state and is never true here). A plain single-frame message is
               simultaneously first and final; only surface `frame` when that's
               not the case, matching the documented "only present for
               multi-fragment messages" contract. */
            if(is_ws && !(lws_is_first_fragment(wsi) && lws_is_final_fragment(wsi))) {
              argv[i] = JS_NewObjectProto(ctx, JS_NULL);
              JS_SetPropertyStr(ctx, argv[i], "multifragment", JS_TRUE);
              JS_SetPropertyStr(ctx, argv[i], "first", JS_NewBool(ctx, lws_is_first_fragment(wsi)));
              JS_SetPropertyStr(ctx, argv[i], "final", JS_NewBool(ctx, lws_is_final_fragment(wsi)));
              i++;
            }
          } else if(in && (len == 0 || reason == LWS_CALLBACK_FILTER_HTTP_CONNECTION || reason == LWS_CALLBACK_CLIENT_CONNECTION_ERROR)) {
            argv[i++] = JS_NewString(ctx, in);
          }
          break;
        }
      }
    }

    if(reason == LWS_CALLBACK_CLIENT_CONNECTION_ERROR) {
      argv[i++] = JS_NewInt32(ctx, errno);
    } else if(reason == LWS_CALLBACK_RAW_CLOSE) {
      argv[i++] = JS_NewInt32(ctx, errno);
    }

    if(s) {
      s->dispatching = TRUE;
      s->dispatch_reason = reason;
    }

    JSValue result = JS_Call(ctx, *cb, jsval ? *jsval : JS_NULL, i, argv);

    if(s) {
      s->dispatching = FALSE;
      s->dispatch_reason = -1;
    }

    if(JS_IsException(result)) {
      JSValue error = JS_GetException(ctx);
      js_error_print(ctx, error);
      JS_FreeValue(ctx, error);
    }

    if(reason == LWS_CALLBACK_CLIENT_APPEND_HANDSHAKE_HEADER) {
      int64_t n = to_int64free(ctx, JS_GetPropertyUint32(ctx, argv[i - 1], 0));

      *(uint8_t**)in += CLAMP(n, 0, len);

    } else if(is_htmlargs_reason(reason)) {
      struct lws_process_html_args* pha = (struct lws_process_html_args*)in;
      int64_t n = to_int64free(ctx, JS_GetPropertyUint32(ctx, argv[i - 1], 0));

      pha->p += CLAMP(n, 0, pha->max_len);
    }

    for(int j = 0; j < i; j++) {
      /* Detach the one ArrayBuffer that wraps lws's own transient
         stack/heap memory (pha->p / *(uint8_t**)in) at its own index -
         comparing against i here instead of j would never match, since
         every branch that sets buffer_index pushes at least one more arg
         afterward, leaving buffer_index < i always. Without detaching,
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

  /*if(reason == LWS_CALLBACK_CLIENT_APPEND_HANDSHAKE_HEADER)
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
      iohandler_clear(lws, fd);

    lws_wsi_close(wsi, LWS_TO_KILL_ASYNC);
    // lws_close_free_wsi(wsi, LWS_CLOSE_STATUS_NOSTATUS, __func__);
  }

end:
  JS_FreeValue(ctx, sock);

  /*if(ret == 0)
    return lws_callback_http_dummy(wsi, reason, user, in, len);*/

  return ret;
}
