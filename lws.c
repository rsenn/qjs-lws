#include "lws-socket.h"
#include "lws-context.h"
#include "lws-sockaddr46.h"
#include "lws-vhost.h"
#include "lws-tls.h"
#include "lws-protocol.h"
#include "lws.h"
#include "js-utils.h"
#include <termios.h>
#include <sys/ioctl.h>

#ifdef LWSJS_PRECOMPILED
struct bytecode {
  const uint8_t* code;
  uint32_t size;
};

#define const static const
#include "precompiled.c"
#undef const

static struct bytecode lwsjs_precompiled[] = {
#define X(name, index) {qjsc_##name, qjsc_##name##_size},
#include "precompiled.h"
#undef X
};

#define X(name, index) static JSValue lwsjs_##name##_value = {JS_TAG_UNDEFINED, 0};
#include "precompiled.h"
#undef X

static int lwsjs_precompiled_status = 0;

static JSValue
lwsjs_precompiled_ready(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
#define X(name, index) lwsjs_##name##_value = JS_DupValue(ctx, argc > index ? argv[index] : JS_UNDEFINED);
#include "precompiled.h"
#undef X
  return JS_UNDEFINED;
}

static int
lwsjs_load_precompiled(JSContext* ctx) {
  if(lwsjs_precompiled_status)
    return lwsjs_precompiled_status > 0 ? 0 : -1;

  JSValue global = JS_GetGlobalObject(ctx);
  JS_SetPropertyStr(ctx, global, "__lwsPrecompiledReady", JS_NewCFunction(ctx, lwsjs_precompiled_ready, "__lwsPrecompiledReady", 2));
  JS_FreeValue(ctx, global);

  JSValue entry = JS_UNDEFINED;

  for(size_t i = 0; i < countof(lwsjs_precompiled); i++) {
    JSValue mod = JS_ReadObject(ctx, lwsjs_precompiled[i].code, lwsjs_precompiled[i].size, JS_READ_OBJ_BYTECODE);

    if(JS_IsException(mod)) {
      lwsjs_precompiled_status = -1;
      return -1;
    }

    if(i + 1 == countof(lwsjs_precompiled))
      entry = mod;
  }

  if(JS_ResolveModule(ctx, entry) < 0) {
    JS_FreeValue(ctx, entry);
    lwsjs_precompiled_status = -1;
    return -1;
  }

  JSValue ret = JS_EvalFunction(ctx, entry);

  if(JS_IsException(ret)) {
    JS_FreeValue(ctx, ret);
    lwsjs_precompiled_status = -1;
    return -1;
  }

  JS_FreeValue(ctx, ret);
  lwsjs_precompiled_status = 1;
  return 0;
}

static JSValue
lwsjs_fetch_trampoline(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
  if(lwsjs_load_precompiled(ctx) < 0)
    return JS_EXCEPTION;

  return JS_Call(ctx, lwsjs_fetch_value, JS_UNDEFINED, argc, argv);
}

static JSValue
lwsjs_websocketstream_trampoline(JSContext* ctx, JSValueConst new_target, int argc, JSValueConst* argv) {
  if(lwsjs_load_precompiled(ctx) < 0)
    return JS_EXCEPTION;

  return JS_CallConstructor(ctx, lwsjs_websocketstream_value, argc, argv);
}

static JSValue
lwsjs_websocketstream_protocol_trampoline(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv) {
  if(lwsjs_load_precompiled(ctx) < 0)
    return JS_EXCEPTION;

  JSValue protocol_fn = JS_GetPropertyStr(ctx, lwsjs_websocketstream_value, "protocol");
  JSValue ret = JS_Call(ctx, protocol_fn, lwsjs_websocketstream_value, argc, argv);
  JS_FreeValue(ctx, protocol_fn);
  return ret;
}
#endif

static uint32_t lwsjs_loglevel = LLL_USER | LLL_ERR /*| LLL_WARN | LLL_INFO | LLL_NOTICE*/;
static JSContext* lwsjs_log_ctx = 0;
static JSValue lwsjs_log_fn = {JS_TAG_UNDEFINED, 0};

static void lwsjs_callback_log(int, const char*);

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
    "\033[48;5;88m",  /* LLL_ERR */
    "\033[48;5;166m", /* LLL_WARN */
    "\033[48;5;208m", /* LLL_NOTICE */
    "\033[48;5;214m", /* LLL_INFO */
    "\033[48;5;220m", /* LLL_DEBUG */
    "\033[48;5;226m", /* LLL_PARSER */
    "\033[48;5;154m", /* LLL_HEADER */
    "\033[48;5;40m",  /* LLL_EXT */
    "\033[48;5;36m",  /* LLL_CLIENT */
    "\033[48;5;74m",  /* LLL_LATENCY */
    "\033[48;5;69m",  /* LLL_USER */
    "\033[48;5;135m", /* LLL_THREAD */
};

size_t
lwsjs_camelize(char* dst, size_t dlen, const char* src) {
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
lwsjs_decamelize(char* dst, size_t dlen, const char* src) {
  size_t i, j;

  for(i = 0, j = 0; src[i] && j + 1 < dlen; ++i, ++j) {
    if(i > 0 && islower(src[i - 1]) && isupper(src[i]))
      dst[j++] = '_';

    dst[j] = toupper(src[i]);
  }

  dst[j] = '\0';
  return j;
}

/* Base-10 unsigned long -> decimal string, writing at most outsz-1 digits
   plus a NUL terminator into `out` (truncating the least-significant
   digits first if outsz is too small - same truncate-early contract as
   lwsjs_camelize()/lwsjs_decamelize() above). Returns the number of
   digit characters written (excluding the NUL). */
size_t
lwsjs_utoa(char* out, size_t outsz, unsigned long value) {
  char tmp[3 * sizeof(unsigned long)]; /* worst case: ~2.41 decimal digits per byte, rounded up */
  size_t i = 0, j;

  if(outsz == 0)
    return 0;

  do {
    tmp[i++] = '0' + (value % 10);
    value /= 10;
  } while(value && i < sizeof(tmp));

  if(i >= outsz)
    i = outsz - 1;

  for(j = 0; j < i; ++j)
    out[j] = tmp[i - 1 - j];

  out[j] = '\0';
  return j;
}

/* WHATWG Encoding Standard's UTF-8 decoder (non-fatal mode): replaces
   every malformed byte or byte sequence with U+FFFD instead of
   rejecting the input, byte-range boundaries (including the 0xE0/0xED/
   0xF0/0xF4 lead-byte special cases that rule out overlong encodings,
   surrogate halves, and code points past U+10FFFF) taken directly from
   the spec's decoder algorithm. Used by toString()'s noThrow mode. */
static JSValue
lossy_utf8_decode(JSContext* ctx, const uint8_t* p, size_t n) {
  uint8_t* out;
  size_t out_len = 0, i = 0, seen = 0, needed = 0;
  uint32_t cp = 0;
  uint8_t lower = 0x80, upper = 0xbf;
  JSValue ret;

  if(n == 0)
    return JS_NewStringLen(ctx, "", 0);

  if(!(out = js_malloc(ctx, n * UTF8_CHAR_LEN_MAX)))
    return JS_EXCEPTION;

  while(i < n) {
    uint8_t b = p[i];

    if(!needed) {
      if(b < 0x80) {
        out_len += unicode_to_utf8(out + out_len, b);
        ++i;
        continue;
      }

      if(b >= 0xc2 && b <= 0xdf) {
        needed = 1;
        cp = b & 0x1f;
      } else if(b >= 0xe0 && b <= 0xef) {
        if(b == 0xe0)
          lower = 0xa0;
        else if(b == 0xed)
          upper = 0x9f;
        needed = 2;
        cp = b & 0x0f;
      } else if(b >= 0xf0 && b <= 0xf4) {
        if(b == 0xf0)
          lower = 0x90;
        else if(b == 0xf4)
          upper = 0x8f;
        needed = 3;
        cp = b & 0x07;
      } else {
        /* not a valid lead byte: consume it, emit U+FFFD */
        out_len += unicode_to_utf8(out + out_len, 0xfffd);
        ++i;
        continue;
      }

      seen = 0;
      ++i;
      continue;
    }

    if(b < lower || b > upper) {
      /* bad continuation byte: discard the sequence-so-far as a single
         U+FFFD, but don't consume this byte - it's reprocessed as a
         fresh potential lead byte on the next iteration. */
      out_len += unicode_to_utf8(out + out_len, 0xfffd);
      needed = seen = cp = 0;
      lower = 0x80;
      upper = 0xbf;
      continue;
    }

    lower = 0x80;
    upper = 0xbf;
    cp = (cp << 6) | (b & 0x3f);
    ++seen;
    ++i;

    if(seen == needed) {
      out_len += unicode_to_utf8(out + out_len, cp);
      needed = seen = cp = 0;
    }
  }

  if(needed)
    /* truncated multi-byte sequence at end of input */
    out_len += unicode_to_utf8(out + out_len, 0xfffd);

  ret = JS_NewStringLen(ctx, (const char*)out, out_len);
  js_free(ctx, out);
  return ret;
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
    pha->len = to_int32free(ctx, JS_IsObject(argv[1]) ? JS_GetPropertyUint32(ctx, argv[1], 0) : JS_DupValue(ctx, argv[1]));
    ++ret;
  }

  return ret;
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
        lwsjs_camelize(buf, sizeof(buf), name);
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
      LWSContext* lws = NULL;
      uint8_t* buf = NULL;
      size_t len;
      int i;

      for(i = 0; i < argc; ++i) {
        if(argc > 1 && level == -1 && JS_IsNumber(argv[i]))
          level = to_int32(ctx, argv[i]);
        else if(argc > 1 && ls == NULL && (ls = JS_GetOpaque(argv[i], lwsjs_socket_class_id)))
          continue;
        else if(argc > 1 && lws == NULL && (lws = JS_GetOpaque(argv[i], lwsjs_context_class_id)))
          continue;
        else if(buf == NULL && (buf = JS_GetArrayBuffer(ctx, &len, argv[i])))
          continue;
        else if(msg == NULL && !(msg = JS_ToCString(ctx, argv[i])))
          return JS_ThrowTypeError(ctx, "argument %d must be string", i + 1);
      }

      if(level == -1)
        level = LLL_USER;

      if(buf) {
        if(lws)
          lwsl_hexdump_context(lws->ctx, level, buf, len);
        else if(ls)
          lwsl_hexdump_wsi(ls->wsi, level, buf, len);
        else
          lwsl_hexdump_level(level, buf, len);
      } else {
        if(ls)
          _lws_log_cx(lwsl_wsi_get_cx(ls->wsi), lws_log_prepend_wsi, ls->wsi, level, NULL, "%s", msg);
        else if(lws)
          _lws_log_cx(lwsl_context_get_cx(lws->ctx), lws_log_prepend_context, lws->ctx, level, NULL, "%s", msg);
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
        lws_parse_uri_t* lpu;

        if((lpu = lws_parse_uri_create(uri))) {
          ret = JS_NewObjectProto(ctx, JS_NULL);

          if(lpu->scheme && lpu->scheme[0])
            JS_SetPropertyStr(ctx, ret, "protocol", JS_NewString(ctx, lpu->scheme));

          if(lpu->host && lpu->host[0])
            JS_SetPropertyStr(ctx, ret, "host", JS_NewString(ctx, lpu->host));

          if(lpu->port)
            JS_SetPropertyStr(ctx, ret, "port", JS_NewInt32(ctx, lpu->port));

          if(lpu->path)
            JS_SetPropertyStr(ctx, ret, "path", JS_NewString(ctx, lpu->path));

          // if(lpu->unix_skt) JS_SetPropertyStr(ctx, ret, "unix", JS_TRUE);

          lws_parse_uri_destroy(&lpu);
        }

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
      int no_throw = FALSE, buf_argc = argc;

      /* trailing boolean argument selects WHATWG-style lossy decoding
         (replace invalid UTF-8 with U+FFFD) instead of throwing; not
         part of the buffer/offset/length arguments forwarded below. */
      if(argc > 0 && JS_IsBool(argv[argc - 1])) {
        no_throw = JS_ToBool(ctx, argv[argc - 1]);
        --buf_argc;
      }

      if((p = get_buffer(ctx, buf_argc, argv, &n))) {
        if(no_throw) {
          ret = lossy_utf8_decode(ctx, p, n);
        } else {
          const uint8_t *ptr = p, *end = p + n;

          while(ptr < end) {
            const uint8_t* next;

            if(unicode_from_utf8(ptr, end - ptr, &next) < 0) {
              size_t offset = ptr - p, shown = MIN((size_t)(end - ptr), 4), i;
              char bytes[3 * 4 + 1] = {0};

              for(i = 0; i < shown; i++)
                snprintf(bytes + i * 3, 4, "%02x ", ptr[i]);

              ret = JS_ThrowTypeError(ctx, "invalid UTF-8 at offset %zu: %s", offset, bytes);
              break;
            }

            ptr = next;
          }

          if(!JS_IsException(ret))
            ret = JS_NewStringLen(ctx, (const char*)p, n);
        }
      }

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

        lws_set_log_level(lwsjs_loglevel, &lwsjs_callback_log);
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

      struct lws_process_html_args a = {0};
      int i = lwsjs_html_process_args(ctx, &a, argc - 1, argv + 1);

      struct lws_process_html_args b = a;
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
      uint8_t buf[6], *p = buf;

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
      uint8_t buf[16], *p = buf;

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
      uint8_t buf[16], *in, *p = buf;

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
      uint8_t buf[size], *p = buf;

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
    JS_CFUNC_DEF("generateSelfSignedCert", 1, lwsjs_generate_self_signed_cert),
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
    JS_CONSTANT(LWS_WRITE_QUIC_DATAGRAM),

    JS_CONSTANT(LWSAHH_FLAG_NO_SERVER_NAME),

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

    JS_CONSTANT(LWS_ADOPT_RAW_FILE_DESC),
    JS_CONSTANT(LWS_ADOPT_HTTP),
    JS_CONSTANT(LWS_ADOPT_SOCKET),
    JS_CONSTANT(LWS_ADOPT_ALLOW_SSL),
    JS_CONSTANT(LWS_ADOPT_FLAG_UDP),
    JS_CONSTANT(LWS_ADOPT_FLAG_RAW_PROXY),
    JS_CONSTANT(LWS_ADOPT_RAW_SOCKET_UDP),

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

    JS_CONSTANT(LWS_ADNS_RECORD_A),
    JS_CONSTANT(LWS_ADNS_RECORD_CNAME),
    JS_CONSTANT(LWS_ADNS_RECORD_SOA),
    JS_CONSTANT(LWS_ADNS_RECORD_MX),
    JS_CONSTANT(LWS_ADNS_RECORD_TXT),
    JS_CONSTANT(LWS_ADNS_RECORD_AAAA),
    JS_CONSTANT(LWS_ADNS_RECORD_DS),
    JS_CONSTANT(LWS_ADNS_RECORD_RRSIG),
    JS_CONSTANT(LWS_ADNS_RECORD_NSEC),
    JS_CONSTANT(LWS_ADNS_RECORD_DNSKEY),
    JS_CONSTANT(LWS_ADNS_RECORD_NSEC3),
    JS_CONSTANT(LWS_ADNS_RECORD_HTTPS),

};

static void
lwsjs_log_clean(const char* line, DynBuf* dbuf, DynBuf* func) {
  int i = 0;

  while(line[i]) {
    if((i == 0 || line[i - 1] == ' ') && (line[i] == '_' || line[i] == 'l' || line[i] == 'r')) {
      int j = 0;
      for(; line[i + j] == '_'; ++j)
        ;

      if(line[i] == '_' || !strncmp(&line[i + j], "lws", 3) || !strncmp(&line[i + j], "rops", 4)) {
        int k = i + j + 3;

        while(line[k] && line[k] != ':' && line[k] != ' ')
          ++k;

        if(func) {
          dbuf_put(func, &line[i], k - i);
          dbuf_putc(func, '\0');
        }

        if(line[k] == ':')
          ++k;

        while(line[k] == ' ')
          ++k;

        i = k;
        continue;
      }
    }

    dbuf_putc(dbuf, line[i]);
    ++i;
  }
}

static void
lwsjs_callback_log(int level, const char* line) {
  line = strstr(line, ": ");
  line += 2;

  if(!strncmp(line, ": ", 2))
    line += 2;

  while(isspace(*line))
    ++line;

  level = 31 - clz(level);

  if(level >= (int)countof(lwsjs_log_levels))
    fprintf(stderr, "level overflow: %i\n", level);

  DynBuf dbuf, func;
  dbuf_init(&dbuf);
  dbuf_init(&func);
  lwsjs_log_clean(line, &dbuf, &func);
  dbuf_putc(&dbuf, '\0');
  line = (const char*)dbuf.buf;

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
        func.size ? JS_NewString(ctx, func.buf) : JS_UNDEFINED,
    };
    JSValue ret = JS_Call(ctx, lwsjs_log_fn, JS_NULL, 3, args);
    JS_FreeValue(ctx, args[1]);
    JS_FreeValue(ctx, args[0]);
    JS_FreeValue(ctx, ret);
  } else {
    struct winsize wsz;

    if(ioctl(0, TIOCGWINSZ, &wsz) != 0) {
      memset(&wsz, 0, sizeof(wsz));
    }

    size_t columns = wsz.ws_col;

    char lev[9];
    size_t len = strlen(lwsjs_log_levels[level]);
    int i;
    for(i = 0; i < (sizeof(lev) - len) / 2; i++)
      lev[i] = ' ';
    i += snprintf(&lev[i], sizeof(lev) - i, "%s", lwsjs_log_levels[level]);

    while(i < sizeof(lev))
      lev[i++] = ' ';
    lev[sizeof(lev) - 1] = '\0';

    size_t linelen = strlen(line);

    if(columns == 0)
      columns == linelen;

    fprintf(stderr, "\r\x1b[30m%s%s\x1b[0m %.*s%s\n", lwsjs_log_colours[level], lev, (int)(linelen > columns ? columns - 10 - 3 : linelen), line, linelen > columns ? "..." : "");
    fflush(stderr);
  }

  dbuf_free(&dbuf);
  dbuf_free(&func);
}

/* Bypasses lws's own logging pipe (lwsl_wsi_user() -> _lws_log_cx() ->
   __lws_logv()) entirely, handing an already fully-built message straight
   to lwsjs_callback_log() instead - the same sink function that pipe would
   eventually call, just without going through __lws_logv()'s fixed
   1024-byte internal formatting buffer first (see BUGS:
   lws-log-line-1024-byte-cap - that cap silently truncates a large RX/TX
   log_escape() preview no matter how big a buffer the caller allocated,
   since the truncation happens one layer up from any of that). `buf`
   (`len` bytes, not necessarily NUL-terminated) is expected to already be
   the full message a caller of lwsl_wsi_user(wsi, ...) would normally get
   - starting with the "[wsi tag]: ..." text lws's own lws_wsi_tag()/
   lws_log_prepend_wsi() would have prepended. lwsjs_callback_log() itself
   unconditionally strips one leading "<something>: " (normally the
   timestamp/level-name segment __lws_logv() adds ahead of the wsi tag),
   so this prepends a throwaway one of its own first to keep that contract
   intact without eating into the real wsi tag. `wsi` isn't otherwise
   used here - `buf` already carries its tag - but is taken anyway to
   mirror lwsl_wsi_user()'s own signature at call sites. */
void
lwsjs_log_user(struct lws* wsi, const char* buf, size_t len) {
  (void)wsi;

  static const char throwaway[] = "USER: ";
  char line[sizeof(throwaway) - 1 + len + 1];

  memcpy(line, throwaway, sizeof(throwaway) - 1);
  memcpy(line + sizeof(throwaway) - 1, buf, len);
  line[sizeof(throwaway) - 1 + len] = '\0';

  lwsjs_callback_log(LLL_USER, line);
}

/* Shared tail for every lwsjs_log_user() call site (lws-protocol.c's RX
   path, lws-socket.c's socket_flush()/lwsjs_socket_respond() TX paths):
   appends `data` (`len` bytes) after an already-built `prefix` (`plen`
   bytes, NUL-terminated, from lwsjs_log_rx_prefix()/lwsjs_log_tx_prefix()
   in lws.h) into a stack buffer sized for the true worst case, rendering
   it as a single-line, echo -e-compatible escape - backslash and the
   named control chars use their short C-escape spelling (\\ \a \b \e \f
   \n \r \t \v), every other non-printable byte becomes \xHH, anything
   else passes through unchanged - then dispatches the whole line via
   lwsjs_log_user() above. `log_escape()` was this function's only caller,
   so its body lives here directly rather than as a separate function. */
void
lwsjs_log_user_line(struct lws* wsi, const char* prefix, size_t plen, const void* data, size_t len) {
  static const char named_from[] = "\a\b\e\f\n\r\t\v";
  static const char named_to[] = "abefnrtv";
  static const char hex[] = "0123456789abcdef";
  const uint8_t* in = data;
  char line[plen + 4 * len + 1];
  size_t i, j = plen;

  str_append(line, line + plen + 1, prefix);

  for(i = 0; i < len; ++i) {
    uint8_t c = in[i];
    char buf[4];
    size_t blen;

    if(c == '\\') {
      buf[0] = buf[1] = '\\';
      blen = 2;
    } else if(isprint(c)) {
      buf[0] = (char)c;
      blen = 1;
    } else {
      const char* esc = memchr(named_from, c, sizeof(named_from) - 1);

      if(esc) {
        buf[0] = '\\';
        buf[1] = named_to[esc - named_from];
        blen = 2;
      } else {
        buf[0] = '\\';
        buf[1] = 'x';
        buf[2] = hex[(c >> 4) & 0xf];
        buf[3] = hex[c & 0xf];
        blen = 4;
      }
    }

    memcpy(line + j, buf, blen);
    j += blen;
  }

  line[j] = '\0';

  lwsjs_log_user(wsi, line, j);
}

int
lwsjs_init(JSContext* ctx, JSModuleDef* m) {
  lwsjs_context_init(ctx, m);
  lwsjs_vhost_init(ctx, m);
  lwsjs_socket_init(ctx, m);
  lwsjs_spa_init(ctx, m);
  lwsjs_sockaddr46_init(ctx, m);
#ifdef LWS_WITH_TLS
  lwsjs_tls_certverify_init(ctx, m);
#endif

  if(m) {
    JS_SetModuleExportList(ctx, m, lws_funcs, countof(lws_funcs));
#ifdef LWSJS_PRECOMPILED
    JSValue fetch_fn = JS_NewCFunction(ctx, lwsjs_fetch_trampoline, "fetch", 2);
    JSValue wss_ctor = JS_NewCFunction2(ctx, lwsjs_websocketstream_trampoline, "WebSocketStream", 1, JS_CFUNC_constructor, 0);
    JS_SetPropertyStr(ctx, wss_ctor, "protocol", JS_NewCFunction(ctx, lwsjs_websocketstream_protocol_trampoline, "protocol", 2));
    JS_SetModuleExport(ctx, m, "fetch", fetch_fn);
    JS_SetModuleExport(ctx, m, "WebSocketStream", wss_ctor);
#endif
  }

  return 0;
}

VISIBLE JSModuleDef*
js_init_module(JSContext* ctx, const char* module_name) {
  JSModuleDef* m;

  if((m = JS_NewCModule(ctx, module_name, lwsjs_init))) {
    JS_AddModuleExport(ctx, m, "LWSContext");
    JS_AddModuleExport(ctx, m, "createServer");
    JS_AddModuleExport(ctx, m, "LWSVhost");
    JS_AddModuleExport(ctx, m, "LWSSocket");
    JS_AddModuleExport(ctx, m, "LWSSPA");
    JS_AddModuleExport(ctx, m, "LWSSockAddr46");
#ifdef LWS_WITH_TLS
    JS_AddModuleExport(ctx, m, "X509Certificate");
#endif
    JS_AddModuleExport(ctx, m, "fetch");
    JS_AddModuleExport(ctx, m, "WebSocketStream");
    JS_AddModuleExportList(ctx, m, lws_funcs, countof(lws_funcs));
  }

  // lws_set_log_level((LLL_USER << 1) - 1, 0);
  // lws_set_log_level((LLL_USER << 1) - 1, &lwsjs_callback_log);
  lws_set_log_level(lwsjs_loglevel, &lwsjs_callback_log);

  return m;
}
