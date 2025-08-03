#include "lws-socket.h"
#include "lws-context.h"
#include "lws.h"
#include <assert.h>

#include "libwebsockets/lib/core/private-lib-core.h"
//#include "libwebsockets/lib/roles/private-lib-roles.h"

JSClassID lwsjs_socket_class_id;
static JSValue lwsjs_socket_proto, lwsjs_socket_ctor;

static struct list_head socket_list;
static uint32_t socket_id;

static const enum lws_token_indexes method_tokens[] = {
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

static const char* const method_names[] = {
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
  for(size_t i = 0; i < countof(method_tokens); i++)
    if(method_tokens[i] == ti)
      return TRUE;

  return FALSE;
}

int
method_index(const char* method) {
  for(int i = 0; i < countof(method_names); ++i)
    if(method_names[i])
      if(!strcasecmp(method, method_names[i]))
        return i;

  return -1;
}

static const char*
socket_method(LWSSocket* sock) {
  if(!sock->client) {
    char* uri_ptr;
    int method, uri_len;

    method = lws_http_get_uri_and_method(sock->wsi, &uri_ptr, &uri_len);

    if(method >= 0 && method < (int)countof(method_names))
      return method_names[method];
  }

  for(size_t i = 0; i < countof(method_tokens); i++) {
    enum lws_token_indexes tok = method_tokens[i];

    if(lws_hdr_total_length(sock->wsi, tok))
      return method_names[i];
  }

  return 0;
}

static LWSSocket*
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

  return sock;
}

static LWSSocket*
socket_dup(LWSSocket* s) {
  ++s->ref_count;
  return s;
}

LWSSocketType
socket_type(struct lws* wsi) {
  if(lwsi_role_ws(wsi))
    return SOCKET_WS;

  if(lwsi_role_h1(wsi))
    return SOCKET_HTTP;

  if(lwsi_role_h2(wsi))
    return SOCKET_HTTP;

  return SOCKET_OTHER;
}

LWSSocket*
socket_get(struct lws* wsi) {
  struct list_head* n;
  LWSSocket* sock;

  if(wsi == 0)
    return 0;

  /*if(socket_list.next == 0) init_list_head(&socket_list);*/

  assert(socket_list.next);
  assert(socket_list.prev);

  list_for_each(n, &socket_list) {
    if((sock = list_entry(n, LWSSocket, link)))
      if(sock->wsi == wsi)
        return sock;
  }

  return 0;
}

static LWSSocket*
socket_get_by_fd(lws_sockfd_type fd) {
  struct list_head* n;

  /* if(socket_list.next == 0) init_list_head(&socket_list);*/

  assert(socket_list.next);
  assert(socket_list.prev);

  list_for_each(n, &socket_list) {
    LWSSocket* sock = list_entry(n, LWSSocket, link);
    lws_sockfd_type fd2 = sock->wsi ? lws_get_socket_fd(sock->wsi) : -1;

    if(fd2 != -1 && fd == fd2)
      return sock;
  }

  return 0;
}

static void
socket_free(LWSSocket* sock, JSRuntime* rt) {
  DEBUG("free LWSSocket: %p (ref = %d)", sock, sock->ref_count);

  if(--sock->ref_count == 0) {
    if(!JS_IsUndefined(sock->write_handler)) {
      JS_FreeValueRT(rt, sock->write_handler);
      sock->write_handler = JS_UNDEFINED;
    }

    JS_FreeValueRT(rt, sock->headers);
    sock->headers = JS_UNDEFINED;

    js_free_rt(rt, sock);
  }
}

static void
socket_delete(LWSSocket* sock, JSRuntime* rt) {
  assert(socket_list.next);
  assert(socket_list.prev);

  assert(sock->link.next);
  assert(sock->link.prev);

  list_del(&sock->link);

  DEBUG("delete LWSSocket: %p (wsi = %p, n = %d, ref = %d)", sock, sock->wsi, list_size(&socket_list), sock->ref_count);

  if(sock->obj) {
    obj_free(rt, sock->obj);
    sock->obj = 0;
  }

  if(sock->wsi) {
    lws_set_opaque_user_data(sock->wsi, 0);
    sock->wsi = 0;
  }

  socket_free(sock, rt);
}

static inline JSValue
socket_obj(LWSSocket* sock) {
  return sock ? JS_MKPTR(JS_TAG_OBJECT, sock->obj) : JS_NULL;
}

static inline JSValue
socket_js(LWSSocket* sock, JSContext* ctx) {
  return sock ? JS_DupValue(ctx, socket_obj(sock)) : JS_NULL;
}

LWSSocket*
lwsjs_socket_new(JSContext* ctx, struct lws* wsi) {
  LWSSocket* sock;

  if(!wsi)
    return 0;

  if(!(sock = socket_get(wsi)) || sock == (void*)-1) {
    sock = socket_alloc(ctx);
    sock->wsi = wsi;
    DEBUG("new LWSSocket: %p (wsi = %p, n = %d)", sock, wsi, list_size(&socket_list));
  } else {
    assert(sock->wsi == wsi);
    DEBUG("recycled LWSSocket: %p (wsi = %p, n = %d)", sock, wsi, list_size(&socket_list));
  }

  lws_set_opaque_user_data(wsi, sock);
  return sock;
}

JSValue
lwsjs_socket_wrap(JSContext* ctx, struct lws* wsi) {
  LWSSocket* sock = lwsjs_socket_new(ctx, wsi);
  JSValue obj;

  if(sock->obj) {
    obj = socket_js(sock, ctx);
  } else {
    obj = JS_NewObjectProtoClass(ctx, lwsjs_socket_proto, lwsjs_socket_class_id);

    JS_SetOpaque(obj, socket_dup(sock));

    sock->obj = obj_ptr(ctx, obj);
  }

  return obj;
}

JSValue
lwsjs_socket_get_or_create(JSContext* ctx, struct lws* wsi) {
  LWSSocket* sock;

  if((sock = socket_get(wsi)))
    return socket_js(sock, ctx);

  DEBUG("get or create LWSSocket (wsi = %p)", wsi);

  return lwsjs_socket_wrap(ctx, wsi);
}

JSValue
lwsjs_socket_get_by_fd(JSContext* ctx, lws_sockfd_type fd) {
  LWSSocket* sock;

  if((sock = socket_get_by_fd(fd)))
    return socket_js(sock, ctx);

  return JS_NULL;
}

void
lwsjs_socket_destroy(JSContext* ctx, struct lws* wsi) {
  LWSSocket* sock = socket_get(wsi);

  if(sock == 0)
    return;

  assert(sock);
  assert(sock->link.next);
  /*  JSValue obj = socket_obj(sock);
    JS_SetOpaque(obj, 0);
    JS_FreeValue(ctx, obj);
    sock->obj = 0;*/

  socket_delete(sock, JS_GetRuntime(ctx));
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
lwsjs_socket_headers(JSContext* ctx, struct lws* wsi) {
  JSValue ret = JS_NewObjectProto(ctx, JS_NULL);

  for(int i = WSI_TOKEN_GET_URI; i < WSI_TOKEN_COUNT; ++i) {
    if(!is_uri(i) && i != WSI_TOKEN_HTTP) {
      size_t len = lws_hdr_total_length(wsi, i);

      if(len > 0) {
        const char* name = (const char*)lws_token_to_string(i);

        if(name == NULL)
          continue;

        size_t namelen = find_charset(name, ": ", 2);
        // JSAtom prop = JS_NewAtomUInt32(ctx, i);
        JSAtom prop = JS_NewAtomLen(ctx, name, namelen);
        char buf[len + 1];
        int r = lws_hdr_copy(wsi, buf, len + 1, i);

        JS_SetProperty(ctx, ret, prop, JS_NewStringLen(ctx, buf, r));
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

  if(!is_http && (magic == METHOD_ADD_HEADER || magic == METHOD_HTTP_CLIENT_READ))
    return JS_ThrowInternalError(ctx, "%s (magic=%d) wsi is not HTTP", __func__, magic);

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

        printf("send pipe choked: %d partially buffered: %d\n", lws_send_pipe_choked(s->wsi), lws_partial_buffered(s->wsi));
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

      lws_add_http_common_headers(s->wsi, code, NULL, len > 0 ? (uint64_t)len : LWS_ILLEGAL_HTTP_CONTENT_LEN, &p, end);

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
  }

  return ret;
}

enum {
  FUNCTION_GET = 0,
  FUNCTION_LIST,
};

static JSValue
lwsjs_socket_functions(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[], int magic) {
  JSValue ret = JS_UNDEFINED;

  switch(magic) {
    case FUNCTION_GET: {
      ret = lwsjs_socket_get_by_fd(ctx, to_int32(ctx, argv[0]));
      break;
    }

    case FUNCTION_LIST: {
      if(socket_list.next != 0) {
        uint32_t i = 0;
        struct list_head* el;

        ret = JS_NewArray(ctx);

        list_for_each(el, &socket_list) {
          LWSSocket* sock = list_entry(el, LWSSocket, link);

          if(sock == (LWSSocket*)(uintptr_t)(intptr_t)-1)
            continue;

          JS_SetPropertyUint32(ctx, ret, i++, socket_js(sock, ctx));
        }
      }

      break;
    }
  }

  return ret;
}

enum {
  PROP_HEADERS = 0,
  PROP_ID,
  PROP_CLIENT,
  PROP_RESPONSE_CODE,
  PROP_TAG,
  PROP_TLS,
  PROP_PEER,
  PROP_FD,
  PROP_CONTEXT,
  PROP_PEER_WRITE_ALLOWANCE,
  PROP_PARENT,
  PROP_CHILD,
  PROP_NETWORK,
  PROP_PROTOCOL,
  PROP_METHOD,
  PROP_URI,
  PROP_BODY_PENDING,
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

  if(!s->wsi && magic > PROP_RESPONSE_CODE)
    return JS_UNINITIALIZED;

  switch(magic) {
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
      if(s->client && s->response_code > 0)
        ret = JS_NewInt32(ctx, s->response_code);

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
      char buf[256];
      lws_get_peer_simple(s->wsi, buf, sizeof(buf));
      ret = JS_NewString(ctx, buf);
      break;
    }

    case PROP_FD: {
      lws_sockfd_type fd = s->wsi ? lws_get_socket_fd(s->wsi) : -1;
      ret = JS_NewInt32(ctx, fd);
      break;
    }

    case PROP_CONTEXT: {
      struct lws_context* lws;

      if((lws = lws_get_context(s->wsi))) {
        JSObject* obj = lws_context_user(lws);

        ret = ptr_obj(ctx, obj);
      }

      break;
    }

    case PROP_PEER_WRITE_ALLOWANCE: {
      ret = JS_NewInt32(ctx, lws_get_peer_write_allowance(s->wsi));
      break;
    }

    case PROP_PARENT: {
      struct lws* wsi = lws_get_parent(s->wsi);

      if(wsi)
        ret = wsi == s->wsi ? JS_DupValue(ctx, this_val) : lwsjs_socket_wrap(ctx, wsi);

      break;
    }

    case PROP_CHILD: {
      struct lws* wsi = lws_get_child(s->wsi);

      if(wsi)
        ret = wsi == s->wsi ? JS_DupValue(ctx, this_val) : lwsjs_socket_wrap(ctx, wsi);

      break;
    }

    case PROP_NETWORK: {
      struct lws* wsi = lws_get_network_wsi(s->wsi);

      if(wsi)
        ret = wsi == s->wsi ? JS_DupValue(ctx, this_val) : lwsjs_socket_wrap(ctx, wsi);

      break;
    }

    case PROP_PROTOCOL: {
      const struct lws_protocols* p;

      if((p = lws_get_protocol(s->wsi))) {
        LWSProtocol* lwsp;

        if((lwsp = p->user))
          if(lwsp->obj)
            ret = ptr_obj(ctx, lwsp->obj);
      }

      break;
    }

    case PROP_METHOD: {
      const char* method;

      if((method = socket_method(s)))
        ret = JS_NewString(ctx, method);

      break;
    }

    case PROP_URI: {
      char* uri_ptr = 0;
      int uri_len = 0;

      lws_http_get_uri_and_method(s->wsi, &uri_ptr, &uri_len);

      ret = JS_NewStringLen(ctx, uri_ptr, uri_len);
      break;
    }

    case PROP_BODY_PENDING: {
      ret = JS_NewInt32(ctx, s->body_pending);
      break;
    }
  }

  return ret;
}

static void
lwsjs_socket_finalizer(JSRuntime* rt, JSValue val) {
  LWSSocket* s;

  if((s = lwsjs_socket_data(val))) {

    socket_free(s, rt);
  }
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
    JS_CGETSET_MAGIC_FLAGS_DEF("id", lwsjs_socket_get, 0, PROP_ID, JS_PROP_ENUMERABLE),
    JS_CGETSET_MAGIC_FLAGS_DEF("tag", lwsjs_socket_get, 0, PROP_TAG, JS_PROP_CONFIGURABLE),
    JS_CGETSET_MAGIC_DEF("headers", lwsjs_socket_get, 0, PROP_HEADERS),
    JS_CGETSET_MAGIC_DEF("tls", lwsjs_socket_get, 0, PROP_TLS),
    JS_CGETSET_MAGIC_DEF("peer", lwsjs_socket_get, 0, PROP_PEER),
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
    JS_PROP_STRING_DEF("[Symbol.toStringTag]", "LWSSocket", JS_PROP_CONFIGURABLE),
};

static const JSCFunctionListEntry lws_socket_static_funcs[] = {
    JS_CFUNC_MAGIC_DEF("get", 1, lwsjs_socket_functions, FUNCTION_GET),
    JS_CFUNC_MAGIC_DEF("list", 0, lwsjs_socket_functions, FUNCTION_LIST),
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
