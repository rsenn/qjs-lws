#include "lws-protocol.h"
#include "lws-socket.h"
#include "lws-context.h"
#include "lws-sockaddr46.h"
#include "lws.h"
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
} PollFdClosure;

static JSValue
pollfd_handler(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic, void* opaque) {
  PollFdClosure* pc = opaque;
  struct lws_pollfd pf = {
      .fd = pc->fd,
      .events = pc->events,
      .revents = pc->write ? POLLOUT : POLLIN,
  };

  lws_service_fd(pc->lws, &pf);

  /* forced service: lws holds buffered data that no poll() event will
   * announce, e.g. a full response that arrived in one read(). external
   * poll loops must drive it, or the wsi waits forever. see
   * lws_service_adjust_timeout() in lws-service.h. */
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

int
lwsjs_callback_find(const char* name) {
  char buf[128];

  lwsjs_decamelize(buf, sizeof(buf), name);

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

      lwsjs_camelize(&buf[2], sizeof(buf) - 2, callback_names[i]);
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

  if(values)
    js_free(ctx, values);

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
      /* lws may want POLLIN and POLLOUT at once, e.g. a client awaiting the
       * response after sending its request. the iohandler table keys read and
       * write separately, so register one handler per direction. */
      BOOL want_write = !!(x->events & POLLOUT), want_read = !!(x->events & POLLIN) || !want_write;

      for(int dir = 0; dir < 2; dir++) {
        BOOL write = dir == 1;

        if(write ? !want_write : !want_read) {
          if(reason == LWS_CALLBACK_CHANGE_MODE_POLL_FD)
            iohandler_set(lws, x->fd, JS_NULL, write);
          continue;
        }

        PollFdClosure* pc;

        if(!(pc = malloc(sizeof(PollFdClosure))))
          return -1;

        pc->fd = x->fd;
        pc->events = x->events;
        pc->write = write;
        pc->lws = lws_get_context(wsi);

        JSValue fn = js_function_cclosure(ctx, pollfd_handler, 0, 0, pc, free);

        iohandler_set(lws, x->fd, fn, write);

        JS_FreeValue(ctx, fn);
      }
#endif
      return 0;
    }

    default: break;
  }

  return -1;
}

/* registers the cancel service pipe fd of a context with the event loop.
 *
 * lws creates that pipe before any vhost exists, with vhost == NULL, so:
 *   - ADD_POLL_FD never fires for it, lwsjs_callback_pollfd() misses it
 *   - lws_cancel_service() from a worker thread then wakes nothing
 *   - a wsi waiting on that job hangs forever
 * register the fd by hand with the iohandler machinery, right after the
 * context (and so the vhost) is created. */
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
      PollFdClosure* pc;

      if(!(pc = malloc(sizeof(PollFdClosure))))
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

/* undoes lwsjs_register_pipe_fds(): removes the read handler of the pipe fd.
 *
 * the pipe wsi never gets DEL_POLL_FD either, so the handler would outlive
 * the fd and the loop would wait on a closed fd. call while lws->js and
 * lws->ctx are both still valid. */
void
lwsjs_unregister_pipe_fds(LWSContext* lws) {
  int n, fd, count = lws_get_count_threads(lws->ctx);

  for(n = 0; n < count; n++) {
    if((fd = lws_context_get_pipe_fd(lws->ctx, n)) < 0)
      continue;

#ifdef USE_EPOLL
    lws_epoll_del(lws, fd);
#else
    iohandler_set(lws, fd, JS_NULL, FALSE);
#endif
  }
}

int
lwsjs_callback_protocol(struct lws* wsi, enum lws_callback_reasons reason, void* user, void* in, size_t len) {
  if(is_loadcerts_reason(reason))
    return 0;

  if(is_lifecycle_reason(reason))
    return lwsjs_callback_js(wsi, reason, user, in, len);

  if(is_pollfd_reason(reason))
    return lwsjs_callback_pollfd(wsi, reason, user, in, len);

  if(wsi) {
    if(is_rx_reason(reason)) {
      if(in && len > 0) {
        /* bypasses lwsl_wsi_user(), whose 1024-byte formatting buffer truncates
         * a large RX preview, via lwsjs_log_user_line() (lws.h) */
        char prefix[256];
        size_t plen = lwsjs_log_rx_prefix(prefix, sizeof(prefix), wsi, lwsjs_callback_name(reason), (unsigned long)len);

        lwsjs_log_user_line(wsi, prefix, plen, in, len);
      } else {
        lwsl_wsi_user(wsi, "%s\n", lwsjs_callback_name(reason));
      }
    } else {
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

  /* pollfd reasons (LOCK_POLL, UNLOCK_POLL, ADD_POLL_FD, DEL_POLL_FD,
   * CHANGE_MODE_POLL_FD) never get here, lwsjs_callback_pollfd() above
   * already returned 0 for all five. */
  if(handlers && countof(handlers->callbacks) > reason && !is_nullish(handlers->callbacks[reason]))
    cb = &handlers->callbacks[reason];

  JSValue sock = wsi && reason != LWS_CALLBACK_CLIENT_HTTP_BIND_PROTOCOL && reason != LWS_CALLBACK_PROTOCOL_INIT ? lwsjs_socket_get_or_create(ctx, wsi) : JS_UNDEFINED;
  LWSSocket* s = lwsjs_socket_data(sock);

  if(is_writeable_reason(reason)) {
    /* drain queued wsi.write() chunks while lws takes them, stop at a queued
     * wsi.wantWrite(fn) entry, see socket_flush() in lws-socket.c */
    int n_flushed = s ? socket_flush(s) : 0;

    /* fire a queued wantWrite() callback only after a round that drained no
     * data, so it runs once earlier writes went out. socket_flush() re-arms
     * for a remaining backlog, this is revisited on the next WRITEABLE. */
    if(s && n_flushed == 0 && socket_write_queue_front_is_callback(s)) {
      JSContext* fnctx;
      JSValue fn = socket_pop_callback(s, &fnctx);

      s->dispatching = TRUE;
      s->dispatch_reason = reason;
      JSValue result = JS_Call(fnctx, fn, JS_UNDEFINED, 1, &sock);
      s->dispatching = FALSE;
      s->dispatch_reason = -1;
      ret = to_int32free(fnctx, result);
      JS_FreeValue(fnctx, fn);

      if(s->closed)
        ret = -1;

      goto end;
    }

    if(s)
      s->want_write = FALSE;

    if(reason == LWS_CALLBACK_CLIENT_APPEND_HANDSHAKE_HEADER)
      s->redirected_to_get = lws_http_is_redirected_to_get(wsi);

    if(reason == LWS_CALLBACK_CLIENT_HTTP_WRITEABLE)
      if(s->redirected_to_get)
        goto end;
  }

  /* s lives per connection, not per HTTP transaction, and keep-alive carries
   * several requests over one wsi. LWS_CALLBACK_HTTP fires per transaction,
   * so reset the cached uri, method, headers and proto here, or every later
   * request would read the values of the first. */
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

  /* tag s->type for every ws connection, handler or not: ESTABLISHED and
   * CLIENT_ESTABLISHED always pass here. else s->type stays SOCKET_RAW and
   * SOCKET_WS features like the close code of onClosed() are lost. */
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
    struct lwsjs_view view = {0}; /* ADD_HEADERS / PROCESS_HTML / CLIENT_APPEND_HANDSHAKE_HEADER: lives across the dispatch */
    uint8_t* view_start = NULL;
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

    /* rewrite before the switch, it decides which reason is dispatched. not
     * folded into the WS_PEER_INITIATED_CLOSE case, whose arguments differ:
     * that one pushes the reason as ArrayBuffer and guards code on len >= 2,
     * this one pushes a string and always pushes code. */
    BOOL args_built = FALSE;

    if(!args_built) {
      switch(reason) {
        case LWS_CALLBACK_CLIENT_HTTP_REDIRECT: {
          argv[i++] = JS_NewString(ctx, in);
          argv[i++] = JS_NewInt32(ctx, len);
          break;
        }

        /* CHECK_ACCESS_RIGHTS reuses lws_process_html_args but not the shape of
         * ADD_HEADERS and PROCESS_HTML: args.max_len is the auth_mask bitmask of
         * the mount, not a capacity, and args.p and args.len already hold the URI
         * bytes in the header parse buffer of lws. */
        case LWS_CALLBACK_CHECK_ACCESS_RIGHTS: {
          struct lws_process_html_args* pha = (struct lws_process_html_args*)in;

          /* percent-decoded, dot-segments resolved, no control bytes; bytes >= 0x80 are whatever the
             client sent, so invalid UTF-8 comes out as U+FFFD */
          argv[i++] = JS_NewStringLen(ctx, pha->p, pha->len);
          argv[i++] = JS_NewUint32(ctx, pha->max_len); /* the mount's auth_mask bitmask */
          break;
        }

        case LWS_CALLBACK_ADD_HEADERS:
        case LWS_CALLBACK_PROCESS_HTML: {
          struct lws_process_html_args* pha = (struct lws_process_html_args*)in;

          if(reason == LWS_CALLBACK_ADD_HEADERS)
            pha->len = 0;

          /* the room left in the buffer as a (p, end) pair, for lws.write() / addHeader();
             detached after the call */
          view_start = lwsjs_view_pha(&view, pha);
          argv[buffer_index = i++] = lwsjs_view_wrap(ctx, &view);
          break;
        }

        case LWS_CALLBACK_CLIENT_APPEND_HANDSHAKE_HEADER: {
          /* same (p, end) pair as ADD_HEADERS; p is written back after the call */
          view_start = lwsjs_view_buf(&view, *(uint8_t**)in, len);
          argv[buffer_index = i++] = lwsjs_view_wrap(ctx, &view);
          break;
        }

        case LWS_CALLBACK_ESTABLISHED: {
          argv[i++] = js_fmt_pointer(ctx, in, "(SSL*)");
          argv[i++] = JS_NewInt32(ctx, len);
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
          /* reports the code and reason of our own local .close() call only,
           * peer-initiated closes go through WS_PEER_INITIATED_CLOSE above.
           *
           * not read back via lws_get_close_length() and lws_get_close_payload():
           *   - they read ping_payload_buf, which lws reuses to build the close
           *     frame and masks in place
           *   - by CLOSED or CLIENT_CLOSED it no longer holds the bytes given
           * lwsjs_socket_close() stashes a copy before lws can reuse the buffer. */
          if(s && s->close_code_set) {
            argv[i++] = JS_NewInt32(ctx, s->close_code);

            if(s->close_reason && s->close_reason_len > 0)
              argv[i++] = JS_NewArrayBufferCopy(ctx, s->close_reason, s->close_reason_len);
          }
          break;
        }

        case LWS_CALLBACK_OPENSSL_PERFORM_CLIENT_CERT_VERIFICATION:
        case LWS_CALLBACK_OPENSSL_PERFORM_SERVER_CERT_VERIFICATION: {
          /* user, in and len are X509_STORE_CTX*, SSL* and preverify_ok here, not a
           * buffer and length. deliberately a no-op, raw OpenSSL pointers have no
           * backend-agnostic form in JS, see the X509Certificate comment in
           * lws-tls.h */
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

          /* snapshot the sender address at RX time, for wsi.sendTo() later. a UDP
           * listener wsi receives from many peers on one socket and wsi->udp->sa46
           * only holds the latest sender. lws_get_udp() is NULL for a non-UDP
           * wsi. */
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

            /* lws_is_first_fragment() and lws_is_final_fragment() describe the
             * received message, lws_ws_sending_multifragment() our send state. a
             * single-frame message is both first and final, so surface frame only for
             * multi-fragment messages. */
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

    /* a protocol defines only the on<Reason> handlers it cares about, so *cb
     * is JS_UNDEFINED when neither a per-reason nor a base callback exists.
     * skip the call then, JS_Call would throw "TypeError: not a function"
     * and the defaults below apply either way. */
    JSValue result = JS_IsFunction(ctx, *cb) ? JS_Call(ctx, *cb, jsval ? *jsval : JS_NULL, i, argv) : JS_UNDEFINED;

    if(s) {
      s->dispatching = FALSE;
      s->dispatch_reason = -1;
    }

    if(JS_IsException(result)) {
      JSValue error = JS_GetException(ctx);
      js_error_print(ctx, error);
      JS_FreeValue(ctx, error);
    }

    if(view_start) {
      /* JS can scribble on the pair: a cursor outside the range is taken as nothing written */
      if(view.p < view_start || view.p > view.end)
        view.p = view_start;

      if(reason == LWS_CALLBACK_CLIENT_APPEND_HANDSHAKE_HEADER) {
        *(uint8_t**)in = view.p;
      } else {
        struct lws_process_html_args* pha = (struct lws_process_html_args*)in;

        pha->len += lwsjs_view_len(&view, view_start);

        /* lws reads the two back differently:
         *   ADD_HEADERS   args.p only, moved past what was written
         *   PROCESS_HTML  args.p and args.len, p stays put (the chunk size line
         *                 goes in front) and len is the new content length */
        if(reason == LWS_CALLBACK_ADD_HEADERS)
          pha->p += pha->len;
      }
    }

    for(int j = 0; j < i; j++) {
      /* detach the ArrayBuffer that wraps transient lws memory (pha->p or
       * *(uint8_t**)in), or retained JS code could touch memory lws reuses.
       * compare buffer_index with j, not i: every branch that sets it pushes
       * at least one more arg afterward, so buffer_index is always below i. */
      if(buffer_index == j)
        lwsjs_view_detach(ctx, argv[j]);
      JS_FreeValue(ctx, argv[j]);
    }

    ret = to_int32free(ctx, result);
  }

  if(s && s->closed)
    ret = -1;

  if(reason != LWS_CALLBACK_PROTOCOL_INIT && reason != LWS_CALLBACK_HTTP_BIND_PROTOCOL) {
    if(s && s->completed)
      ret = -1;
  }

  if(ret != 0) {
    int fd = lws_get_socket_fd(wsi);

    if(fd != -1)
      iohandler_clear(lws, fd);

    lws_wsi_close(wsi, LWS_TO_KILL_ASYNC);
  }

end:
  JS_FreeValue(ctx, sock);
  return ret;
}
