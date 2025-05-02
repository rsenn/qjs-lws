#include "lws-socket.h"
#include "lws-context.h"
#include "lws.h"
#include <assert.h>

JSClassID lws_socket_class_id;
static JSValue lws_socket_proto, lws_socket_ctor;

static struct list_head socket_list;
static uint32_t socket_id;

static LWSSocket*
socket_alloc(JSContext* ctx) {
  LWSSocket* sock;

  if(!(sock = js_mallocz(ctx, sizeof(LWSSocket))))
    return 0;

  /*if(socket_list.next == 0) init_list_head(&socket_list);*/

  assert(socket_list.next);
  assert(socket_list.prev);

  list_add(&sock->link, &socket_list);

  sock->headers = JS_UNDEFINED;
  sock->write_handler = JS_UNDEFINED;
  sock->id = ++socket_id;

  return sock;
}

static LWSSocket*
socket_get(struct lws* wsi) {
  struct list_head* n;
  LWSSocket* sock;

  /*if(socket_list.next == 0) init_list_head(&socket_list);*/

  assert(socket_list.next);
  assert(socket_list.prev);

  if((sock = lws_get_opaque_user_data(wsi)))
    return sock;

  list_for_each(n, &socket_list) {
    if((sock = list_entry(n, LWSSocket, link)))
      if(sock->wsi == wsi)
        return sock;
  }

  return 0;
}

LWSSocket*
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
socket_delete(LWSSocket* sock) {
  assert(socket_list.next);
  assert(socket_list.prev);

  list_del(&sock->link);

  if(sock->wsi) {
    lws_set_opaque_user_data(sock->wsi, 0);
    sock->wsi = 0;
  }
}

static inline JSValue
socket_obj(LWSSocket* sock) {
  return sock ? JS_MKPTR(JS_TAG_OBJECT, sock->obj) : JS_NULL;
}

void
socket_destroy(struct lws* wsi, JSContext* ctx) {
  LWSSocket* sock = socket_get(wsi);

  assert(sock);
  assert(sock->link.next);
  JSValue obj = socket_obj(sock);
  JS_SetOpaque(obj, 0);
  JS_FreeValue(ctx, obj);
  sock->obj = 0;

  if(!JS_IsUndefined(sock->write_handler)) {
    JS_FreeValue(ctx, sock->write_handler);
    sock->write_handler = JS_UNDEFINED;
  }

  socket_delete(sock);
}

static inline JSValue
socket_js(LWSSocket* sock, JSContext* ctx) {
  return sock ? JS_DupValue(ctx, socket_obj(sock)) : JS_NULL;
}

LWSSocket*
socket_new(JSContext* ctx, struct lws* wsi) {
  LWSSocket* sock;

  if(!wsi)
    return 0;

  if(!(sock = socket_get(wsi))) {
    sock = socket_alloc(ctx);
    sock->wsi = wsi;
    lws_set_opaque_user_data(wsi, sock);
  }

  return sock;
}

JSValue
js_socket_wrap(JSContext* ctx, struct lws* wsi) {
  LWSSocket* sock = socket_new(ctx, wsi);
  JSValue obj;

  if(sock->obj) {
    obj = JS_DupValue(ctx, JS_MKPTR(JS_TAG_OBJECT, sock->obj));
  } else {
    obj = JS_NewObjectProtoClass(ctx, lws_socket_proto, lws_socket_class_id);

    JS_SetOpaque(obj, sock);

    sock->obj = JS_VALUE_GET_OBJ(JS_DupValue(ctx, obj));
  }

  return obj;
}

JSValue
js_socket_get_or_create(JSContext* ctx, struct lws* wsi) {
  LWSSocket* sock;

  if((sock = socket_get(wsi)))
    return socket_js(sock, ctx);

  return js_socket_wrap(ctx, wsi);
}

JSValue
js_socket_get_by_fd(JSContext* ctx, lws_sockfd_type fd) {
  LWSSocket* sock;

  if((sock = socket_get_by_fd(fd)))
    return socket_js(sock, ctx);

  return JS_NULL;
}

typedef struct {
  JSObject* obj;
  JSContext* ctx;
  struct lws* wsi;
} LWSCustomHeaders;

static void
custom_headers_callback(const char* name, int nlen, void* opaque) {
  LWSCustomHeaders* c = opaque;
  JSValue obj = JS_MKPTR(JS_TAG_OBJECT, c->obj);
  int namelen = nlen;
  int len = lws_hdr_custom_length(c->wsi, name, nlen);
  if(namelen > 0 && name[namelen - 1] == ':')
    --namelen;
  JSAtom prop = JS_NewAtomLen(c->ctx, name, namelen);
  char buf[len + 1];

  int r = lws_hdr_custom_copy(c->wsi, buf, len + 1, name, nlen);

  JS_SetProperty(c->ctx, obj, prop, JS_NewStringLen(c->ctx, buf, r));
  JS_FreeAtom(c->ctx, prop);
}

JSValue
js_socket_headers(JSContext* ctx, struct lws* wsi) {
  JSValue ret = JS_NewObjectProto(ctx, JS_NULL);

  for(int i = WSI_TOKEN_GET_URI; i < WSI_INIT_TOKEN_MUXURL; ++i) {
    size_t len = lws_hdr_total_length(wsi, i);

    if(len > 0) {
      const char* name = (const char*)lws_token_to_string(i);
      size_t namelen = str_chrs(name, ": ", 2);
      JSAtom prop = JS_NewAtomLen(ctx, name, namelen);
      char buf[len + 1];

      int r = lws_hdr_copy(wsi, buf, len + 1, i);

      JS_SetProperty(ctx, ret, prop, JS_NewStringLen(ctx, buf, r));
      JS_FreeAtom(ctx, prop);
    }
  }

  LWSCustomHeaders c = {JS_VALUE_GET_OBJ(ret), ctx, wsi};

  lws_hdr_custom_name_foreach(wsi, custom_headers_callback, &c);

  return ret;
}

enum {
  METHOD_WANT_WRITE = 0,
  METHOD_WRITE,
  METHOD_RESPOND,
  METHOD_HTTP_CLIENT_READ,
};

static JSValue
lws_socket_methods(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[], int magic) {
  LWSSocket* s;
  JSValue ret = JS_UNDEFINED;

  if(!(s = JS_GetOpaque2(ctx, this_val, lws_socket_class_id)))
    return JS_EXCEPTION;

  switch(magic) {
    case METHOD_WANT_WRITE: {
      if(!s->want_write) {
        lws_callback_on_writable(s->wsi);

        s->want_write = TRUE;
        ret = JS_NewBool(ctx, TRUE);

        if(argc > 0) {
          if(!JS_IsUndefined(s->write_handler))
            JS_FreeValue(ctx, s->write_handler);

          s->write_handler = JS_DupValue(ctx, argv[0]);
        }
      }

      break;
    }

    case METHOD_WRITE: {
      size_t len;
      void* ptr = JS_IsString(argv[0]) ? (void*)JS_ToCStringLen(ctx, &len, argv[0]) : JS_GetArrayBuffer(ctx, &len, argv[0]);
      int32_t n = len, proto = LWS_WRITE_HTTP;

      if(argc > 2)
        JS_ToInt32(ctx, &n, argv[1]);

      if(argc > 1)
        JS_ToInt32(ctx, &proto, argv[argc > 2 ? 2 : 1]);

      if(ptr) {
        int r = lws_write(s->wsi, ptr, MIN(n, len), proto);

        ret = JS_NewInt32(ctx, r);

        if(r > 0)
          if(proto == LWS_WRITE_HTTP_FINAL)
            if(lws_http_transaction_completed(s->wsi))
              s->completed = TRUE;
      }

      if(JS_IsString(argv[0]))
        JS_FreeCString(ctx, ptr);

      break;
    }

    case METHOD_RESPOND: {
      unsigned char result[LWS_PRE + LWS_RECOMMENDED_MIN_HEADER_SPACE], *p = (unsigned char*)result + LWS_PRE, *start = p;
      unsigned char* end = p + sizeof(result) - LWS_PRE - 1;
      uint8_t* ptr = 0;
      size_t len = 0;
      int hidx = -1;
      int32_t code = -1;

      for(int i = 0; i < argc; ++i) {
        if(code == -1 && JS_IsNumber(argv[i]))
          code = value_to_integer(ctx, argv[i]);
        else if(!ptr)
          ptr = JS_GetArrayBuffer(ctx, &len, argv[i]);
        else if(JS_IsObject(argv[i]))
          hidx = i;
      }

      if(code != -1)
        if(lws_add_http_header_status(s->wsi, code, &p, end))
          return JS_ThrowInternalError(ctx, "lws_add_http_header_status");

      if(hidx != -1) {
        JSPropertyEnum* tmp_tab = 0;
        uint32_t tmp_len;

        if(!JS_GetOwnPropertyNames(ctx, &tmp_tab, &tmp_len, argv[hidx], JS_GPN_STRING_MASK | JS_GPN_SET_ENUM)) {
          for(uint32_t j = 0; j < tmp_len; j++) {
            JSValue key = JS_AtomToValue(ctx, tmp_tab[j].atom);
            const char* name = JS_ToCString(ctx, key);
            JS_FreeValue(ctx, key);

            JSValue value = JS_GetProperty(ctx, argv[hidx], tmp_tab[j].atom);
            size_t valuelen;
            const char* valuestr = JS_ToCStringLen(ctx, &valuelen, value);
            JS_FreeValue(ctx, value);

            if(lws_add_http_header_by_name(s->wsi, (const unsigned char*)name, (void*)valuestr, valuelen, &p, end))
              JS_ThrowInternalError(ctx, "lws_add_http_header_by_name");

            JS_FreeCString(ctx, name);
            JS_FreeCString(ctx, valuestr);
          }
        }
      }

      if(ptr)
        if(lws_add_http_header_content_length(s->wsi, len > 0 ? len : LWS_ILLEGAL_HTTP_CONTENT_LEN, &p, end))
          return JS_ThrowInternalError(ctx, "lws_add_http_header_content_length");

      if(lws_finalize_http_header(s->wsi, &p, end))
        return JS_ThrowInternalError(ctx, "lws_finalize_http_header");

      size_t bytes = lws_ptr_diff_size_t(p, start);

      printf("bytes = %zu\n", bytes);
      printf("ptr = %p\n", ptr);
      printf("len = %zu\n", len);
      printf("code = %" PRId32 "\n", code);

      int n = lws_write(s->wsi, start, bytes, LWS_WRITE_HTTP_HEADERS | LWS_WRITE_H2_STREAM_END);

      if(n < 0)
        return JS_ThrowInternalError(ctx, "lws_write");

      /*  if(ptr && len > 0) {
          n = lws_write(s->wsi, (unsigned char*)ptr, (unsigned int)len, LWS_WRITE_HTTP_FINAL);
          if(n < 0)
            return JS_ThrowInternalError(ctx, "lws_write");
        }*/

      break;
    }

    case METHOD_HTTP_CLIENT_READ: {
      size_t n;
      uint8_t* p;
      int l = n;

      if((p = JS_GetArrayBuffer(ctx, &n, argv[0]))) {
        int result = lws_http_client_read(s->wsi, (char**)&p, &l);

        if(result == -1)
          ret = JS_ThrowInternalError(ctx, "lws_http_client_read returned -1");
        else
          ret = JS_NewInt32(ctx, l);
      }

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
lws_socket_functions(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[], int magic) {
  LWSSocket* s;
  JSValue ret = JS_UNDEFINED;

  switch(magic) {
    case FUNCTION_GET: {
      int32_t fd = -1;
      JS_ToInt32(ctx, &fd, argv[0]);

      ret = js_socket_get_by_fd(ctx, fd);
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
};

static JSValue
lws_socket_get(JSContext* ctx, JSValueConst this_val, int magic) {
  LWSSocket* s;
  JSValue ret = JS_UNDEFINED;

  if(!(s = JS_GetOpaque2(ctx, this_val, lws_socket_class_id)))
    return JS_EXCEPTION;

  switch(magic) {
    case PROP_HEADERS: {
      ret = JS_DupValue(ctx, s->headers);
      break;
    }

    case PROP_ID: {
      ret = JS_NewUint32(ctx, s->id);
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

        ret = JS_DupValue(ctx, JS_MKPTR(JS_TAG_OBJECT, obj));
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
        ret = wsi == s->wsi ? JS_DupValue(ctx, this_val) : js_socket_wrap(ctx, wsi);

      break;
    }

    case PROP_CHILD: {
      struct lws* wsi = lws_get_child(s->wsi);

      if(wsi)
        ret = wsi == s->wsi ? JS_DupValue(ctx, this_val) : js_socket_wrap(ctx, wsi);

      break;
    }

    case PROP_NETWORK: {
      struct lws* wsi = lws_get_network_wsi(s->wsi);

      if(wsi)
        ret = wsi == s->wsi ? JS_DupValue(ctx, this_val) : js_socket_wrap(ctx, wsi);

      break;
    }

    case PROP_PROTOCOL: {
      const struct lws_protocols* p;

      if((p = lws_get_protocol(s->wsi))) {
        LWSProtocol* lwsp;

        if((lwsp = p->user))
          if(lwsp->obj)
            ret = JS_DupValue(ctx, JS_MKPTR(JS_TAG_OBJECT, lwsp->obj));
      }

      break;
    }
  }

  return ret;
}

static void
lws_socket_finalizer(JSRuntime* rt, JSValue val) {
  LWSSocket* s;

  if((s = JS_GetOpaque(val, lws_socket_class_id))) {
    if(s->obj) {
      JSValue obj = JS_MKPTR(JS_TAG_OBJECT, s->obj);
      JS_FreeValueRT(rt, obj);
      s->obj = 0;
    }

    JS_FreeValueRT(rt, s->headers);
    s->headers = JS_UNDEFINED;

    socket_delete(s);
    js_free_rt(rt, s);
  }
}

static const JSClassDef lws_socket_class = {
    "LWSSocket",
    .finalizer = lws_socket_finalizer,
};

static const JSCFunctionListEntry lws_socket_proto_funcs[] = {
    JS_CFUNC_MAGIC_DEF("wantWrite", 0, lws_socket_methods, METHOD_WANT_WRITE),
    JS_CFUNC_MAGIC_DEF("write", 1, lws_socket_methods, METHOD_WRITE),
    JS_CFUNC_MAGIC_DEF("respond", 1, lws_socket_methods, METHOD_RESPOND),
    JS_CFUNC_MAGIC_DEF("httpClientRead", 1, lws_socket_methods, METHOD_HTTP_CLIENT_READ),
    JS_CGETSET_MAGIC_FLAGS_DEF("id", lws_socket_get, 0, PROP_ID, JS_PROP_ENUMERABLE),
    JS_CGETSET_MAGIC_FLAGS_DEF("tag", lws_socket_get, 0, PROP_TAG, JS_PROP_CONFIGURABLE),
    JS_CGETSET_MAGIC_DEF("headers", lws_socket_get, 0, PROP_HEADERS),
    JS_CGETSET_MAGIC_DEF("tls", lws_socket_get, 0, PROP_TLS),
    JS_CGETSET_MAGIC_DEF("peer", lws_socket_get, 0, PROP_PEER),
    JS_CGETSET_MAGIC_FLAGS_DEF("fd", lws_socket_get, 0, PROP_FD, JS_PROP_ENUMERABLE),
    JS_CGETSET_MAGIC_DEF("parent", lws_socket_get, 0, PROP_PARENT),
    JS_CGETSET_MAGIC_DEF("child", lws_socket_get, 0, PROP_CHILD),
    JS_CGETSET_MAGIC_DEF("network", lws_socket_get, 0, PROP_NETWORK),
    JS_CGETSET_MAGIC_DEF("context", lws_socket_get, 0, PROP_CONTEXT),
    JS_CGETSET_MAGIC_DEF("peerWriteAllowance", lws_socket_get, 0, PROP_PEER_WRITE_ALLOWANCE),
    JS_CGETSET_MAGIC_DEF("protocol", lws_socket_get, 0, PROP_PROTOCOL),
    JS_PROP_STRING_DEF("[Symbol.toStringTag]", "LWSSocket", JS_PROP_CONFIGURABLE),
};

static const JSCFunctionListEntry lws_socket_static_funcs[] = {
    JS_CFUNC_MAGIC_DEF("get", 1, lws_socket_functions, FUNCTION_GET),
    JS_CFUNC_MAGIC_DEF("list", 0, lws_socket_functions, FUNCTION_LIST),
};

int
lws_socket_init(JSContext* ctx, JSModuleDef* m) {
  init_list_head(&socket_list);

  JS_NewClassID(&lws_socket_class_id);
  JS_NewClass(JS_GetRuntime(ctx), lws_socket_class_id, &lws_socket_class);
  lws_socket_proto = JS_NewObjectProto(ctx, JS_NULL);
  JS_SetPropertyFunctionList(ctx, lws_socket_proto, lws_socket_proto_funcs, countof(lws_socket_proto_funcs));

  lws_socket_ctor = JS_NewObjectProto(ctx, JS_NULL);
  JS_SetPropertyFunctionList(ctx, lws_socket_ctor, lws_socket_static_funcs, countof(lws_socket_static_funcs));
  JS_SetConstructor(ctx, lws_socket_ctor, lws_socket_proto);

  if(m) {
    JS_SetModuleExport(ctx, m, "LWSSocket", lws_socket_ctor);
  }

  return 0;
}
