#include "lws-socket.h"
#include "lws-context.h"
#include "lws-vhost.h"
#include "lws-sockaddr46.h"
#include "lws.h"
#include "js-utils.h"
#include <assert.h>

#include "libwebsockets/lib/core/private-lib-core.h"
// #include "libwebsockets/lib/roles/private-lib-roles.h"

JSClassID lwsjs_socket_class_id;
static JSValue lwsjs_socket_proto, lwsjs_socket_ctor;

static struct list_head socket_list;
static uint32_t socket_id;

static const enum lws_token_indexes lwsjs_method_tokens[] = {
    WSI_TOKEN_GET_URI,
    WSI_TOKEN_POST_URI,
#ifdef LWS_WITH_HTTP_UNCOMMON_HEADERS
    WSI_TOKEN_OPTIONS_URI,
    WSI_TOKEN_PUT_URI,
    WSI_TOKEN_PATCH_URI,
    WSI_TOKEN_DELETE_URI,
#endif
    WSI_TOKEN_CONNECT,
    WSI_TOKEN_HEAD_URI,
#ifdef LWS_WITH_HTTP2
    WSI_TOKEN_HTTP_COLON_PATH,
#endif
};

static const char* const lwsjs_method_names[] = {
    "GET",
    "POST",
#ifdef LWS_WITH_HTTP_UNCOMMON_HEADERS
    "OPTIONS",
    "PUT",
    "PATCH",
    "DELETE",
#endif
    "CONNECT",
    "HEAD",
#ifdef LWS_WITH_HTTP2
    "COLON_PATH",
#endif
};

static BOOL
is_uri(enum lws_token_indexes ti) {
  for(size_t i = 0; i < countof(lwsjs_method_tokens); i++)
    if(lwsjs_method_tokens[i] == ti)
      return TRUE;

  return FALSE;
}

int
lwsjs_method_index(const char* method) {
  for(int i = 0; i < (int)countof(lwsjs_method_names); ++i)
    if(lwsjs_method_names[i])
      if(!strcasecmp(method, lwsjs_method_names[i]))
        return i;

  return -1;
}

const char*
lwsjs_method_name(int i) {
  if(i >= 0 && i < (int)countof(lwsjs_method_names))
    return lwsjs_method_names[i];

  return 0;
}

LWSSocket*
socket_dup(LWSSocket* s) {
  ++s->ref_count;
  return s;
}

LWSSocket*
socket_alloc(JSContext* ctx) {
  LWSSocket* sock;

  if(!(sock = js_mallocz(ctx, sizeof(LWSSocket))))
    return 0;

  /*if(socket_list.next == 0) init_list_head(&socket_list);*/

  assert(socket_list.next);
  assert(socket_list.prev);

  list_add(&sock->link, &socket_list);

  sock->ref_count = 1;
  sock->headers = JS_UNDEFINED;
  sock->write_handler = JS_UNDEFINED;
  sock->id = ++socket_id;
  sock->method = -1;

  return sock;
}

static LWSSocketType
socket_type(struct lws* wsi) {
  if(lwsi_role_ws(wsi))
    return SOCKET_WS;

  if(lwsi_role_h1(wsi))
    return SOCKET_HTTP;

  if(lwsi_role_h2(wsi))
    return SOCKET_HTTP;

  return SOCKET_OTHER;
}

int
socket_getid(struct lws* wsi) {
  LWSSocket* sock;

  if((sock = socket_get(wsi)))
    return sock->id;
  return -1;
}

static LWSSocket*
socket_find(struct lws* wsi) {
  struct list_head* n;

  list_for_each(n, &socket_list) {
    LWSSocket* sock = list_entry(n, LWSSocket, link);

    if(sock)
      if((uintptr_t)sock != (uintptr_t)-1 && sock->wsi == wsi)
        return sock;
  }

  return 0;
}

LWSSocket*
socket_get(struct lws* wsi) {
  JSObject* obj;

  if((obj = lws_get_opaque_user_data(wsi)))
    return lwsjs_socket_data(JS_MKPTR(JS_TAG_OBJECT, obj));

  return 0;
}

JSValue
js_socket_get(JSContext* ctx, struct lws* wsi) {
  JSObject* obj;

  if((obj = lws_get_opaque_user_data(wsi)))
    return JS_DupValue(ctx, JS_MKPTR(JS_TAG_OBJECT, obj));

  return JS_UNDEFINED;
}

static LWSSocket*
socket_get_by_id(int id) {
  struct list_head* n;
  LWSSocket* sock;

  list_for_each(n, &socket_list) {
    if((sock = list_entry(n, LWSSocket, link)))
      if(sock->id == id)
        return sock;
  }

  return 0;
}

static void
socket_free(LWSSocket* sock, JSRuntime* rt) {
  DEBUG("free LWSSocket: %p (ref_count = %d)", sock, sock->ref_count);
  if(--sock->ref_count == 0) {
    if(!JS_IsUndefined(sock->write_handler)) {
      JS_FreeValueRT(rt, sock->write_handler);
      sock->write_handler = JS_UNDEFINED;
    }

    JS_FreeValueRT(rt, sock->headers);
    sock->headers = JS_UNDEFINED;

    if(sock->uri) {
      js_free_rt(rt, sock->uri);
      sock->uri = 0;
    }
    if(sock->proto) {
      js_free_rt(rt, sock->proto);
      sock->proto = 0;
    }

    js_free_rt(rt, sock);
  }
}

static void
socket_delete(LWSSocket* sock, JSRuntime* rt) {
  assert(socket_list.next);
  assert(socket_list.prev);

  /*  assert(sock->link.next);
    assert(sock->link.prev);*/

  if(sock->link.next)
    list_del(&sock->link);

  DEBUG("delete LWSSocket: %p (wsi = %p, n = %d, ref_count = %d)", sock, sock->wsi, list_size(&socket_list), sock->ref_count);

  if(sock->obj) {
    obj_free(rt, sock->obj);
    sock->obj = 0;
  }

  socket_free(sock, rt);
}

static JSValue
socket_obj2(LWSSocket* sock, JSContext* ctx) {
  return sock ? JS_DupValue(ctx, ptr_obj(ctx, sock->obj)) : JS_NULL;
}

struct lws*
lwsjs_socket_wsi(JSValueConst value) {
  LWSSocket* sock;

  if((sock = lwsjs_socket_data(value)))
    return sock->wsi;

  return 0;
}

JSValue
lwsjs_socket_wrap(JSContext* ctx, LWSSocket* sock) {
  JSValue obj = JS_NewObjectProtoClass(ctx, lwsjs_socket_proto, lwsjs_socket_class_id);

  JS_SetOpaque(obj, socket_dup(sock));

  sock->obj = obj_ptr(ctx, obj);

  return obj;
}

JSValue
lwsjs_socket_create(JSContext* ctx, struct lws* wsi) {
  JSValue ret = JS_UNDEFINED;
  LWSSocket* sock;

  if((sock = socket_alloc(ctx))) {
    sock->wsi = wsi;
    ret = lwsjs_socket_wrap(ctx, sock);
  }

  return ret;
}

void
lwsjs_socket_destroy(JSContext* ctx, struct lws* wsi) {
  LWSSocket* sock = socket_get(wsi);

  /*if(sock == 0)
    return;*/

  assert(sock);

  assert(sock->wsi);
  sock->wsi = 0;

  socket_delete(sock, JS_GetRuntime(ctx));
}

JSValue
lwsjs_socket_get_or_create(JSContext* ctx, struct lws* wsi) {
  JSValue ret = js_socket_get(ctx, wsi);
  BOOL create;

  if((create = JS_IsUndefined(ret)))
    ret = lwsjs_socket_create(ctx, wsi);

  DEBUG("%s LWSSocket (wsi = %p, id = %d, ref_count = %d, obj = %p) = %p",
        create ? "create" : "get",
        wsi,
        lwsjs_socket_data(ret)->id,
        lwsjs_socket_data(ret)->ref_count,
        JS_VALUE_GET_OBJ(ret),
        lwsjs_socket_data(ret));

  return ret;
}

typedef struct {
  JSValue obj;
  JSContext* ctx;
  struct lws* wsi;
} CustomHeaders;

static void
custom_headers_callback(const char* name, int nlen, void* opaque) {
  CustomHeaders* ch = opaque;
  int namelen = nlen;
  int len = lws_hdr_custom_length(ch->wsi, name, nlen);

  if(namelen > 0 && name[namelen - 1] == ':')
    --namelen;

  JSAtom prop = JS_NewAtomLen(ch->ctx, name, namelen);
  char buf[len + 1];

  int r = lws_hdr_custom_copy(ch->wsi, buf, len + 1, name, nlen);

  JS_SetProperty(ch->ctx, ch->obj, prop, JS_NewStringLen(ch->ctx, buf, r));
  JS_FreeAtom(ch->ctx, prop);
}

JSValue
lwsjs_socket_headers(JSContext* ctx, struct lws* wsi, char** pproto) {
  JSValue ret = JS_NewObjectProto(ctx, JS_NULL);

  for(int i = WSI_TOKEN_GET_URI; i < WSI_TOKEN_COUNT; ++i) {
    if(!is_uri(i) && i != WSI_TOKEN_HTTP) {
      size_t len = lws_hdr_total_length(wsi, i);

      if(len > 0) {
        const char* name = (const char*)lws_token_to_string(i);

        if(name == NULL)
          continue;

        size_t namelen = find_charset(name, ": ", 2);
        JSAtom prop = JS_NewAtomLen(ctx, name, namelen);
        char buf[len + 1];
        int r = lws_hdr_copy(wsi, buf, len + 1, i);

        if(namelen == 0) {
          if(*pproto)
            js_free(ctx, *pproto);
          *pproto = js_strndup(ctx, buf, r);
        } else {
          JS_SetProperty(ctx, ret, prop, JS_NewStringLen(ctx, buf, r));
        }
        JS_FreeAtom(ctx, prop);
      }
    }
  }

  CustomHeaders c = {ret, ctx, wsi};

  lws_hdr_custom_name_foreach(wsi, custom_headers_callback, &c);

  return ret;
}

enum {
  METHOD_WANT_WRITE = 0,
  METHOD_WRITE,
  METHOD_RESPOND,
  METHOD_CLOSE,
  METHOD_HTTP_CLIENT_READ,
  METHOD_ADD_HEADER,
  METHOD_CLIENT_HTTP_MULTIPART,
};

static JSValue
lwsjs_socket_methods(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[], int magic) {
  LWSSocket* s;
  JSValue ret = JS_UNDEFINED;

  if(!(s = lwsjs_socket_data2(ctx, this_val)))
    return JS_EXCEPTION;

  if(!s->wsi)
    return JS_ThrowInternalError(ctx, "%s (magic=%d) s->wsi == NULL", __func__, magic);

  BOOL is_ws = lwsi_role_ws(s->wsi), is_http = lwsi_role_http(s->wsi);

  /*if(!is_http && (magic == METHOD_ADD_HEADER || magic == METHOD_HTTP_CLIENT_READ))
    return JS_ThrowInternalError(ctx, "%s (magic=%d) wsi is not HTTP", __func__, magic);*/

  switch(magic) {
    case METHOD_WANT_WRITE: {
      if(!s->want_write) {
        lws_callback_on_writable(s->wsi);

        s->want_write = TRUE;
        ret = JS_NewBool(ctx, TRUE);

        if(argc > 0) {
          JS_FreeValue(ctx, s->write_handler);
          s->write_handler = JS_DupValue(ctx, argv[0]);
        }
      }

      break;
    }

    case METHOD_WRITE: {
      DynBuf dbuf = {0};

      if(lws_partial_buffered(s->wsi)) {
        ret = JS_ThrowInternalError(ctx, "I/O error: partially buffered lws_write()");
        break;
      }

      /*if(!lws_send_pipe_choked(s->wsi)) {
        ret = JS_ThrowInternalError(ctx, "I/O error: send pipe choked lws_write()");
        break;
      }*/

      BOOL text = JS_IsString(argv[0]);
      size_t len;
      void* ptr = text ? (void*)JS_ToCStringLen(ctx, &len, argv[0]) : JS_GetArrayBuffer(ctx, &len, argv[0]);
      size_t n = len;
      enum lws_write_protocol proto = is_http ? LWS_WRITE_HTTP : text ? LWS_WRITE_TEXT : LWS_WRITE_BINARY;

      if(is_ws) {
        dbuf_init2(&dbuf, 0, 0);
        dbuf_put(&dbuf, (const void*)"XXXXXXXXXXXXXXXXXXXX", LWS_PRE);
        dbuf_put(&dbuf, ptr, n);
      }

      if(argc > 2)
        n = to_int32(ctx, argv[1]);

      if(argc > 1)
        proto = to_int32(ctx, argv[argc > 2 ? 2 : 1]);

      if(ptr) {
        int r = lws_write(s->wsi, is_ws ? dbuf.buf + LWS_PRE : ptr, MIN(n, len), proto);

        DEBUG_WSI(s->wsi, "wrote data (%d)", r);

        ret = JS_NewInt32(ctx, r);

        if(r > 0)
          if(proto == LWS_WRITE_HTTP_FINAL)
            if(lws_http_transaction_completed(s->wsi))
              s->completed = TRUE;

        DEBUG_WSI(s->wsi, "send pipe choked: %d partially buffered: %d", lws_send_pipe_choked(s->wsi), lws_partial_buffered(s->wsi));
      }

      if(JS_IsString(argv[0]))
        JS_FreeCString(ctx, ptr);

      if(dbuf.buf)
        free(dbuf.buf);

      break;
    }

    case METHOD_RESPOND: {
      uint8_t result[LWS_PRE + LWS_RECOMMENDED_MIN_HEADER_SPACE], *p = (uint8_t*)result + LWS_PRE, *start = p;
      uint8_t *end = p + sizeof(result) - LWS_PRE - 1, *ptr = NULL;
      size_t tmp_len, written = 0;
      int64_t len = -1;
      int32_t code = -1;
      int hidx = -1;

      for(int i = 0; i < argc; ++i) {
        if(code == -1 && JS_IsNumber(argv[i]))
          code = to_integer(ctx, argv[i]);
        else if(len == -1 && JS_IsNumber(argv[i]))
          len = to_integer(ctx, argv[i]);
        else if(!ptr && (ptr = JS_GetArrayBuffer(ctx, &tmp_len, argv[i])))
          len = len == -1 ? (int64_t)tmp_len : len;
        else if(!ptr && JS_IsString(argv[i]) && (ptr = (uint8_t*)JS_ToCStringLen(ctx, &tmp_len, argv[i])))
          len = len == -1 ? (int64_t)tmp_len : len;
        else if(JS_IsObject(argv[i]))
          hidx = i;
      }

      if(lws_add_http_common_headers(s->wsi, code, NULL, len > 0 ? (uint64_t)len : LWS_ILLEGAL_HTTP_CONTENT_LEN, &p, end)) {
        ret = JS_ThrowInternalError(ctx, "lws_add_http_common_headers failed");
        break;
      }

      if(hidx != -1) {
        JSPropertyEnum* tmp_tab = 0;
        uint32_t tmp_len;

        if(!JS_GetOwnPropertyNames(ctx, &tmp_tab, &tmp_len, argv[hidx], JS_GPN_STRING_MASK | JS_GPN_SET_ENUM)) {

          for(uint32_t j = 0; j < tmp_len; j++) {
            JSValue key = JS_AtomToValue(ctx, tmp_tab[j].atom);
            const char* name = JS_ToCString(ctx, key);
            JS_FreeValue(ctx, key);

            JSValue value = JS_GetProperty(ctx, argv[hidx], tmp_tab[j].atom);
            size_t vlen;
            const char* vstr = JS_ToCStringLen(ctx, &vlen, value);
            JS_FreeValue(ctx, value);

            if(lws_add_http_header_by_name(s->wsi, (const uint8_t*)name, (void*)vstr, vlen, &p, end))
              JS_ThrowInternalError(ctx, "lws_add_http_header_by_name");

            JS_FreeCString(ctx, name);
            JS_FreeCString(ctx, vstr);
          }
        }
      }

      int n = lws_finalize_write_http_header(s->wsi, start, &p, end) ? -1 : (int)lws_ptr_diff_size_t(p, start);

      DEBUG_WSI(s->wsi, "wrote headers (%d)", n);

      if(n < 0)
        return JS_ThrowInternalError(ctx, "lws_write");

      written += n;

      if(ptr && len > 0) {
        if((n = lws_write(s->wsi, (uint8_t*)ptr, (unsigned int)len, LWS_WRITE_HTTP_FINAL)) < 0)
          return JS_ThrowInternalError(ctx, "lws_write");

        written += n;
      }

      ret = JS_NewUint32(ctx, written);
      break;
    }

    case METHOD_CLOSE: {
      uint32_t reason = 1000;

      if(argc > 0)
        reason = to_uint32(ctx, argv[0]);

      if(socket_type(s->wsi) == SOCKET_WS) {
        size_t n = 0;
        uint8_t* p = NULL;
        const char* str = 0;

        if(argc > 1) {
          if(!(p = get_buffer(ctx, argc - 1, argv + 1, &n)))
            p = (uint8_t*)(str = JS_ToCStringLen(ctx, &n, argv[1]));
        }

        lws_close_reason(s->wsi, reason, p, n);

        if(str)
          JS_FreeCString(ctx, str);
      }

      lws_close_free_wsi(s->wsi, reason, __func__);
      // lws_wsi_close(s->wsi, LWS_TO_KILL_SYNC);
      break;
    }

    case METHOD_HTTP_CLIENT_READ: {
      size_t n;
      uint8_t *p, *q;
      int l, result;

      if((q = p = get_buffer(ctx, argc, argv, &n))) {
        l = n;
        result = lws_http_client_read(s->wsi, (char**)&p, &l);

        if(result != -1)
          ret = JS_NewInt32(ctx, l);
      }

      break;
    }

    case METHOD_ADD_HEADER: {
      const char *name = 0, *value;
      size_t vlen, blen;
      unsigned char *buf, *ptr;
      int64_t len = 0;
      enum lws_token_indexes token = -1;

      if(JS_IsNumber(argv[0])) {
        token = to_int32(ctx, argv[0]);
      } else if(!(name = JS_ToCString(ctx, argv[0]))) {
        ret = JS_ThrowTypeError(ctx, "argument 1 must be name");
        break;
      }

      if(!(value = JS_ToCStringLen(ctx, &vlen, argv[1]))) {
        ret = JS_ThrowTypeError(ctx, "argument 2 must be value");
        JS_FreeCString(ctx, name);
        break;
      }

      if(!(buf = JS_GetArrayBuffer(ctx, &blen, argv[2]))) {
        ret = JS_ThrowTypeError(ctx, "argument 3 must be ArrayBuffer");
        JS_FreeCString(ctx, name);
        JS_FreeCString(ctx, value);
        break;
      }

      len = to_int64(ctx, JS_GetPropertyUint32(ctx, argv[3], 0));
      len = MIN(MAX(0, len), (int64_t)blen);

      ptr = buf + len;

      int r = name ? lws_add_http_header_by_name(s->wsi, (const unsigned char*)name, (const unsigned char*)value, vlen, &ptr, buf + blen)
                   : lws_add_http_header_by_token(s->wsi, token, (const unsigned char*)value, vlen, &ptr, buf + blen);

      JS_SetPropertyUint32(ctx, argv[3], 0, JS_NewUint32(ctx, ptr - buf));

      ret = JS_NewInt32(ctx, r);

      JS_FreeCString(ctx, name);
      JS_FreeCString(ctx, value);
      break;
    }

    case METHOD_CLIENT_HTTP_MULTIPART: {

      if(!s->wsi->http.multipart)
        break;

      struct lws_process_html_args a = {0}, b, c;
      const char *name = 0, *filename = 0, *content_type = 0;
      int i = 0;

      if(argc > 0 && !is_nullish(argv[0]))
        name = JS_ToCString(ctx, argv[0]);
      if(argc > 1 && !is_nullish(argv[1]))
        filename = JS_ToCString(ctx, argv[1]);
      if(argc > 2 && !is_nullish(argv[2]))
        content_type = JS_ToCString(ctx, argv[2]);
      if(argc > 3)
        i = lwsjs_html_process_args(ctx, &a, argc - 3, argv + 3);

      b = a;

      b.p += b.len;
      b.max_len -= b.len;

      c = b;

      if(lws_client_http_multipart(s->wsi, name, filename, content_type, &b.p, b.p + b.max_len)) {
        ret = JS_ThrowRangeError(ctx, "lws_client_http_multipart: does not fit into buffer of len %d", a.max_len);
      } else {
        ptrdiff_t n = b.p - c.p;

        a.len += n;

        if(argc > 4 && JS_IsObject(argv[4]))
          JS_SetPropertyUint32(ctx, argv[4], 0, JS_NewUint32(ctx, a.len));

        ret = JS_NewUint32(ctx, n);
      }

      if(name)
        JS_FreeCString(ctx, name);
      if(filename)
        JS_FreeCString(ctx, filename);
      if(content_type)
        JS_FreeCString(ctx, content_type);

      break;
    }
  }

  return ret;
}

enum {
  FUNCTION_LIST,
  FUNCTION_GET,
};

static JSValue
lwsjs_socket_functions(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[], int magic) {
  JSValue ret = JS_UNDEFINED;

  switch(magic) {
    case FUNCTION_LIST: {
      if(socket_list.next != 0) {
        uint32_t i = 0;
        struct list_head* el;

        ret = JS_NewArray(ctx);

        list_for_each(el, &socket_list) {
          LWSSocket* sock = list_entry(el, LWSSocket, link);

          if(sock == (LWSSocket*)(uintptr_t)(intptr_t)-1)
            continue;

          JS_SetPropertyUint32(ctx, ret, i++, socket_obj2(sock, ctx));
        }
      }

      break;
    }

    case FUNCTION_GET: {
      ret = socket_obj2(socket_get_by_id(to_int32(ctx, argv[0])), ctx);
      break;
    }
  }

  return ret;
}

enum {
  PROP_VHOST,
  PROP_HEADERS,
  PROP_ID,
  PROP_CLIENT,
  PROP_RESPONSE_CODE,
  PROP_FD,
  PROP_METHOD,
  PROP_URI,
  PROP_BODY_PENDING,
  PROP_REDIRECTED_TO_GET,
  PROP_PROTOCOL,
  PROP_TAG,
  PROP_TLS,
  PROP_PEER,
  PROP_LOCAL,
  PROP_CONTEXT,
  PROP_PEER_WRITE_ALLOWANCE,
  PROP_PARENT,
  PROP_CHILD,
  PROP_NETWORK,
  PROP_EXTENSIONS,
};

static JSValue
lwsjs_socket_set(JSContext* ctx, JSValueConst this_val, JSValueConst value, int magic) {
  LWSSocket* s;
  JSValue ret = JS_UNDEFINED;

  if(!(s = lwsjs_socket_data2(ctx, this_val)))
    return JS_EXCEPTION;

  if(!s->wsi)
    return JS_UNINITIALIZED;

  switch(magic) {
    case PROP_BODY_PENDING: {
      lws_client_http_body_pending(s->wsi, (s->body_pending = to_int32(ctx, value)));
      break;
    }
  }

  return ret;
}

static JSValue
lwsjs_socket_get(JSContext* ctx, JSValueConst this_val, int magic) {
  LWSSocket* s;
  JSValue ret = JS_UNDEFINED;

  if(!(s = lwsjs_socket_data2(ctx, this_val)))
    return JS_EXCEPTION;

  if(!s->wsi && magic > PROP_PROTOCOL)
    return JS_UNINITIALIZED;

  switch(magic) {
    case PROP_VHOST: {
      struct lws_vhost* vho;

      if((vho = lws_get_vhost(s->wsi)))
        ret = lws_vhost_object(ctx, vho);

      break;
    }
    case PROP_HEADERS: {
      ret = JS_DupValue(ctx, s->headers);
      break;
    }

    case PROP_ID: {
      ret = JS_NewUint32(ctx, s->id);
      break;
    }

    case PROP_CLIENT: {
      ret = JS_NewBool(ctx, s->client);
      break;
    }

    case PROP_RESPONSE_CODE: {
      if(s->response_code != 0)
        ret = JS_NewInt32(ctx, s->response_code);

      break;
    }

    case PROP_FD: {
      int32_t fd = s->wsi ? (int32_t)lws_get_socket_fd(s->wsi) : -1;
      ret = JS_NewInt32(ctx, fd);
      break;
    }

    case PROP_METHOD: {
      const char* method;

      if((method = lwsjs_method_name(s->method)))
        ret = JS_NewString(ctx, method);

      break;
    }

    case PROP_URI: {
      ret = s->uri ? JS_NewString(ctx, s->uri) : JS_NULL;
      break;
    }

    case PROP_BODY_PENDING: {
      ret = JS_NewInt32(ctx, s->body_pending);
      break;
    }

    case PROP_REDIRECTED_TO_GET: {
      ret = JS_NewBool(ctx, s->redirected_to_get);
      break;
    }

    case PROP_PROTOCOL: {
      ret = s->proto ? JS_NewString(ctx, s->proto) : JS_NULL;
      break;
    }

    case PROP_TAG: {
      const char* tag;

      if((tag = lws_wsi_tag(s->wsi)))
        ret = JS_NewString(ctx, tag);

      break;
    }

    case PROP_TLS: {
      ret = JS_NewBool(ctx, lws_is_ssl(s->wsi));
      break;
    }

    case PROP_PEER: {
      lws_sockfd_type fd = lws_get_socket_fd(s->wsi);

      if(fd == -1) {
        ret = JS_NULL;
        break;
      }

      ret = lwsjs_sockaddr46_new(ctx);
      lws_sockaddr46* sa = lwsjs_sockaddr46_data(ctx, ret);
      socklen_t len = sizeof(*sa);

      if(getpeername(fd, (struct sockaddr*)sa, &len) == -1) {
        JS_FreeValue(ctx, ret);
        if(errno == EBADF)
          ret = JS_NULL;
        else
          ret = JS_ThrowInternalError(ctx, "geetpeername(%d) returned -1: %s", fd, strerror(errno));
      }

      break;
    }

    case PROP_LOCAL: {
      lws_sockfd_type fd = lws_get_socket_fd(s->wsi);

      if(fd == -1) {
        ret = JS_NULL;
        break;
      }

      ret = lwsjs_sockaddr46_new(ctx);
      lws_sockaddr46* sa = lwsjs_sockaddr46_data(ctx, ret);
      socklen_t len = sizeof(*sa);

      if(getsockname(fd, (struct sockaddr*)sa, &len) == -1) {
        JS_FreeValue(ctx, ret);
        if(errno == EBADF)
          ret = JS_NULL;
        else
          ret = JS_ThrowInternalError(ctx, "getsockname(%d) returned -1: %s", fd, strerror(errno));
      }

      break;
    }

    case PROP_CONTEXT: {
      struct lws_context* lws;

      if((lws = lws_get_context(s->wsi)))
        ret = ptr_obj(ctx, lws_context_user(lws));

      break;
    }

    case PROP_PEER_WRITE_ALLOWANCE: {
      ret = JS_NewInt32(ctx, lws_get_peer_write_allowance(s->wsi));
      break;
    }

    case PROP_PARENT: {
      struct lws* wsi = lws_get_parent(s->wsi);

      if(wsi)
        ret = wsi == s->wsi ? JS_DupValue(ctx, this_val) : lwsjs_socket_get_or_create(ctx, wsi);

      break;
    }

    case PROP_CHILD: {
      struct lws* wsi = lws_get_child(s->wsi);

      if(wsi)
        ret = wsi == s->wsi ? JS_DupValue(ctx, this_val) : lwsjs_socket_get_or_create(ctx, wsi);

      break;
    }

    case PROP_NETWORK: {
      struct lws* wsi = lws_get_network_wsi(s->wsi);

      if(wsi)
        ret = wsi == s->wsi ? JS_DupValue(ctx, this_val) : lwsjs_socket_get_or_create(ctx, wsi);

      break;
    }

    case PROP_EXTENSIONS: {
      LWSContext* lc;

      if((lc = lwsjs_socket_context(s->wsi)) && lc->info.extensions) {
        ret = JS_NewArray(ctx);

        for(int i = 0; lc->info.extensions[i].name; i++)
          JS_SetPropertyUint32(ctx, ret, i, JS_NewString(ctx, lc->info.extensions[i].name));
      }

      break;
    }
  }

  return ret;
}

static void
lwsjs_socket_finalizer(JSRuntime* rt, JSValue val) {
  LWSSocket* s;

  if((s = lwsjs_socket_data(val)))
    socket_free(s, rt);
}

static const JSClassDef lws_socket_class = {
    "LWSSocket",
    .finalizer = lwsjs_socket_finalizer,
};

static const JSCFunctionListEntry lws_socket_proto_funcs[] = {
    JS_CFUNC_MAGIC_DEF("wantWrite", 0, lwsjs_socket_methods, METHOD_WANT_WRITE),
    JS_CFUNC_MAGIC_DEF("write", 1, lwsjs_socket_methods, METHOD_WRITE),
    JS_CFUNC_MAGIC_DEF("respond", 1, lwsjs_socket_methods, METHOD_RESPOND),
    JS_CFUNC_MAGIC_DEF("close", 0, lwsjs_socket_methods, METHOD_CLOSE),
    JS_CFUNC_MAGIC_DEF("httpClientRead", 1, lwsjs_socket_methods, METHOD_HTTP_CLIENT_READ),
    JS_CFUNC_MAGIC_DEF("addHeader", 4, lwsjs_socket_methods, METHOD_ADD_HEADER),
    JS_CFUNC_MAGIC_DEF("clientHttpMultipart", 4, lwsjs_socket_methods, METHOD_CLIENT_HTTP_MULTIPART),
    JS_CGETSET_MAGIC_FLAGS_DEF("id", lwsjs_socket_get, 0, PROP_ID, JS_PROP_ENUMERABLE),
    JS_CGETSET_MAGIC_FLAGS_DEF("tag", lwsjs_socket_get, 0, PROP_TAG, JS_PROP_CONFIGURABLE),
    JS_CGETSET_MAGIC_DEF("vhost", lwsjs_socket_get, 0, PROP_VHOST),
    JS_CGETSET_MAGIC_DEF("headers", lwsjs_socket_get, 0, PROP_HEADERS),
    JS_CGETSET_MAGIC_DEF("tls", lwsjs_socket_get, 0, PROP_TLS),
    JS_CGETSET_MAGIC_DEF("peer", lwsjs_socket_get, 0, PROP_PEER),
    JS_CGETSET_MAGIC_DEF("local", lwsjs_socket_get, 0, PROP_LOCAL),
    JS_CGETSET_MAGIC_DEF("fd", lwsjs_socket_get, 0, PROP_FD),
    JS_CGETSET_MAGIC_DEF("parent", lwsjs_socket_get, 0, PROP_PARENT),
    JS_CGETSET_MAGIC_DEF("child", lwsjs_socket_get, 0, PROP_CHILD),
    JS_CGETSET_MAGIC_DEF("network", lwsjs_socket_get, 0, PROP_NETWORK),
    JS_CGETSET_MAGIC_DEF("context", lwsjs_socket_get, 0, PROP_CONTEXT),
    JS_CGETSET_MAGIC_DEF("peerWriteAllowance", lwsjs_socket_get, 0, PROP_PEER_WRITE_ALLOWANCE),
    JS_CGETSET_MAGIC_DEF("protocol", lwsjs_socket_get, 0, PROP_PROTOCOL),
    JS_CGETSET_MAGIC_DEF("method", lwsjs_socket_get, 0, PROP_METHOD),
    JS_CGETSET_MAGIC_DEF("uri", lwsjs_socket_get, 0, PROP_URI),
    JS_CGETSET_MAGIC_DEF("client", lwsjs_socket_get, 0, PROP_CLIENT),
    JS_CGETSET_MAGIC_DEF("response", lwsjs_socket_get, 0, PROP_RESPONSE_CODE),
    JS_CGETSET_MAGIC_DEF("bodyPending", lwsjs_socket_get, lwsjs_socket_set, PROP_BODY_PENDING),
    JS_CGETSET_MAGIC_DEF("redirectedToGet", lwsjs_socket_get, 0, PROP_REDIRECTED_TO_GET),
    JS_CGETSET_MAGIC_DEF("extensions", lwsjs_socket_get, 0, PROP_EXTENSIONS),
    JS_PROP_STRING_DEF("[Symbol.toStringTag]", "LWSSocket", JS_PROP_CONFIGURABLE),
};

static const JSCFunctionListEntry lws_socket_static_funcs[] = {
    JS_CFUNC_MAGIC_DEF("list", 0, lwsjs_socket_functions, FUNCTION_LIST),
    JS_CFUNC_MAGIC_DEF("get", 1, lwsjs_socket_functions, FUNCTION_GET),
};

int
lwsjs_socket_init(JSContext* ctx, JSModuleDef* m) {
  init_list_head(&socket_list);

  JS_NewClassID(&lwsjs_socket_class_id);
  JS_NewClass(JS_GetRuntime(ctx), lwsjs_socket_class_id, &lws_socket_class);
  lwsjs_socket_proto = JS_NewObjectProto(ctx, JS_NULL);
  JS_SetPropertyFunctionList(ctx, lwsjs_socket_proto, lws_socket_proto_funcs, countof(lws_socket_proto_funcs));

  lwsjs_socket_ctor = JS_NewObjectProto(ctx, JS_NULL);
  JS_SetPropertyFunctionList(ctx, lwsjs_socket_ctor, lws_socket_static_funcs, countof(lws_socket_static_funcs));
  JS_SetConstructor(ctx, lwsjs_socket_ctor, lwsjs_socket_proto);

  if(m) {
    JS_SetModuleExport(ctx, m, "LWSSocket", lwsjs_socket_ctor);
  }

  return 0;
}
