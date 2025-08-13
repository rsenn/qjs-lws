#include "lws-socket.h"
#include "lws-context.h"
#include "lws-sockaddr46.h"
#include "lws.h"
#include "js-utils.h"

static uint32_t lwsjs_loglevel = LLL_USER | LLL_ERR /*| LLL_WARN | LLL_INFO | LLL_NOTICE*/;

JSContext* lwsjs_log_ctx = 0;
JSValue lwsjs_log_fn = JS_UNDEFINED;

static void lwsjs_log_callback(int, const char*);

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
    "\033[38;5;88m",  /* LLL_ERR */
    "\033[38;5;166m", /* LLL_WARN */
    "\033[38;5;208m", /* LLL_NOTICE */
    "\033[38;5;214m", /* LLL_INFO */
    "\033[38;5;220m", /* LLL_DEBUG */
    "\033[38;5;226m", /* LLL_PARSER */
    "\033[38;5;154m", /* LLL_HEADER */
    "\033[38;5;40m",  /* LLL_EXT */
    "\033[38;5;36m",  /* LLL_CLIENT */
    "\033[38;5;74m",  /* LLL_LATENCY */
    "\033[38;5;69m",  /* LLL_USER */
    "\033[38;5;135m", /* LLL_THREAD */
};

size_t
camelize(char* dst, size_t dlen, const char* src) {
  size_t i, j;

  for(i = 0, j = 0; src[i] && j + 1 < dlen; ++i, ++j) {
    if(src[i] == '_') {
      ++i;
      dst[j] = toupper(src[i]);
      continue;
    }

    dst[j] = tolower(src[i]);
  }

  dst[j] = '\0';
  return j;
}

size_t
decamelize(char* dst, size_t dlen, const char* src) {
  size_t i, j;

  for(i = 0, j = 0; src[i] && j + 1 < dlen; ++i, ++j) {
    if(i > 0 && islower(src[i - 1]) && isupper(src[i]))
      dst[j++] = '_';

    dst[j] = toupper(src[i]);
  }

  dst[j] = '\0';
  return j;
}

int
lwsjs_html_process_args(JSContext* ctx, struct lws_process_html_args* pha, int argc, JSValueConst argv[]) {
  size_t len;
  uint8_t* buf;
  int ret = 1;

  if(argc == 0 || !(buf = JS_GetArrayBuffer(ctx, &len, argv[0])))
    return 0;

  pha->p = (char*)buf;
  pha->len = 0;
  pha->max_len = len;
  pha->final = pha->chunked = 0;

  if(argc > 1) {
    pha->len = to_integerfree(ctx, JS_IsObject(argv[1]) ? JS_GetPropertyUint32(ctx, argv[1], 0) : JS_DupValue(ctx, argv[1]));
    ++ret;
  }

  return ret;
}

void
lwsjs_uri_toconnectinfo(JSContext* ctx, char* uri, LWSClientConnectInfo* info) {
  const char *protocol, *host, *path;
  int port;
  int r = lws_parse_uri((char*)uri, &protocol, &host, &port, &path);

  if(protocol) {
    BOOL ssl = !strcmp(protocol, "https") || !strcmp(protocol, "wss");
    BOOL http = !strncmp(protocol, "http", 4);

    if(http)
      str_replace(ctx, &info->method, js_strdup(ctx, "GET"));

    if(ssl)
      info->ssl_connection = LCCSCF_USE_SSL | LCCSCF_ALLOW_SELFSIGNED | LCCSCF_ALLOW_INSECURE | LCCSCF_ALLOW_EXPIRED | LCCSCF_SKIP_SERVER_CERT_HOSTNAME_CHECK;
  }

  if(host)
    str_replace(ctx, &info->host, js_strdup(ctx, host));

  info->port = port;

  if(path)
    str_replace(ctx, &info->path, js_strdup(ctx, path));
}

char*
lwsjs_connectinfo_to_uri(JSContext* ctx, const LWSClientConnectInfo* info) {
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

enum {
  FUNCTION_GET_LOG_LEVEL_NAME = 0,
  FUNCTION_GET_LOG_LEVEL_COLOUR,
  FUNCTION_GET_CALLBACK_NAME,
  FUNCTION_GET_CALLBACK_NUMBER,
  FUNCTION_GET_TOKEN_NAME,
  FUNCTION_LOG,
  FUNCTION_PARSE_URI,
  FUNCTION_VISIBLE,
  FUNCTION_TO_STRING,
  FUNCTION_TO_POINTER,
  FUNCTION_TO_ARRAYBUFFER,
  FUNCTION_LOGLEVEL,
  FUNCTION_WRITE,
  FUNCTION_PARSE_MAC,
  FUNCTION_PARSE_NUMERIC_ADDRESS,
  FUNCTION_WRITE_NUMERIC_ADDRESS,
  FUNCTION_INTERFACE_TO_SA,
};

static JSValue
lwsjs_functions(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[], int magic) {
  JSValue ret = JS_UNDEFINED;

  switch(magic) {
    case FUNCTION_GET_LOG_LEVEL_NAME: {
      size_t level = to_uint32(ctx, argv[0]);

      if(level >= 0 && level < countof(lwsjs_log_levels))
        ret = JS_NewString(ctx, lwsjs_log_levels[level]);

      break;
    }
    case FUNCTION_GET_LOG_LEVEL_COLOUR: {
      size_t level = to_uint32(ctx, argv[0]);

      if(level >= 0 && level < countof(lwsjs_log_colours))
        ret = JS_NewString(ctx, lwsjs_log_colours[level]);

      break;
    }
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

    case FUNCTION_GET_TOKEN_NAME: {
      enum lws_token_indexes ti = to_int32(ctx, argv[0]);

      if(ti >= WSI_TOKEN_GET_URI && ti < WSI_TOKEN_COUNT) {
        const char* str = (const char*)lws_token_to_string(ti);
        size_t i;

        for(i = 0; str[i]; i++)
          if(str[i] == ' ' || str[i] == ':')
            break;

        ret = JS_NewStringLen(ctx, str, i);
      }

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
      char* uri;

      if((uri = to_string(ctx, argv[0]))) {
        LWSClientConnectInfo info = {0};

        // ret = argc > 1 ? JS_DupValue(ctx, argv[1]) : JS_NewObjectProto(ctx, JS_NULL);

        lwsjs_uri_toconnectinfo(ctx, uri, &info);

        js_free(ctx, (char*)uri);
      }

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

      if((p = get_buffer(ctx, argc, argv, &n)))
        ret = JS_NewStringLen(ctx, (const char*)p, n);

      break;
    }

    case FUNCTION_TO_POINTER: {
      size_t n;
      uint8_t* p;

      if((p = get_buffer(ctx, argc, argv, &n))) {
        char buf[64];
        snprintf(buf, sizeof(buf), "%p", p);
        ret = JS_NewString(ctx, buf);
      }

      break;
    }

    case FUNCTION_TO_ARRAYBUFFER: {
      size_t maxlen, len, ofs;
      uint8_t* ptr;
      const char* s;

      if((ptr = JS_GetArrayBuffer(ctx, &maxlen, argv[0]))) {
        ofs = get_offset_length(ctx, argc - 1, argv + 1, maxlen, &len);

        if(ofs == 0 && maxlen == len)
          ret = JS_DupValue(ctx, argv[0]);
        else
          ret = JS_NewArrayBufferCopy(ctx, ptr + ofs, len);
      } else if((s = JS_ToCStringLen(ctx, &maxlen, argv[0]))) {
        ofs = get_offset_length(ctx, argc - 1, argv + 1, maxlen, &len);

        ret = JS_NewArrayBufferCopy(ctx, (const uint8_t*)s + ofs, len);

        JS_FreeCString(ctx, s);
      }

      if(ptr == 0)
        JS_GetException(ctx);
      break;
    }

    case FUNCTION_LOGLEVEL: {
      if(argc > 0) {
        lwsjs_loglevel = to_uint32(ctx, argv[0]);

        if(argc > 1 && JS_IsFunction(ctx, argv[1])) {
          lwsjs_log_ctx = JS_DupContext(ctx);
          lwsjs_log_fn = JS_DupValue(ctx, argv[1]);
        } else {
          if(lwsjs_log_ctx) {
            JS_FreeContext(lwsjs_log_ctx);
            lwsjs_log_ctx = 0;
          }
          JS_FreeValue(ctx, lwsjs_log_fn);
          lwsjs_log_fn = JS_UNDEFINED;
        }

        lws_set_log_level(lwsjs_loglevel, &lwsjs_log_callback);
      } else {
        ret = JS_NewUint32(ctx, lwsjs_loglevel);
      }

      break;
    }

    case FUNCTION_WRITE: {
      size_t len;
      uint8_t* buf;
      const char* str = 0;

      if(!(buf = JS_GetArrayBuffer(ctx, &len, argv[0])) && !(str = JS_ToCStringLen(ctx, &len, argv[0]))) {
        ret = JS_ThrowTypeError(ctx, "argument 1 must be ArrayBuffer or String");
        break;
      }

      buf = (uint8_t*)str;

      struct lws_process_html_args a = {0}, b;
      int i = lwsjs_html_process_args(ctx, &a, argc - 1, argv + 1);

      b = a;
      b.p += b.len;
      b.max_len -= b.len;

      int n = MIN((int)len, b.max_len);

      if(n >= 0)
        memcpy(b.p, buf, n);

      a.len += n;

      if(argc > 2 && JS_IsObject(argv[2]))
        JS_SetPropertyUint32(ctx, argv[2], 0, JS_NewUint32(ctx, a.len));

      ret = JS_NewUint32(ctx, n);

      if(str)
        JS_FreeCString(ctx, str);

      break;
    }

    case FUNCTION_PARSE_MAC: {
      size_t n;
      uint8_t buf[6];
      uint8_t* p = buf;

      if(argc > 1) {
        if((p = get_buffer(ctx, argc - 1, argv + 1, &n)))
          if(n < 6)
            return JS_ThrowRangeError(ctx, "ArrayBuffer must be at least 6 bytes");
      }

      const char* mac = JS_ToCString(ctx, argv[0]);
      int r = lws_parse_mac(mac, p);

      if(p == buf)
        ret = JS_NewArrayBufferCopy(ctx, buf, 6);
      else
        ret = JS_NewInt32(ctx, r);

      JS_FreeCString(ctx, mac);
      break;
    }
    case FUNCTION_PARSE_NUMERIC_ADDRESS: {
      size_t n;
      uint8_t buf[16];
      uint8_t* p = buf;

      if(argc > 1) {
        if((p = get_buffer(ctx, argc - 1, argv + 1, &n)))
          if(n < 16)
            return JS_ThrowRangeError(ctx, "ArrayBuffer must be at least 16 bytes");
      }

      const char* addr = JS_ToCString(ctx, argv[0]);
      int r = lws_parse_numeric_address(addr, p, 16);

      if(p == buf)
        ret = JS_NewArrayBufferCopy(ctx, buf, r);
      else
        ret = JS_NewInt32(ctx, r);

      JS_FreeCString(ctx, addr);
      break;
    }
    case FUNCTION_WRITE_NUMERIC_ADDRESS: {
      size_t len, n;
      char out[64];
      uint8_t buf[16];
      uint8_t *in, *p = buf;

      if((in = get_buffer(ctx, argc, argv, &len))) {
        if(argc > 1 && JS_IsNumber(argv[1])) {
          len = to_uint32(ctx, argv[1]);

          argc--;
          argv++;
        }
      }
      int r = lws_write_numeric_address(in, len, out, sizeof(out));

      ret = JS_NewStringLen(ctx, out, r);
      break;
    }

    case FUNCTION_INTERFACE_TO_SA: {
      const int ipv6 = to_int32(ctx, argv[0]);
      const size_t size = ipv6 ? sizeof(struct sockaddr_in6) : sizeof(struct sockaddr_in);
      size_t n;
      uint8_t buf[size];
      uint8_t* p = buf;

      if(argc > 2) {
        if((p = get_buffer(ctx, argc - 2, argv + 2, &n)))
          if(n < size)
            return JS_ThrowRangeError(ctx, "ArrayBuffer must be at least %zu bytes", size);
      }

      const char* iface = JS_ToCString(ctx, argv[1]);
      int r = lws_interface_to_sa(ipv6, iface, (void*)p, size);

      if(p == buf)
        ret = JS_NewArrayBufferCopy(ctx, buf, size);
      else
        ret = JS_NewInt32(ctx, r);

      JS_FreeCString(ctx, iface);
      break;
    }
  }

  return ret;
}

static const JSCFunctionListEntry lws_funcs[] = {
    JS_CFUNC_MAGIC_DEF("getLogLevelName", 1, lwsjs_functions, FUNCTION_GET_LOG_LEVEL_NAME),
    JS_CFUNC_MAGIC_DEF("getLogLevelColour", 1, lwsjs_functions, FUNCTION_GET_LOG_LEVEL_COLOUR),
    JS_CFUNC_MAGIC_DEF("getCallbackName", 1, lwsjs_functions, FUNCTION_GET_CALLBACK_NAME),
    JS_CFUNC_MAGIC_DEF("getCallbackNumber", 1, lwsjs_functions, FUNCTION_GET_CALLBACK_NUMBER),
    JS_CFUNC_MAGIC_DEF("getTokenName", 1, lwsjs_functions, FUNCTION_GET_TOKEN_NAME),
    JS_CFUNC_MAGIC_DEF("log", 2, lwsjs_functions, FUNCTION_LOG),
    JS_CFUNC_MAGIC_DEF("logLevel", 0, lwsjs_functions, FUNCTION_LOGLEVEL),
    JS_CFUNC_MAGIC_DEF("parseUri", 1, lwsjs_functions, FUNCTION_PARSE_URI),
    JS_CFUNC_MAGIC_DEF("visible", 1, lwsjs_functions, FUNCTION_VISIBLE),
    JS_CFUNC_MAGIC_DEF("toString", 1, lwsjs_functions, FUNCTION_TO_STRING),
    JS_CFUNC_MAGIC_DEF("toArrayBuffer", 1, lwsjs_functions, FUNCTION_TO_ARRAYBUFFER),
    JS_CFUNC_MAGIC_DEF("toPointer", 1, lwsjs_functions, FUNCTION_TO_POINTER),
    JS_CFUNC_MAGIC_DEF("write", 2, lwsjs_functions, FUNCTION_WRITE),
    JS_CFUNC_MAGIC_DEF("parseMac", 1, lwsjs_functions, FUNCTION_PARSE_MAC),
    JS_CFUNC_MAGIC_DEF("parseNumericAddress", 1, lwsjs_functions, FUNCTION_PARSE_NUMERIC_ADDRESS),
    JS_CFUNC_MAGIC_DEF("writeNumericAddress", 1, lwsjs_functions, FUNCTION_WRITE_NUMERIC_ADDRESS),
    JS_CFUNC_MAGIC_DEF("interfaceToSa", 1, lwsjs_functions, FUNCTION_INTERFACE_TO_SA),
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

    JS_CONSTANT(CONTEXT_PORT_NO_LISTEN),

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
    JS_CONSTANT(LWS_ILLEGAL_HTTP_CONTENT_LEN),

    JS_CONSTANT(WSI_TOKEN_GET_URI),
    JS_CONSTANT(WSI_TOKEN_POST_URI),
#if defined(LWS_WITH_HTTP_UNCOMMON_HEADERS) || defined(LWS_HTTP_HEADERS_ALL)
    JS_CONSTANT(WSI_TOKEN_OPTIONS_URI),
#endif
    JS_CONSTANT(WSI_TOKEN_HOST),
    JS_CONSTANT(WSI_TOKEN_CONNECTION),
    JS_CONSTANT(WSI_TOKEN_UPGRADE),
    JS_CONSTANT(WSI_TOKEN_ORIGIN),
#if defined(LWS_ROLE_WS) || defined(LWS_HTTP_HEADERS_ALL)
    JS_CONSTANT(WSI_TOKEN_DRAFT),
#endif
    JS_CONSTANT(WSI_TOKEN_CHALLENGE),
#if defined(LWS_ROLE_WS) || defined(LWS_HTTP_HEADERS_ALL)
    JS_CONSTANT(WSI_TOKEN_EXTENSIONS),
    JS_CONSTANT(WSI_TOKEN_KEY1),
    JS_CONSTANT(WSI_TOKEN_KEY2),
    JS_CONSTANT(WSI_TOKEN_PROTOCOL),
    JS_CONSTANT(WSI_TOKEN_ACCEPT),
    JS_CONSTANT(WSI_TOKEN_NONCE),
#endif
    JS_CONSTANT(WSI_TOKEN_HTTP),
#if defined(LWS_ROLE_H2) || defined(LWS_HTTP_HEADERS_ALL)
    JS_CONSTANT(WSI_TOKEN_HTTP2_SETTINGS),
#endif
    JS_CONSTANT(WSI_TOKEN_HTTP_ACCEPT),
#if defined(LWS_WITH_HTTP_UNCOMMON_HEADERS) || defined(LWS_HTTP_HEADERS_ALL)
    JS_CONSTANT(WSI_TOKEN_HTTP_AC_REQUEST_HEADERS),
#endif
    JS_CONSTANT(WSI_TOKEN_HTTP_IF_MODIFIED_SINCE),
    JS_CONSTANT(WSI_TOKEN_HTTP_IF_NONE_MATCH),
    JS_CONSTANT(WSI_TOKEN_HTTP_ACCEPT_ENCODING),
    JS_CONSTANT(WSI_TOKEN_HTTP_ACCEPT_LANGUAGE),
    JS_CONSTANT(WSI_TOKEN_HTTP_PRAGMA),
    JS_CONSTANT(WSI_TOKEN_HTTP_CACHE_CONTROL),
    JS_CONSTANT(WSI_TOKEN_HTTP_AUTHORIZATION),
    JS_CONSTANT(WSI_TOKEN_HTTP_COOKIE),
    JS_CONSTANT(WSI_TOKEN_HTTP_CONTENT_LENGTH),
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
    JS_CONSTANT(WSI_TOKEN_REPLAY_NONCE),
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

    JS_CONSTANT(LWSHUMETH_GET),
    JS_CONSTANT(LWSHUMETH_POST),
    JS_CONSTANT(LWSHUMETH_OPTIONS),
    JS_CONSTANT(LWSHUMETH_PUT),
    JS_CONSTANT(LWSHUMETH_PATCH),
    JS_CONSTANT(LWSHUMETH_DELETE),
    JS_CONSTANT(LWSHUMETH_CONNECT),
    JS_CONSTANT(LWSHUMETH_HEAD),
    JS_CONSTANT(LWSHUMETH_COLON_PATH),

    JS_CONSTANT(LCCSCF_USE_SSL),
    JS_CONSTANT(LCCSCF_ALLOW_SELFSIGNED),
    JS_CONSTANT(LCCSCF_SKIP_SERVER_CERT_HOSTNAME_CHECK),
    JS_CONSTANT(LCCSCF_ALLOW_EXPIRED),
    JS_CONSTANT(LCCSCF_ALLOW_INSECURE),
    JS_CONSTANT(LCCSCF_H2_QUIRK_NGHTTP2_END_STREAM),
    JS_CONSTANT(LCCSCF_H2_QUIRK_OVERFLOWS_TXCR),
    JS_CONSTANT(LCCSCF_H2_AUTH_BEARER),
    JS_CONSTANT(LCCSCF_H2_HEXIFY_AUTH_TOKEN),
    JS_CONSTANT(LCCSCF_H2_MANUAL_RXFLOW),
    JS_CONSTANT(LCCSCF_HTTP_MULTIPART_MIME),
    JS_CONSTANT(LCCSCF_HTTP_X_WWW_FORM_URLENCODED),
    JS_CONSTANT(LCCSCF_HTTP_NO_FOLLOW_REDIRECT),
    JS_CONSTANT(LCCSCF_HTTP_NO_CACHE_CONTROL),
    JS_CONSTANT(LCCSCF_ALLOW_REUSE_ADDR),
    JS_CONSTANT(LCCSCF_IPV6_PREFER_PUBLIC_ADDR),
    JS_CONSTANT(LCCSCF_PIPELINE),
    JS_CONSTANT(LCCSCF_MUXABLE_STREAM),
    JS_CONSTANT(LCCSCF_H2_PRIOR_KNOWLEDGE),
    JS_CONSTANT(LCCSCF_WAKE_SUSPEND__VALIDITY),
    JS_CONSTANT(LCCSCF_PRIORITIZE_READS),
    JS_CONSTANT(LCCSCF_SECSTREAM_CLIENT),
    JS_CONSTANT(LCCSCF_SECSTREAM_PROXY_LINK),
    JS_CONSTANT(LCCSCF_SECSTREAM_PROXY_ONWARD),
    JS_CONSTANT(LCCSCF_IP_LOW_LATENCY),
    JS_CONSTANT(LCCSCF_IP_HIGH_THROUGHPUT),
    JS_CONSTANT(LCCSCF_IP_HIGH_RELIABILITY),
    JS_CONSTANT(LCCSCF_IP_LOW_COST),
    JS_CONSTANT(LCCSCF_CONMON),
    JS_CONSTANT(LCCSCF_ACCEPT_TLS_DOWNGRADE_REDIRECTS),
    JS_CONSTANT(LCCSCF_CACHE_COOKIES),
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

const char*
lwsjs_callback_name(enum lws_callback_reasons reason) {
  if(reason >= 0 && reason < countof(lws_callback_names))
    return lws_callback_names[reason];

  return 0;
}

enum lws_callback_reasons
lwsjs_callback_find(const char* name) {
  char buf[128];

  decamelize(buf, sizeof(buf), name);

  for(size_t i = 0; i < countof(lws_callback_names); i++)
    if(lws_callback_names[i])
      if(!strcmp(lws_callback_names[i], buf))
        return i;

  return -1;
}

void
lwsjs_get_lws_callbacks(JSContext* ctx, JSValueConst obj, JSValue callbacks[], size_t callback_count) {
  for(size_t i = 0; i < callback_count; i++) {
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

  if(lwsjs_log_ctx) {
    size_t len = strlen(line);

    while(len > 0) {
      if(!isspace(line[len - 1]))
        break;
      --len;
    }

    JSContext* ctx = lwsjs_log_ctx;
    JSValueConst args[] = {
        JS_NewUint32(ctx, level),
        JS_NewStringLen(ctx, line, len),
    };
    JSValue ret = JS_Call(ctx, lwsjs_log_fn, JS_NULL, 2, args);
    JS_FreeValue(ctx, args[1]);
    JS_FreeValue(ctx, args[0]);
    JS_FreeValue(ctx, ret);
  } else {
    fprintf(stderr, "<%s> %s%s\x1b[0m", lwsjs_log_levels[level], lwsjs_log_colours[level], line);
    fflush(stderr);
  }
}

int
lwsjs_init(JSContext* ctx, JSModuleDef* m) {
  lwsjs_context_init(ctx, m);
  lwsjs_socket_init(ctx, m);
  lwsjs_spa_init(ctx, m);
  lwsjs_sockaddr46_init(ctx, m);

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
    JS_AddModuleExport(ctx, m, "LWSSockAddr46");
    JS_AddModuleExportList(ctx, m, lws_funcs, countof(lws_funcs));
  }

  // lws_set_log_level((LLL_USER << 1) - 1, 0);
  // lws_set_log_level((LLL_USER << 1) - 1, &lwsjs_log_callback);
  lws_set_log_level(lwsjs_loglevel, &lwsjs_log_callback);

  return m;
}
