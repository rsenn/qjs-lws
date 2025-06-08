#include "lws-socket.h"
#include "lws-context.h"
#include "lws.h"
#include <string.h>

static const char* lwsjs_callback_name(enum lws_callback_reasons);

enum {
  FUNCTION_GET_CALLBACK_NAME = 0,
  FUNCTION_GET_CALLBACK_NUMBER,
  FUNCTION_LOG,
  FUNCTION_PARSE_URI,
  FUNCTION_VISIBLE,
  FUNCTION_TO_STRING,
  FUNCTION_TO_ARRAYBUFFER,
};

JSValue
lwsjs_iterator_next(JSContext* ctx, JSValueConst obj, BOOL* done_p) {
  JSValue fn = JS_GetPropertyStr(ctx, obj, "next");
  JSValue result = JS_Call(ctx, fn, obj, 0, 0);
  JS_FreeValue(ctx, fn);
  *done_p = to_boolfree(ctx, JS_GetPropertyStr(ctx, result, "done"));
  JSValue value = JS_GetPropertyStr(ctx, result, "value");
  JS_FreeValue(ctx, result);
  return value;
}

char**
to_stringarray(JSContext* ctx, JSValueConst obj) {
  JSValue iterator = iterator_get(ctx, obj);

  if(JS_IsException(iterator)) {
    JS_GetException(ctx);
    return 0;
  }

  BOOL done = FALSE;
  char** ret = 0;
  uint32_t i;

  for(i = 0;; ++i) {

    JSValue value = lwsjs_iterator_next(ctx, iterator, &done);

    if(done || !(ret = js_realloc(ctx, ret, (i + 2) * sizeof(char*)))) {
      JS_FreeValue(ctx, value);
      break;
    }

    ret[i] = to_stringfree(ctx, value);
    ret[i + 1] = 0;
  }

  return ret;
}

static JSValue
lwsjs_functions(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[], int magic) {
  JSValue ret = JS_UNDEFINED;

  switch(magic) {
    case FUNCTION_GET_CALLBACK_NAME: {
      int32_t reason = to_int32(ctx, argv[0]);
      const char* name = lwsjs_callback_name(reason);

      if(name) {
        char buf[strlen(name) + 1];
        camelize(buf, sizeof(buf), name);
        buf[0] = toupper(buf[0]);

        ret = JS_NewString(ctx, buf);
      }

      break;
    }

    case FUNCTION_GET_CALLBACK_NUMBER: {
      const char* name = JS_ToCString(ctx, argv[0]);

      enum lws_callback_reasons reason = lwsjs_callback_find(name);

      ret = JS_NewInt32(ctx, reason);
      break;
    }

    case FUNCTION_LOG: {
      const char* msg = NULL;
      int32_t level = -1;
      LWSSocket* ls = NULL;
      LWSContext* lc = NULL;
      uint8_t* buf = NULL;
      size_t len;
      int i;

      for(i = 0; i < argc; ++i) {
        if(argc > 1 && level == -1 && JS_IsNumber(argv[i]))
          level = to_int32(ctx, argv[i]);
        else if(argc > 1 && ls == NULL && (ls = JS_GetOpaque(argv[i], lwsjs_socket_class_id)))
          continue;
        else if(argc > 1 && lc == NULL && (lc = JS_GetOpaque(argv[i], lwsjs_context_class_id)))
          continue;
        else if(buf == NULL && (buf = JS_GetArrayBuffer(ctx, &len, argv[i])))
          continue;
        else if(msg == NULL && !(msg = JS_ToCString(ctx, argv[i])))
          return JS_ThrowTypeError(ctx, "argument %d must be string", i + 1);
      }

      if(level == -1)
        level = LLL_USER;

      if(buf) {
        if(lc)
          lwsl_hexdump_context(lc->ctx, level, buf, len);
        else if(ls)
          lwsl_hexdump_wsi(ls->wsi, level, buf, len);
        else
          lwsl_hexdump_level(level, buf, len);
      } else {
        if(ls)
          _lws_log_cx(lwsl_wsi_get_cx(ls->wsi), lws_log_prepend_wsi, ls->wsi, level, NULL, "%s", msg);
        else if(lc)
          _lws_log_cx(lwsl_context_get_cx(lc->ctx), lws_log_prepend_context, lc->ctx, level, NULL, "%s", msg);
        //   lwsl_cx(lc->ctx, level, "%s", msg);
        else
          _lws_log(level, "%s", msg);
      }

      if(msg)
        JS_FreeCString(ctx, msg);
      break;
    }

    case FUNCTION_PARSE_URI: {
      const char* uri = to_string(ctx, argv[0]);
      const char *protocol, *address, *path;
      int port;

      lws_parse_uri((char*)uri, &protocol, &address, &port, &path);

      ret = JS_NewObject(ctx);

      if(protocol)
        JS_SetPropertyStr(ctx, ret, "protocol", JS_NewString(ctx, protocol));

      if(address)
        JS_SetPropertyStr(ctx, ret, "address", JS_NewString(ctx, address));

      JS_SetPropertyStr(ctx, ret, "port", JS_NewInt32(ctx, port));

      if(path)
        JS_SetPropertyStr(ctx, ret, "path", JS_NewString(ctx, path));

      js_free(ctx, (char*)uri);
      break;
    }

    case FUNCTION_VISIBLE: {
      int32_t level = to_int32(ctx, argv[0]);
      ret = JS_NewBool(ctx, lwsl_visible(level));
      break;
    }

    case FUNCTION_TO_STRING: {
      size_t n;
      uint8_t* p;

      if((p = JS_GetArrayBuffer(ctx, &n, argv[0]))) {
        int32_t index = argc > 1 ? to_int32(ctx, argv[1]) : 0;

        index = WRAPAROUND(index, (signed)n);
        index = MAX(0, index);
        index = MIN((signed)(n - 1), index);

        uint32_t len = n - index;

        if(argc > 2) {
          uint32_t l = to_uint32(ctx, argv[2]);

          len = MIN(l, len);
        }

        ret = JS_NewStringLen(ctx, (const char*)p + index, len);
      }

      break;
    }

    case FUNCTION_TO_ARRAYBUFFER: {
      size_t n;
      uint8_t* p;
      const char* s;

      if((p = JS_GetArrayBuffer(ctx, &n, argv[0])))
        ret = JS_DupValue(ctx, argv[0]);
      else if((s = JS_ToCStringLen(ctx, &n, argv[0]))) {
        ret = JS_NewArrayBufferCopy(ctx, (const uint8_t*)s, n);

        JS_FreeCString(ctx, s);
      }

      break;
    }
  }

  return ret;
}

static const JSCFunctionListEntry lws_funcs[] = {
    JS_CFUNC_MAGIC_DEF("getCallbackName", 1, lwsjs_functions, FUNCTION_GET_CALLBACK_NAME),
    JS_CFUNC_MAGIC_DEF("getCallbackNumber", 1, lwsjs_functions, FUNCTION_GET_CALLBACK_NUMBER),
    JS_CFUNC_MAGIC_DEF("log", 2, lwsjs_functions, FUNCTION_LOG),
    JS_CFUNC_MAGIC_DEF("parseUri", 1, lwsjs_functions, FUNCTION_PARSE_URI),
    JS_CFUNC_MAGIC_DEF("visible", 1, lwsjs_functions, FUNCTION_VISIBLE),
    JS_CFUNC_MAGIC_DEF("toString", 1, lwsjs_functions, FUNCTION_TO_STRING),
    JS_CFUNC_MAGIC_DEF("toArrayBuffer", 1, lwsjs_functions, FUNCTION_TO_ARRAYBUFFER),
    JS_PROP_INT32_DEF("LWSMPRO_HTTP", LWSMPRO_HTTP, 0),
    JS_PROP_INT32_DEF("LWSMPRO_HTTPS", LWSMPRO_HTTPS, 0),
    JS_PROP_INT32_DEF("LWSMPRO_FILE", LWSMPRO_FILE, 0),
    JS_PROP_INT32_DEF("LWSMPRO_CGI", LWSMPRO_CGI, 0),
    JS_PROP_INT32_DEF("LWSMPRO_REDIR_HTTP", LWSMPRO_REDIR_HTTP, 0),
    JS_PROP_INT32_DEF("LWSMPRO_REDIR_HTTPS", LWSMPRO_REDIR_HTTPS, 0),
    JS_PROP_INT32_DEF("LWSMPRO_CALLBACK", LWSMPRO_CALLBACK, 0),
    JS_PROP_INT32_DEF("LWSMPRO_NO_MOUNT", LWSMPRO_NO_MOUNT, 0),

    JS_CONSTANT(LWS_PRE),

    JS_CONSTANT(LWS_WRITE_TEXT),
    JS_CONSTANT(LWS_WRITE_BINARY),
    JS_CONSTANT(LWS_WRITE_CONTINUATION),
    JS_CONSTANT(LWS_WRITE_HTTP),
    JS_CONSTANT(LWS_WRITE_PING),
    JS_CONSTANT(LWS_WRITE_PONG),
    JS_CONSTANT(LWS_WRITE_HTTP_FINAL),
    JS_CONSTANT(LWS_WRITE_HTTP_HEADERS),
    JS_CONSTANT(LWS_WRITE_HTTP_HEADERS_CONTINUATION),
    JS_CONSTANT(LWS_WRITE_BUFLIST),
    JS_CONSTANT(LWS_WRITE_NO_FIN),
    JS_CONSTANT(LWS_WRITE_H2_STREAM_END),
    JS_CONSTANT(LWS_WRITE_CLIENT_IGNORE_XOR_MASK),
    JS_CONSTANT(LWS_WRITE_RAW),

    JS_CONSTANT(LLL_ERR),
    JS_CONSTANT(LLL_WARN),
    JS_CONSTANT(LLL_NOTICE),
    JS_CONSTANT(LLL_INFO),
    JS_CONSTANT(LLL_DEBUG),
    JS_CONSTANT(LLL_PARSER),
    JS_CONSTANT(LLL_HEADER),
    JS_CONSTANT(LLL_EXT),
    JS_CONSTANT(LLL_CLIENT),
    JS_CONSTANT(LLL_LATENCY),
    JS_CONSTANT(LLL_USER),
    JS_CONSTANT(LLL_THREAD),
    JS_CONSTANT(LLL_COUNT),

    JS_CONSTANT(LWS_SERVER_OPTION_REQUIRE_VALID_OPENSSL_CLIENT_CERT),
    JS_CONSTANT(LWS_SERVER_OPTION_SKIP_SERVER_CANONICAL_NAME),
    JS_CONSTANT(LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT),
    JS_CONSTANT(LWS_SERVER_OPTION_LIBEV),
    JS_CONSTANT(LWS_SERVER_OPTION_DISABLE_IPV6),
    JS_CONSTANT(LWS_SERVER_OPTION_DISABLE_OS_CA_CERTS),
    JS_CONSTANT(LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED),
    JS_CONSTANT(LWS_SERVER_OPTION_VALIDATE_UTF8),
    JS_CONSTANT(LWS_SERVER_OPTION_SSL_ECDH),
    JS_CONSTANT(LWS_SERVER_OPTION_LIBUV),
    JS_CONSTANT(LWS_SERVER_OPTION_REDIRECT_HTTP_TO_HTTPS),
    JS_CONSTANT(LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT),
    JS_CONSTANT(LWS_SERVER_OPTION_EXPLICIT_VHOSTS),
    JS_CONSTANT(LWS_SERVER_OPTION_UNIX_SOCK),
    JS_CONSTANT(LWS_SERVER_OPTION_STS),
    JS_CONSTANT(LWS_SERVER_OPTION_IPV6_V6ONLY_MODIFY),
    JS_CONSTANT(LWS_SERVER_OPTION_IPV6_V6ONLY_VALUE),
    JS_CONSTANT(LWS_SERVER_OPTION_UV_NO_SIGSEGV_SIGFPE_SPIN),
    JS_CONSTANT(LWS_SERVER_OPTION_JUST_USE_RAW_ORIGIN),
    JS_CONSTANT(LWS_SERVER_OPTION_FALLBACK_TO_RAW),
    JS_CONSTANT(LWS_SERVER_OPTION_FALLBACK_TO_APPLY_LISTEN_ACCEPT_CONFIG),
    JS_CONSTANT(LWS_SERVER_OPTION_LIBEVENT),
    JS_CONSTANT(LWS_SERVER_OPTION_ONLY_RAW),
    JS_CONSTANT(LWS_SERVER_OPTION_ADOPT_APPLY_LISTEN_ACCEPT_CONFIG),
    JS_CONSTANT(LWS_SERVER_OPTION_ALLOW_LISTEN_SHARE),
    JS_CONSTANT(LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX),
    JS_CONSTANT(LWS_SERVER_OPTION_SKIP_PROTOCOL_INIT),
    JS_CONSTANT(LWS_SERVER_OPTION_IGNORE_MISSING_CERT),
    JS_CONSTANT(LWS_SERVER_OPTION_VHOST_UPG_STRICT_HOST_CHECK),
    JS_CONSTANT(LWS_SERVER_OPTION_HTTP_HEADERS_SECURITY_BEST_PRACTICES_ENFORCE),
    JS_CONSTANT(LWS_SERVER_OPTION_ALLOW_HTTP_ON_HTTPS_LISTENER),
    JS_CONSTANT(LWS_SERVER_OPTION_FAIL_UPON_UNABLE_TO_BIND),
    JS_CONSTANT(LWS_SERVER_OPTION_H2_JUST_FIX_WINDOW_UPDATE_OVERFLOW),
    JS_CONSTANT(LWS_SERVER_OPTION_VH_H2_HALF_CLOSED_LONG_POLL),
    JS_CONSTANT(LWS_SERVER_OPTION_GLIB),
    JS_CONSTANT(LWS_SERVER_OPTION_H2_PRIOR_KNOWLEDGE),
    JS_CONSTANT(LWS_SERVER_OPTION_NO_LWS_SYSTEM_STATES),
    JS_CONSTANT(LWS_SERVER_OPTION_SS_PROXY),
    JS_CONSTANT(LWS_SERVER_OPTION_SDEVENT),
    JS_CONSTANT(LWS_SERVER_OPTION_ULOOP),
    JS_CONSTANT(LWS_SERVER_OPTION_DISABLE_TLS_SESSION_CACHE),
};

static const char* lws_callback_names[] = {
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

static const char*
lwsjs_callback_name(enum lws_callback_reasons reason) {
  if(reason >= 0 && reason < countof(lws_callback_names))
    return lws_callback_names[reason];

  return 0;
}

enum lws_callback_reasons
lwsjs_callback_find(const char* name) {
  char buf[128];

  decamelize(buf, sizeof(buf), name);

  for(size_t i = 0; i <= LWS_CALLBACK_USER; i++)
    if(lws_callback_names[i])
      if(!strcmp(lws_callback_names[i], buf))
        return i;

  return -1;
}

void
lwsjs_get_lws_callbacks(JSContext* ctx, JSValueConst obj, JSValue callbacks[]) {
  for(size_t i = 0; i <= LWS_CALLBACK_MQTT_SHADOW_TIMEOUT; i++) {
    if(lws_callback_names[i]) {
      char buf[128];

      buf[0] = 'o';
      buf[1] = 'n';

      camelize(&buf[2], sizeof(buf) - 2, lws_callback_names[i]);
      buf[2] = toupper(buf[2]);

      callbacks[i] = JS_GetPropertyStr(ctx, obj, buf);
      continue;
    }

    callbacks[i] = JS_NULL;
  }
}

BOOL
lwsjs_has_property(JSContext* ctx, JSValueConst obj, const char* name) {
  JSAtom atom = JS_NewAtom(ctx, name);
  BOOL ret = JS_HasProperty(ctx, obj, atom);
  JS_FreeAtom(ctx, atom);
  return ret;
}

JSValue
lwsjs_get_property(JSContext* ctx, JSValueConst obj, const char* name) {
  if(!lwsjs_has_property(ctx, obj, name)) {
    char buf[strlen(name) + 1];

    camelize(buf, sizeof(buf), name);

    return JS_GetPropertyStr(ctx, obj, buf);
  }

  return JS_GetPropertyStr(ctx, obj, name);
}

static const char* lwsjs_log_levels[] = {
    "ERR",
    "WARN",
    "NOTICE",
    "INFO",
    "DEBUG",
    "PARSER",
    "HEADER",
    "EXT",
    "CLIENT",
    "LATENCY",
    "USER",
    "THREAD",
};

static const char* const lwsjs_log_colours[] = {
    "[31;1m", /* LLL_ERR */
    "[36;1m", /* LLL_WARN */
    "[35;1m", /* LLL_NOTICE */
    "[32;1m", /* LLL_INFO */
    "[34;1m", /* LLL_DEBUG */
    "[33;1m", /* LLL_PARSER */
    "[33m",   /* LLL_HEADER */
    "[33m",   /* LLL_EXT */
    "[33m",   /* LLL_CLIENT */
    "[33;1m", /* LLL_LATENCY */
    "[0;1m",  /* LLL_USER */
    "[31m",   /* LLL_THREAD */
};

static void
lwsjs_log_callback(int level, const char* line) {
  line = strstr(line, ": ");
  line += 2;

  if(!strncmp(line, ": ", 2))
    line += 2;

  while(isspace(*line))
    ++line;

  level = 31 - clz(level);

  if(level >= (int)countof(lwsjs_log_levels))
    fprintf(stderr, "level overflow: %i\n", level);

  fprintf(stderr, "<%s> \x1b%s%s\x1b[0m", lwsjs_log_levels[level], lwsjs_log_colours[level], line);
  fflush(stderr);
}

int
lwsjs_init(JSContext* ctx, JSModuleDef* m) {
  lwsjs_context_init(ctx, m);
  lwsjs_socket_init(ctx, m);
  lwsjs_spa_init(ctx, m);

  if(m)
    JS_SetModuleExportList(ctx, m, lws_funcs, countof(lws_funcs));

  return 0;
}

VISIBLE JSModuleDef*
js_init_module(JSContext* ctx, const char* module_name) {
  JSModuleDef* m;

  if((m = JS_NewCModule(ctx, module_name, lwsjs_init))) {
    JS_AddModuleExport(ctx, m, "LWSContext");
    JS_AddModuleExport(ctx, m, "LWSSocket");
    JS_AddModuleExport(ctx, m, "LWSSPA");
    JS_AddModuleExportList(ctx, m, lws_funcs, countof(lws_funcs));
  }

  // lws_set_log_level((LLL_USER << 1) - 1, 0);
  // lws_set_log_level((LLL_USER << 1) - 1, &lwsjs_log_callback);
  lws_set_log_level(LLL_USER | LLL_ERR | LLL_WARN, &lwsjs_log_callback);

  return m;
}
