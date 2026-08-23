#include "lws-socket.h"
#include "lws-context.h"
#include "lws-vhost.h"
#include "lws-sockaddr46.h"
#include "lws.h"
#include "js-utils.h"
#include <assert.h>
#include <sys/socket.h>

#include "libwebsockets/lib/core/private-lib-core.h"

JSClassID lwsjs_socket_class_id;
static JSValue lwsjs_socket_proto, lwsjs_socket_ctor;

static struct list_head socket_list;
static uint32_t socket_id;

/* Per-write queue entry. The payload sits at buf + LWS_PRE so libwebsockets
   has room to fill the WebSocket frame header in place. pos is how many
   payload bytes have already been handed to lws_write(). */
typedef struct {
  struct list_head link;
  uint8_t* buf;
  size_t len, pos;
  enum lws_write_protocol proto;
  lws_sockaddr46 addr;
  BOOL has_addr;
} WriteChunk;

static WriteChunk*
write_chunk_new(const void* data, size_t len, enum lws_write_protocol proto) {
  WriteChunk* wc = malloc(sizeof(*wc));

  if(!wc)
    return NULL;

  wc->buf = malloc(LWS_PRE + len);

  if(!wc->buf) {
    free(wc);
    return NULL;
  }

  if(len)
    memcpy(wc->buf + LWS_PRE, data, len);

  wc->len = len;
  wc->pos = 0;
  wc->proto = proto;
  wc->has_addr = FALSE;
  return wc;
}

static void
write_chunk_free(WriteChunk* wc) {
  free(wc->buf);
  free(wc);
}

/* Builds a WriteChunk for `data` (`len` bytes, `proto`, optional `sa`) and
   appends it to `s->write_queue`, bumping s->write_buffered - the common
   core of every "queue this for later/eventual sending" call site
   (lwsjs_socket_write()'s normal path and its dispatching fast path's
   partial-write leftover, lwsjs_socket_respond()'s optional body). Doesn't
   flush or re-arm anything itself, doesn't touch JS exception state -
   callers that want either do it themselves, since what's appropriate
   differs per call site (see each one). Returns NULL (nothing queued) only
   on allocation failure. */
static WriteChunk*
socket_queue_write(LWSSocket* s, const void* data, size_t len, enum lws_write_protocol proto, const lws_sockaddr46* sa) {
  WriteChunk* wc = write_chunk_new(data, len, proto);

  if(!wc)
    return NULL;

  if(sa) {
    wc->addr = *sa;
    wc->has_addr = TRUE;
  }

  list_add_tail(&wc->link, &s->write_queue);
  s->write_buffered += len;

  return wc;
}

static void
socket_write_queue_clear(LWSSocket* s) {
  while(!list_empty(&s->write_queue)) {
    WriteChunk* wc = list_entry(s->write_queue.next, WriteChunk, link);

    list_del(&wc->link);
    write_chunk_free(wc);
  }

  s->write_buffered = 0;
}

/* 0x4000/16384 - HTTP/2's own default SETTINGS_MAX_FRAME_SIZE (RFC 7540
   §6.5.2), which every connection starts at whether or not the peer later
   raises it. A single lws_write() call for an HTTP body write bigger than
   this reliably closed the connection before a response ever arrived
   instead of lws's own partial-write retry machinery (the loop below)
   picking up where it left off, the way it does for a partial *plain* TCP
   write over HTTP/1.1 - confirmed directly, deterministically, right at
   this exact boundary, against a real HTTPS endpoint that negotiated h2
   via ALPN (see BUGS: tls-client-large-body-closes-above-16kb). Read as
   "TLS record size" at first (a single wsi.write() call above this size
   over a *plain* TLS/h1 connection was never actually confirmed broken,
   only assumed to be the same issue) - the debug log at the time this was
   pinned down showed an h2 mux substream, not a bare TLS wsi, which is
   what actually points at h2's own DATA-frame size cap instead: this
   project's own h2 write path apparently doesn't split a body larger than
   one frame's worth across multiple DATA frames itself, so a body over
   the limit becomes a single frame the peer sees as invalid framing and
   drops. Splitting it into separate wsi.write() calls no bigger than this
   sidesteps that without needing to fix the h2 write path directly (or
   nail down whether it's really that, versus something else specific to
   this size - `lwsi_role_h2(wsi)` would let this check apply only to an
   h2 connection, but requires including the h2 role's private header;
   capping *any* HTTP body write's per-call size this way costs nothing on
   plain HTTP/1.1, which already writes bodies far smaller than this in
   practice, so the extra include isn't worth it just to narrow the
   check). */
#define HTTP_WRITE_CHUNK_MAX 16384

/* enum lws_write_protocol's low nibble (LWS_WRITE_TEXT..LWS_WRITE_H2_STREAM_END)
   as names, for TX traffic logging (socket_flush(), lwsjs_socket_write()'s
   dispatching fast path below). */
static const char* const lwsjs_write_proto_names[] = {
    "TEXT",
    "BINARY",
    "CONTINUATION",
    "HTTP",
    0,
    "PING",
    "PONG",
    "HTTP_FINAL",
    "HTTP_HEADERS",
    "HTTP_HEADERS_CONTINUATION",
    "BUFLIST",
    "NO_FIN",
    "H2_STREAM_END",
};

/* Drain as many queued chunks as libwebsockets is willing to accept. If any
   remain (partial write, or lws is currently holding a partial internally),
   re-arm the writeable callback so we get called back to try again. */
void
socket_flush(LWSSocket* s) {
  if(!s || !s->wsi)
    return;

  while(!list_empty(&s->write_queue)) {
    if(lws_partial_buffered(s->wsi))
      break;

    WriteChunk* wc = list_entry(s->write_queue.next, WriteChunk, link);
    size_t remaining = wc->len - wc->pos;
    enum lws_write_protocol wp = wc->proto;

    /* See the "HTTP body writes have no such per-message-boundary concept"
       comment below - a WS message must never be split like this, only an
       HTTP body write (LWS_WRITE_HTTP/LWS_WRITE_HTTP_FINAL) can be. */
    BOOL is_ws_message = wc->proto != LWS_WRITE_HTTP && wc->proto != LWS_WRITE_HTTP_FINAL;

    if(!is_ws_message && remaining > HTTP_WRITE_CHUNK_MAX) {
      remaining = HTTP_WRITE_CHUNK_MAX;

      /* This call won't reach the end of the chunk, so it isn't the FINAL
         write yet even if the chunk as a whole is - only the call that
         actually drains the last byte (wc->pos >= wc->len below) may carry
         LWS_WRITE_HTTP_FINAL; an earlier, truncated call claiming FINAL
         would tell lws the HTTP request body is complete before it is. */
      if(wp == LWS_WRITE_HTTP_FINAL)
        wp = LWS_WRITE_HTTP;
    }

    if(lws_wsi_is_udp(s->wsi)) {
      struct lws_udp* udp;

      if(wc->has_addr && (udp = (struct lws_udp*)lws_get_udp(s->wsi)))
        udp->sa46 = udp->sa46_pending = wc->addr;
    }

    int n;

    if((n = lws_write(s->wsi, wc->buf + LWS_PRE + wc->pos, remaining, wp)) < 0) {
      /* Connection is dead — drop everything so we don't keep re-arming. */
      socket_write_queue_clear(s);
      return;
    }

    if(n > 0) {
      /* Bypasses lwsl_wsi_user()'s fixed 1024-byte formatting buffer (see
         BUGS: lws-log-line-1024-byte-cap) via lwsjs_log_user_line() (lws.h). */
      char prefix[256];
      size_t plen = lwsjs_log_tx_prefix(prefix, sizeof(prefix), s->wsi, (unsigned long)n, lwsjs_write_proto_names[wp & 0xf]);

      lwsjs_log_user_line(s->wsi, prefix, plen, wc->buf + LWS_PRE + wc->pos, (size_t)n);
    }

    /* A single lws_write() call for a WS text/binary message IS the whole
       message: if the OS can't take it all immediately, lws buffers the
       remainder itself and flushes it autonomously (see the "Truncated
       Writes" section in lws-write.h) - the caller isn't meant to retry.
       Retrying here with wc->proto (always LWS_WRITE_TEXT/BINARY, never
       LWS_WRITE_CONTINUATION) would send the leftover bytes as a brand-new,
       separate WS frame, splitting one logical message into several the
       receiver can't reassemble. HTTP body writes have no such
       per-message-boundary concept, so those keep the retry loop, calling
       lws_write() again with the remaining bytes and the same proto (or,
       for a chunk bigger than HTTP_WRITE_CHUNK_MAX, the same wp - see
       is_ws_message above) until the whole chunk is out. */
    wc->pos = is_ws_message ? wc->len : wc->pos + (size_t)n;
    s->write_buffered -= is_ws_message ? remaining : (size_t)n;

    if(wc->pos >= wc->len) {
      if(wc->proto == LWS_WRITE_HTTP_FINAL && lws_http_transaction_completed(s->wsi))
        s->completed = TRUE;

      list_del(&wc->link);
      write_chunk_free(wc);
      continue;
    }

    /* Chunk still has payload but this call made no progress — wait. */
    if(n == 0)
      break;
  }

  if(!list_empty(&s->write_queue))
    lws_callback_on_writable(s->wsi);
}

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
    if(lwsjs_method_names[i] && !strcasecmp(method, lwsjs_method_names[i]))
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

  assert(socket_list.next);
  assert(socket_list.prev);

  list_add(&sock->link, &socket_list);

  sock->ref_count = 1;
  sock->headers = JS_UNDEFINED;
  sock->write_handler = JS_UNDEFINED;
  sock->id = ++socket_id;
  sock->method = -1;
  sock->dispatching = FALSE;
  sock->dispatch_reason = -1;

  init_list_head(&sock->write_queue);

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

  return SOCKET_RAW;
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
    LWSSocket* sock;

    if((sock = list_entry(n, LWSSocket, link)))
      if((uintptr_t)sock != (uintptr_t)-1 && sock->wsi == wsi)
        return sock;
  }

  return 0;
}

LWSSocket*
socket_get(struct lws* wsi) {
  void* obj;

  if((obj = lws_get_opaque_user_data(wsi)))
    return lwsjs_socket_data(JS_MKPTR(JS_TAG_OBJECT, obj));

  return 0;
}

static LWSSocket*
socket_get_by_id(int id) {
  struct list_head* n;

  list_for_each(n, &socket_list) {
    LWSSocket* sock = list_entry(n, LWSSocket, link);

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

    if(sock->write_queue.next)
      socket_write_queue_clear(sock);

    if(sock->uri) {
      js_free_rt(rt, sock->uri);
      sock->uri = 0;
    }

    if(sock->proto) {
      js_free_rt(rt, sock->proto);
      sock->proto = 0;
    }

    if(sock->close_reason) {
      js_free_rt(rt, sock->close_reason);
      sock->close_reason = 0;
    }

    if(sock->retry) {
      /* struct lws_retry_bo's retry_ms_table is a separate allocation -
         see retry_bo_fromobj(), lws-context.c. */
      if(((const lws_retry_bo_t*)sock->retry)->retry_ms_table)
        js_free_rt(rt, (void*)((const lws_retry_bo_t*)sock->retry)->retry_ms_table);

      js_free_rt(rt, sock->retry);
      sock->retry = 0;
    }

    js_free_rt(rt, sock);
  }
}

static void
socket_delete(LWSSocket* sock, JSRuntime* rt) {
  assert(socket_list.next);
  assert(socket_list.prev);

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

JSValue
lwsjs_socket_fromwsi(JSContext* ctx, struct lws* wsi) {
  void* obj;

  if((obj = lws_get_opaque_user_data(wsi)))
    return JS_DupValue(ctx, JS_MKPTR(JS_TAG_OBJECT, obj));

  return JS_UNDEFINED;
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

    /* lws never attaches opaque_user_data itself for server-accepted wsi's
       (only our own METHOD_CLIENT_CONNECT does, via info.opaque_user_data) -
       so without this, lwsjs_socket_fromwsi()/socket_get() never find a wrapper
       for an accepted connection and lwsjs_socket_get_or_create() mints a
       brand new one on every single callback, breaking wsi identity
       (Map/Set keying, wsi.foo = x, etc.) across calls for HTTP/WS/raw
       server connections. sock->obj already holds a dup'd reference to
       `ret` for the wsi's whole lifetime, so this pointer never dangles. */
    lws_set_opaque_user_data(wsi, JS_VALUE_GET_PTR(ret));
  }

  return ret;
}

void
lwsjs_socket_destroy(JSContext* ctx, struct lws* wsi) {
  LWSSocket* sock;

  if((sock = socket_get(wsi))) {
    assert(sock->wsi);
    sock->wsi = 0;

    socket_delete(sock, JS_GetRuntime(ctx));
  }
}

JSValue
lwsjs_socket_get_or_create(JSContext* ctx, struct lws* wsi) {
  JSValue ret = lwsjs_socket_fromwsi(ctx, wsi);
  BOOL create;

  if((create = JS_IsUndefined(ret))) {
    ret = lwsjs_socket_create(ctx, wsi);
  } else {
    /* lws_client_connect_via_info() attaches opaque_user_data (what
       socket_get()/lwsjs_socket_fromwsi() look the wrapper up by, via
       lws_get_opaque_user_data()) to a new client wsi before it fills in
       *info.pwsi (what originally set sock->wsi) - so a callback firing
       in between sees a wrapper whose ->wsi is still stale/NULL. Since
       we were just handed the real, current wsi, correct it here. */
    LWSSocket* sock;

    if((sock = lwsjs_socket_data(ret)) && sock->wsi != wsi)
      sock->wsi = wsi;
  }

  /*DEBUG("%s LWSSocket (wsi = %p, id = %d, ref_count = %d, obj = %p) = %p",
        create ? "create" : "get",
        wsi,
        lwsjs_socket_data(ret)->id,
        lwsjs_socket_data(ret)->ref_count,
        JS_VALUE_GET_OBJ(ret),
        lwsjs_socket_data(ret));*/

  return ret;
}

typedef struct {
  JSValue obj;
  JSContext* ctx;
  struct lws* wsi;
} CustomHeaders;

static void
set_property(JSContext* ctx, JSValueConst obj, const char* name, int nlen, const char* value, int vlen) {
  JSAtom prop = JS_NewAtomLen(ctx, name, nlen);

  JS_SetProperty(ctx, obj, prop, JS_NewStringLen(ctx, value, vlen));
  JS_FreeAtom(ctx, prop);
}

static void
custom_headers_callback(const char* name, int nlen, void* opaque) {
  CustomHeaders* ch = opaque;
  int namelen = nlen, len = lws_hdr_custom_length(ch->wsi, name, nlen);
  char buf[len + 1];
  int i = 0, j, r = lws_hdr_custom_copy(ch->wsi, buf, len + 1, name, nlen);

  while((j = findb_charset(&name[i], nlen - i, ": ", 2)) < (nlen - i - 1)) {
    int k = i + j;

    while(name[k] == ':' || name[k] == ' ')
      ++k;

    int n = findb_charset(&name[k], nlen - k, "\r\n", 2);
    int end = k + n;

    while(name[end] == '\r' || name[end] == '\n')
      ++end;

    if(n < (nlen - k))
      set_property(ch->ctx, ch->obj, &name[i], j, &name[k], n);

    i = end;

    if(n >= (nlen - k))
      break;
  }

  set_property(ch->ctx, ch->obj, &name[i], findb_charset(&name[i], nlen - i, ": ", 2), buf, r);
}

JSValue
lwsjs_socket_headers(JSContext* ctx, struct lws* wsi, char** pproto) {
  JSValue ret = JS_NewObjectProto(ctx, JS_NULL);

  for(int i = WSI_TOKEN_GET_URI; i < WSI_TOKEN_COUNT; i++) {
    if(is_uri(i))
      continue;

    if(i == WSI_TOKEN_HTTP)
      continue;

    size_t len;

    if((len = lws_hdr_total_length(wsi, i)) <= 0)
      continue;

    const char* name;

    if(!(name = (const char*)lws_token_to_string(i)))
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

  CustomHeaders ch = {ret, ctx, wsi};

  lws_hdr_custom_name_foreach(wsi, custom_headers_callback, &ch);

  return ret;
}

static LWSSocket*
lwsjs_socket_method_data(JSContext* ctx, JSValueConst this_val, const char* method) {
  LWSSocket* s;

  if(!(s = lwsjs_socket_data2(ctx, this_val)))
    return NULL;

  if(!s->wsi) {
    JS_ThrowInternalError(ctx, "%s: s->wsi == NULL", method);
    return NULL;
  }

  return s;
}

static JSValue
lwsjs_socket_want_write(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[]) {
  LWSSocket* s;
  JSValue ret = JS_UNDEFINED;

  if(!(s = lwsjs_socket_method_data(ctx, this_val, __func__)))
    return JS_EXCEPTION;

  if(!s->want_write) {
    lws_callback_on_writable(s->wsi);

    s->want_write = TRUE;
    ret = JS_NewBool(ctx, TRUE);

    if(argc > 0) {
      JS_FreeValue(ctx, s->write_handler);
      s->write_handler = JS_DupValue(ctx, argv[0]);
    }
  }

  return ret;
}

static JSValue
lwsjs_socket_write(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[]) {
  LWSSocket* s;
  const void* buf = NULL;
  BOOL text = FALSE, have_len = FALSE, have_proto = FALSE;
  int i = 0;
  enum lws_write_protocol proto = -1;
  size_t size = 0, len = 0;
  lws_sockaddr46* sa = 0;

  if(!(s = lwsjs_socket_method_data(ctx, this_val, __func__)))
    return JS_EXCEPTION;

  if(JS_IsString(argv[i])) {
    text = TRUE;
  }

  if(!(buf = text ? (const void*)JS_ToCStringLen(ctx, &size, argv[i]) : (const void*)JS_GetArrayBuffer(ctx, &size, argv[i])))
    return JS_ThrowTypeError(ctx, "wsi.write: expected string or ArrayBuffer");

  len = size;
  i++;

  while(i < argc) {
    if(!have_len && i + 1 < argc && JS_IsNumber(argv[i])) {
      len = to_int32(ctx, argv[i++]);
      have_len = TRUE;
    } else if(!have_proto && JS_IsNumber(argv[i])) {
      proto = to_int32(ctx, argv[i++]);
      have_proto = TRUE;
    } else if(!sa && (sa = lwsjs_sockaddr46_data(ctx, argv[i]))) {
      i++;
    } else {
      break;
    }
  }

  if(!have_proto)
    proto = lwsi_role_ws(s->wsi) ? text ? LWS_WRITE_TEXT : LWS_WRITE_BINARY : LWS_WRITE_HTTP;

  if(len > size)
    len = size;

  BOOL is_ws_message = proto != LWS_WRITE_HTTP && proto != LWS_WRITE_HTTP_FINAL;

  /* We're synchronously inside this wsi's own ..._WRITEABLE callback
     dispatch (lws-protocol.c sets s->dispatching/s->dispatch_reason around
     that JS_Call) with nothing already ahead of us in write_queue - lws has
     *just* told us we may write right now, so go straight to lws_write()
     instead of round-tripping through write_chunk_new()/the write_queue/
     socket_flush(), which exist to handle writing outside that window
     (queued for a future WRITEABLE, or a chunk over HTTP_WRITE_CHUNK_MAX
     that needs splitting across several - this fast path only takes over
     the common single-call case; anything bigger falls through to the
     normal queued path below, same as always). Capped to
     HTTP_WRITE_CHUNK_MAX even for a WS message (which is otherwise never
     split - see is_ws_message's use further down): unlike write_chunk_new()
     this uses a stack buffer, so an unbounded single WS write here would
     risk a stack overflow instead of just a large heap allocation. */
  if(s->dispatching && is_writeable_reason(s->dispatch_reason) && list_empty(&s->write_queue) && len <= HTTP_WRITE_CHUNK_MAX) {
    uint8_t stackbuf[LWS_PRE + len];

    if(len)
      memcpy(stackbuf + LWS_PRE, buf, len);

    if(text)
      JS_FreeCString(ctx, (const char*)buf);

    if(sa && lws_wsi_is_udp(s->wsi)) {
      struct lws_udp* udp;

      if((udp = (struct lws_udp*)lws_get_udp(s->wsi)))
        udp->sa46 = udp->sa46_pending = *sa;
    }

    int n = lws_write(s->wsi, stackbuf + LWS_PRE, len, proto);

    if(n > 0) {
      /* Bypasses lwsl_wsi_user()'s fixed 1024-byte formatting buffer (see
         BUGS: lws-log-line-1024-byte-cap) via lwsjs_log_user_line() (lws.h). */
      char prefix[256];
      size_t plen = lwsjs_log_tx_prefix(prefix, sizeof(prefix), s->wsi, (unsigned long)n, lwsjs_write_proto_names[proto & 0xf]);

      lwsjs_log_user_line(s->wsi, prefix, plen, stackbuf + LWS_PRE, (size_t)n);
    }

    /* Same "a WS message is never split, an HTTP body write can be" rule
       as socket_flush() (see its own comment on is_ws_message) - a
       partial HTTP write's leftover still needs to go out, but we won't
       get another synchronous invitation to write until the next real
       WRITEABLE, so queue it and re-arm exactly like socket_flush()'s own
       tail does. */
    if(n >= 0 && !is_ws_message && (size_t)n < len) {
      if(socket_queue_write(s, stackbuf + LWS_PRE + n, len - (size_t)n, proto, NULL))
        lws_callback_on_writable(s->wsi);
    } else if(n >= 0 && proto == LWS_WRITE_HTTP_FINAL && lws_http_transaction_completed(s->wsi)) {
      s->completed = TRUE;
    }

    DEBUG_WSI(s->wsi, "direct-wrote %d/%zu bytes (dispatching, proto=%d)", n, len, proto);

    return JS_NewInt32(ctx, (int)len);
  }

  WriteChunk* wc = socket_queue_write(s, buf, len, proto, sa);

  if(text)
    JS_FreeCString(ctx, (const char*)buf);

  if(!wc)
    return JS_ThrowOutOfMemory(ctx);

  /* Request a WRITEABLE callback rather than flushing right here: an
     eager, synchronous socket_flush() from a wsi.write() called outside of
     any writeable dispatch (the common case - a WS/TCP send() from
     arbitrary JS code, or an HTTP wsi.write() before wsi.respond() has
     ever run for this transaction) has no way to know whether it's even
     legal to put bytes on the wire right now - for an HTTP response in
     particular, calling it before respond() has written the status line/
     headers sent this chunk straight out first, corrupting the framing
     (confirmed directly: curl got an unparseable response). Draining now
     happens only from the real ..._WRITEABLE dispatch (lws-protocol.c,
     unconditionally calls socket_flush() there) - or from this same
     function's own dispatching fast path above, when we already know
     it's our turn to write. */
  lws_callback_on_writable(s->wsi);

  DEBUG_WSI(s->wsi, "queued %zu bytes, %zu buffered, partial=%d", len, s->write_buffered, lws_partial_buffered(s->wsi));

  return JS_NewInt32(ctx, (int)len);
}

static JSValue
lwsjs_socket_respond(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[]) {
  LWSSocket* s;
  uint8_t result[LWS_PRE + LWS_RECOMMENDED_MIN_HEADER_SPACE], *p = (uint8_t*)result + LWS_PRE, *start = p;
  uint8_t *end = p + sizeof(result) - LWS_PRE - 1, *ptr = NULL;
  size_t tmp_len, written = 0;
  int64_t len = -1;
  int code = -1;
  int header_arg = -1;
  BOOL is_str = FALSE;

  if(!(s = lwsjs_socket_method_data(ctx, this_val, __func__)))
    return JS_EXCEPTION;

  for(int i = 0; i < argc; ++i) {
    if(code == -1 && JS_IsNumber(argv[i])) {
      code = to_int32(ctx, argv[i]);
    } else if(len == -1 && JS_IsNumber(argv[i])) {
      len = to_int64(ctx, argv[i]);
    } else if(!ptr && (ptr = JS_GetArrayBuffer(ctx, &tmp_len, argv[i]))) {
      len = len == -1 ? (int64_t)tmp_len : len;
    } else if(!ptr && JS_IsString(argv[i]) && (ptr = (uint8_t*)JS_ToCStringLen(ctx, &tmp_len, argv[i]))) {
      len = len == -1 ? (int64_t)tmp_len : len;
      is_str = TRUE;
    } else if(header_arg == -1 && JS_IsObject(argv[i])) {
      header_arg = i;
    } else {
      break;
    }
  }

  if(lws_add_http_common_headers(s->wsi, code, NULL, len > 0 ? (uint64_t)len : LWS_ILLEGAL_HTTP_CONTENT_LEN, &p, end)) {
    if(is_str)
      JS_FreeCString(ctx, (const char*)ptr);

    return JS_ThrowInternalError(ctx, "lws_add_http_common_headers failed");
  }

  JSPropertyEnum* tab = 0;
  uint32_t tab_len;

  if(header_arg != -1 && !JS_GetOwnPropertyNames(ctx, &tab, &tab_len, argv[header_arg], JS_GPN_STRING_MASK | JS_GPN_SET_ENUM)) {

    for(uint32_t j = 0; j < tab_len; j++) {
      JSValue key = JS_AtomToValue(ctx, tab[j].atom);
      const char* name = JS_ToCString(ctx, key);
      JS_FreeValue(ctx, key);

      JSValue value = JS_GetProperty(ctx, argv[header_arg], tab[j].atom);

      /* Array values emit one header line per element. Needed for
         Set-Cookie (RFC 6265 forbids comma-folding) and accepted
         generally so callers can pass a list under any name. */
      if(JS_IsArray(ctx, value)) {
        uint32_t n_elems = to_uint32free(ctx, JS_GetPropertyStr(ctx, value, "length"));

        for(uint32_t k = 0; k < n_elems; k++) {
          JSValue elem = JS_GetPropertyUint32(ctx, value, k);
          size_t vlen;
          const char* vstr = JS_ToCStringLen(ctx, &vlen, elem);

          if(vstr) {
            if(lws_add_http_header_by_name(s->wsi, (const uint8_t*)name, (const uint8_t*)vstr, vlen, &p, end))
              JS_ThrowInternalError(ctx, "lws_add_http_header_by_name");

            JS_FreeCString(ctx, vstr);
          }

          JS_FreeValue(ctx, elem);
        }
      } else {
        size_t vlen;
        const char* vstr = JS_ToCStringLen(ctx, &vlen, value);

        if(vstr) {
          if(lws_add_http_header_by_name(s->wsi, (const uint8_t*)name, (const uint8_t*)vstr, vlen, &p, end))
            JS_ThrowInternalError(ctx, "lws_add_http_header_by_name");

          JS_FreeCString(ctx, vstr);
        }
      }

      JS_FreeValue(ctx, value);
      JS_FreeCString(ctx, name);
      JS_FreeAtom(ctx, tab[j].atom);
    }

    js_free(ctx, tab);
  }

  /* A response that will never have a body (no body argument here, and
     nothing already queued via a prior wsi.write() for this transaction)
     MUST be finalized with LWS_WRITE_H2_STREAM_END, or under h2/h3 the
     HEADERS frame goes out without END_STREAM: the stream never
     completes, the client waits forever for a body that's never coming,
     and lws has no timeout watching for it (see lws-write.h's own doc
     comment on lws_finalize_write_http_header_flags()). h1 is unaffected
     either way - the flag only matters to the h2/h3 write path. */
  BOOL will_have_body = (ptr && len > 0) || !list_empty(&s->write_queue);
  int n = lws_finalize_write_http_header_flags(s->wsi, start, &p, end, LWS_WRITE_HTTP_HEADERS | (will_have_body ? 0 : LWS_WRITE_H2_STREAM_END)) ? -1 : (int)lws_ptr_diff_size_t(p, start);

  DEBUG_WSI(s->wsi, "wrote headers (%d)", n);

  if(n < 0) {
    if(is_str)
      JS_FreeCString(ctx, (const char*)ptr);

    return JS_ThrowInternalError(ctx, "lws_write");
  }

  written += n;

  /* No explicit lws_http_transaction_completed() call here for the
     headers-only case, on purpose: respond() is always called synchronously
     from within whatever reason is still handling the *request* (HTTP,
     HTTP_BODY_COMPLETION, ...), never from a WRITEABLE dispatch - calling
     it from inside that same still-in-progress dispatch confirmed
     reproducibly wrong (an immediate, tight HTTP/FILTER_HTTP_CONNECTION/
     HTTP_DROP_PROTOCOL loop, never reaching the client) rather than just
     resetting for the next transaction once this dispatch actually
     returns, which is what lws's own examples rely on instead (see
     minimal-http-server-form-post-file.c's lws_http_redirect() call,
     which never calls lws_http_transaction_completed() either). Simply
     returning from the HTTP handler is enough for lws to reset/complete
     the transaction itself. */

  if(ptr && len > 0) {
    /* Queued rather than lws_write()'d directly: this must not jump ahead
       of anything the caller already queued via wsi.write() before calling
       respond() (see BUGS-adjacent discussion - a premature wsi.write()
       used to leave its chunk stranded in write_queue forever, since
       nothing here ever drained it), and reusing socket_queue_write()/
       socket_flush() gets the same partial-write retry and
       HTTP_WRITE_CHUNK_MAX splitting every other body write already has,
       instead of this one single unbounded, unretried lws_write() call.
       socket_flush() does its own TX traffic logging for whatever it
       actually sends, so there's nothing to log here directly. */
    WriteChunk* wc = socket_queue_write(s, ptr, (size_t)len, LWS_WRITE_HTTP_FINAL, NULL);

    if(is_str)
      JS_FreeCString(ctx, (const char*)ptr);

    if(!wc)
      return JS_ThrowOutOfMemory(ctx);

    written += (size_t)len;

    socket_flush(s);
  } else if(is_str)
    JS_FreeCString(ctx, (const char*)ptr);

  return JS_NewUint32(ctx, written);
}

/* wsi.transactionCompleted() - manual escape hatch for a handler that
   wrote its own response bytes directly (bypassing respond()/write()
   entirely) and needs lws to decide "close now" vs "reset for the next
   keep-alive transaction" itself, the same way respond()'s headers-only
   path and socket_flush()/lwsjs_socket_write()'s dispatching fast path
   already do automatically for the common cases. Returns true if the
   connection will now close, false if it reset for a new transaction. */
static JSValue
lwsjs_socket_transaction_completed(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[]) {
  LWSSocket* s;
  BOOL close_now;

  if(!(s = lwsjs_socket_method_data(ctx, this_val, __func__)))
    return JS_EXCEPTION;

  if((close_now = lws_http_transaction_completed(s->wsi) ? TRUE : FALSE))
    s->completed = TRUE;

  return JS_NewBool(ctx, close_now);
}

/* wsi.longPollRxOnly() - h2 client stream only: half-closes the stream
   (sends an END_STREAM-flagged zero-length DATA frame) and marks it
   immortal/read-only, for a server that supports an immortal long-poll
   stream the client just wants to keep reading from indefinitely.
   Returns false if this wasn't an h2 client stream. */
static JSValue
lwsjs_socket_long_poll_rxonly(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[]) {
  LWSSocket* s;

  if(!(s = lwsjs_socket_method_data(ctx, this_val, __func__)))
    return JS_EXCEPTION;

  return JS_NewBool(ctx, lws_h2_client_stream_long_poll_rxonly(s->wsi) == 0);
}

static JSValue
lwsjs_socket_set_timeout(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[]) {
  LWSSocket* s;
  int32_t secs;

  if(!(s = lwsjs_socket_data2(ctx, this_val)))
    return JS_EXCEPTION;

  if(!s->wsi)
    return JS_UNDEFINED;

  secs = argc > 0 ? to_int32(ctx, argv[0]) : 0;

  /* PENDING_TIMEOUT_USER_OK is lws's generic "app-defined timeout, no
     specific internal meaning" reason - secs <= 0 cancels any pending
     timeout the same way lws itself does internally (NO_PENDING_TIMEOUT). */
  lws_set_timeout(s->wsi, secs > 0 ? PENDING_TIMEOUT_USER_OK : NO_PENDING_TIMEOUT, secs);

  return JS_UNDEFINED;
}

static JSValue
lwsjs_socket_close(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[]) {
  LWSSocket* s;
  uint32_t reason = 1000;

  if(!(s = lwsjs_socket_data2(ctx, this_val)))
    return JS_EXCEPTION;

  if(s->wsi == NULL)
    return JS_UNDEFINED;

  if(argc > 0)
    reason = to_uint32(ctx, argv[0]);

  /* A synchronous close() from inside one of these client "connection
     established" callbacks would force this dispatch's return value to
     -1 below (see the s->dispatching comment further down) - but each of
     them reads a nonzero return from *that specific* callback as "the
     connection was rejected", not "close it gracefully", routing to
     CLIENT_CONNECTION_ERROR instead of a graceful close:
       - LWS_CALLBACK_RAW_CONNECTED: ops-raw-skt.c's lws_raw_skt_connect()
         -> lws_inform_client_conn_fail() (formerly BUGS:
         raw-client-immediate-close-fires-error-not-close)
       - LWS_CALLBACK_CLIENT_ESTABLISHED (ws): client-ws.c -> cce = "HS:
         Rejected at CLIENT_ESTABLISHED" (BUGS:
         test-websocket-hs-rejected-on-sync-close)
     Deliberately NOT LWS_CALLBACK_ESTABLISHED_CLIENT_HTTP, which has the
     same "nonzero return = rejected" semantics in client-http.c but
     deferring the close there was tried and reproducibly hung the whole
     process (not even a JS-level setTimeout fallback fired) - needs
     separate investigation before it's safe to add here.
     Server-side counterparts (RAW_ADOPT, ESTABLISHED) don't need this: a
     nonzero return there goes straight to a real close
     (lws_close_free_wsi()/lws_wsi_close()), since there's no "client
     connection failed" concept for a server accepting a connection.
     Defer the actual close a microtask past the callback's own return
     instead, so the establishment callback reports success normally and
     the deferred close() call (now outside dispatch) produces a real
     CLOSE/RAW_CLOSE. */
  if(s->dispatching) {
    switch(s->dispatch_reason) {
      case LWS_CALLBACK_RAW_CONNECTED:
      case LWS_CALLBACK_CLIENT_ESTABLISHED: {
        JS_FreeValue(ctx, js_invoke_deferred(ctx, this_val, "close", argc, argv));
        return JS_UNDEFINED;
      }
    }
  }

  if(socket_type(s->wsi) == SOCKET_WS) {
    size_t n = 0;
    uint8_t* p = NULL;
    const char* str = 0;

    if(argc > 1) {
      if(!(p = get_buffer(ctx, argc - 1, argv + 1, &n)))
        p = (uint8_t*)(str = JS_ToCStringLen(ctx, &n, argv[1]));
    }

    /* Stash our own copy of code+reason before lws_close_reason() below:
       see the close_code/close_reason comment in lws-socket.h for why
       lwsjs_callback_protocol() reads back from here rather than from
       lws_get_close_length()/lws_get_close_payload() at CLOSED time. */
    s->close_code = (uint16_t)reason;
    s->close_code_set = TRUE;

    if(s->close_reason) {
      js_free(ctx, s->close_reason);
      s->close_reason = NULL;
    }

    s->close_reason_len = (uint32_t)n;

    if(p && n > 0 && (s->close_reason = js_malloc(ctx, n)))
      memcpy(s->close_reason, p, n);
    else
      s->close_reason_len = 0;

    lws_close_reason(s->wsi, reason, p, n);

    if(str)
      JS_FreeCString(ctx, str);
  }

  /* Freeing the wsi here is only safe when we're not still inside the
     protocol callback dispatch for this same wsi (lwsjs_callback_protocol(),
     lws-context.c). Some reasons (LWS_CALLBACK_RAW_ADOPT/RAW_CONNECTED
     in particular) keep using the wsi right after the callback returns
     (lws_role_call_adoption_bind(), etc. - see libwebsockets/lib/core-
     net/adopt.c), so freeing it synchronously from inside that same
     callback is a use-after-free/segfault. When dispatching, just mark
     the socket closed - lwsjs_callback_protocol() already turns that into a
     `return -1` for the in-progress callback, and lws's own state
     machine (which is what invoked us) frees the wsi safely once its
     callback call actually returns. */
  if(s->dispatching)
    s->closed = TRUE;
  else
    lws_close_free_wsi(s->wsi, reason, __func__);

  return JS_UNDEFINED;
}

static JSValue
lwsjs_socket_http_client_read(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[]) {
  LWSSocket* s;
  JSValue ret = JS_UNDEFINED;
  size_t n;
  uint8_t *p, *q;
  int l, result;

  if(!(s = lwsjs_socket_method_data(ctx, this_val, __func__)))
    return JS_EXCEPTION;

  if((q = p = get_buffer(ctx, argc, argv, &n))) {
    l = n;
    result = lws_http_client_read(s->wsi, (char**)&p, &l);

    if(result != -1)
      ret = JS_NewInt32(ctx, l);
  }

  return ret;
}

static JSValue
lwsjs_socket_add_header(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[]) {
  LWSSocket* s;
  const char *name = 0, *value;
  size_t vlen, blen;
  unsigned char *buf, *ptr;
  int64_t len = 0;
  enum lws_token_indexes token = -1;

  if(!(s = lwsjs_socket_method_data(ctx, this_val, __func__)))
    return JS_EXCEPTION;

  if(JS_IsNumber(argv[0])) {
    token = to_int32(ctx, argv[0]);
  } else if(!(name = JS_ToCString(ctx, argv[0]))) {
    return JS_ThrowTypeError(ctx, "argument 1 must be name");
  }

  if(!(value = JS_ToCStringLen(ctx, &vlen, argv[1]))) {
    JS_FreeCString(ctx, name);
    return JS_ThrowTypeError(ctx, "argument 2 must be value");
  }

  if(!(buf = JS_GetArrayBuffer(ctx, &blen, argv[2]))) {
    JS_FreeCString(ctx, name);
    JS_FreeCString(ctx, value);
    return JS_ThrowTypeError(ctx, "argument 3 must be ArrayBuffer");
  }

  len = to_int64free(ctx, JS_GetPropertyUint32(ctx, argv[3], 0));
  len = CLAMP(len, 0, (int64_t)blen);

  ptr = buf + len;

  int r = name ? lws_add_http_header_by_name(s->wsi, (const unsigned char*)name, (const unsigned char*)value, vlen, &ptr, buf + blen)
               : lws_add_http_header_by_token(s->wsi, token, (const unsigned char*)value, vlen, &ptr, buf + blen);

  JS_SetPropertyUint32(ctx, argv[3], 0, JS_NewUint32(ctx, ptr - buf));

  JS_FreeCString(ctx, name);
  JS_FreeCString(ctx, value);

  return JS_NewInt32(ctx, r);
}

static JSValue
lwsjs_socket_client_http_multipart(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[]) {
  LWSSocket* s;
  JSValue ret = JS_UNDEFINED;
  struct lws_process_html_args a = {0};
  const char *name = 0, *filename = 0, *content_type = 0;
  int i = 0;

  if(!(s = lwsjs_socket_method_data(ctx, this_val, __func__)))
    return JS_EXCEPTION;

  if(!s->wsi->http.multipart)
    return ret;

  if(argc > 0 && !is_nullish(argv[0]))
    name = JS_ToCString(ctx, argv[0]);

  if(argc > 1 && !is_nullish(argv[1]))
    filename = JS_ToCString(ctx, argv[1]);

  if(argc > 2 && !is_nullish(argv[2]))
    content_type = JS_ToCString(ctx, argv[2]);

  if(argc > 3)
    i = lwsjs_html_process_args(ctx, &a, argc - 3, argv + 3);

  struct lws_process_html_args b = a;

  b.p += b.len;
  b.max_len -= b.len;

  struct lws_process_html_args c = b;

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
  PROP_HEADERS,
  PROP_ID,
  PROP_CLIENT,
  PROP_RESPONSE_CODE,
  PROP_FD,
  PROP_METHOD,
  PROP_URI,
  PROP_BODY_PENDING,
  PROP_DISPATCHING,
  PROP_DISPATCH_REASON,
  PROP_REDIRECTED_TO_GET,
  PROP_BUFFERED_AMOUNT,
  PROP_PROTOCOL,
  PROP_VHOST,
  PROP_TAG,
  PROP_TLS,
  PROP_PEER,
  PROP_LOCAL,
  PROP_UDP,
  PROP_CONTEXT,
  PROP_PEER_WRITE_ALLOWANCE,
  PROP_PARENT,
  PROP_CHILD,
  PROP_NETWORK,
  PROP_EXTENSIONS,
  PROP_H2,
  PROP_PIPELINE_LEADER,
  PROP_IS_PIPELINE_LEADER,
  PROP_PIPELINE_QUEUE_DEPTH,
  PROP_SEND_PIPE_CHOKED,
  PROP_PEER_CERTIFICATE,
  PROP_TLS_SESSION_REUSED,
#ifdef LWS_WITH_CONMON
  PROP_CONMON,
#endif
};

static JSValue
lwsjs_socket_set(JSContext* ctx, JSValueConst this_val, JSValueConst value, int magic) {
  LWSSocket* s;
  JSValue ret = JS_UNDEFINED;

  if(!(s = lwsjs_socket_data2(ctx, this_val)))
    return JS_EXCEPTION;

  if(!s->wsi)
    return JS_ThrowInternalError(ctx, "LWSSocket has no wsi yet");

  switch(magic) {
    case PROP_BODY_PENDING: {
      lws_client_http_body_pending(s->wsi, (s->body_pending = to_int32(ctx, value)));
      break;
    }
  }

  return ret;
}

/* Scratch buffer sizing for lws_tls_peer_cert_info() - same oversized-buffer
   trick as lws-tls.c's X509_INFO_BUF_SIZE (see its own comment for why the
   `len` argument has to be computed this way). */
#define WSI_CERT_INFO_BUF_SIZE 8192

static BOOL
wsi_cert_info(struct lws* wsi, enum lws_tls_cert_info type, uint8_t* buf) {
  union lws_tls_cert_info_results* r = (union lws_tls_cert_info_results*)buf;

  return lws_tls_peer_cert_info(wsi, type, r, WSI_CERT_INFO_BUF_SIZE - sizeof(*r) + sizeof(r->ns.name)) == 0;
}

static JSValue
wsi_cert_info_string(struct lws* wsi, JSContext* ctx, enum lws_tls_cert_info type) {
  uint8_t buf[WSI_CERT_INFO_BUF_SIZE];
  union lws_tls_cert_info_results* r = (union lws_tls_cert_info_results*)buf;

  if(!wsi_cert_info(wsi, type, buf))
    return JS_UNDEFINED;

  return JS_NewStringLen(ctx, r->ns.name, (size_t)r->ns.len);
}

static JSValue
wsi_cert_info_date(struct lws* wsi, JSContext* ctx, enum lws_tls_cert_info type) {
  uint8_t buf[WSI_CERT_INFO_BUF_SIZE];
  union lws_tls_cert_info_results* r = (union lws_tls_cert_info_results*)buf;
  JSValue global, ctor, ret, arg;

  if(!wsi_cert_info(wsi, type, buf))
    return JS_UNDEFINED;

  global = JS_GetGlobalObject(ctx);
  ctor = JS_GetPropertyStr(ctx, global, "Date");
  JS_FreeValue(ctx, global);

  arg = JS_NewFloat64(ctx, (double)r->time * 1000.0);
  ret = JS_CallConstructor(ctx, ctor, 1, &arg);
  JS_FreeValue(ctx, ctor);

  return ret;
}

static JSValue
lwsjs_socket_get(JSContext* ctx, JSValueConst this_val, int magic) {
  LWSSocket* s;
  JSValue ret = JS_UNDEFINED;

  if(!(s = lwsjs_socket_data2(ctx, this_val)))
    return JS_EXCEPTION;

  if(!s->wsi && magic > PROP_PROTOCOL)
    return JS_UNDEFINED;

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

    case PROP_BUFFERED_AMOUNT: {
      ret = JS_NewInt64(ctx, (int64_t)s->write_buffered);
      break;
    }

    case PROP_PROTOCOL: {
      ret = s->proto ? JS_NewString(ctx, s->proto) : JS_NULL;
      break;
    }

    case PROP_VHOST: {
      struct lws_vhost* vho;

      if((vho = lws_get_vhost(s->wsi)))
        ret = lws_vhost_object(ctx, vho);

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

    case PROP_UDP: {
      const struct lws_udp* udp;

      if(lws_wsi_is_udp(s->wsi) && (udp = lws_get_udp(s->wsi))) {
        ret = JS_NewObjectProto(ctx, JS_NULL);

        JS_SetPropertyStr(ctx, ret, "peer", lwsjs_sockaddr46_wrap(ctx, udp->sa46));
        JS_SetPropertyStr(ctx, ret, "pending", lwsjs_sockaddr46_wrap(ctx, udp->sa46_pending));
        JS_SetPropertyStr(ctx, ret, "connected", JS_NewBool(ctx, udp->connected));
      } else {
        ret = JS_NULL;
      }

      break;
    }

#ifdef LWS_WITH_CONMON
    case PROP_CONMON: {
      /* Only meaningful for a client connection made with `conmon: true`
         (tls_connect_info_fromobj(), lws-tls.c, sets LCCSCF_CONMON) - lws
         only actually collects this data when that flag was set. Taken
         (not just read) here: lws_conmon_wsi_take() hands over ownership
         of the dns_results_copy allocation, which lws_conmon_release()
         then frees once we're done reading it a few lines down - the
         whole take+read+release happens synchronously in this one getter
         call, so there's no lifetime to manage past it. */
      struct lws_conmon conmon;

      lws_conmon_wsi_take(s->wsi, &conmon);

      ret = JS_NewObjectProto(ctx, JS_NULL);

      JS_SetPropertyStr(ctx, ret, "peer", lwsjs_sockaddr46_wrap(ctx, conmon.peer46));
      JS_SetPropertyStr(ctx, ret, "dnsUs", JS_NewUint32(ctx, conmon.ciu_dns));
      JS_SetPropertyStr(ctx, ret, "connectUs", JS_NewUint32(ctx, conmon.ciu_sockconn));
      JS_SetPropertyStr(ctx, ret, "tlsUs", JS_NewUint32(ctx, conmon.ciu_tls));
      JS_SetPropertyStr(ctx, ret, "firstByteUs", JS_NewUint32(ctx, conmon.ciu_txn_resp));
      JS_SetPropertyStr(ctx, ret, "dnsDisposition", JS_NewInt32(ctx, conmon.dns_disposition));

      if(conmon.pcol == LWSCONMON_PCOL_HTTP)
        JS_SetPropertyStr(ctx, ret, "httpResponse", JS_NewInt32(ctx, conmon.protocol_specific.http.response));

      lws_conmon_release(&conmon);
      break;
    }
#endif

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
      LWSContext* lws;

      if((lws = lwsjs_wsi_context(s->wsi)) && lws->info.extensions) {
        ret = JS_NewArray(ctx);

        for(int i = 0; lws->info.extensions[i].name; i++)
          JS_SetPropertyUint32(ctx, ret, i, JS_NewString(ctx, lws->info.extensions[i].name));
      }

      break;
    }

    case PROP_H2: {
      if(s->wsi)
        ret = JS_NewBool(ctx, lws_wsi_is_h2(s->wsi));

      break;
    }

    case PROP_PIPELINE_LEADER: {
      struct lws* wsi = s->wsi ? lws_get_txn_queue_leader(s->wsi) : NULL;

      if(wsi)
        ret = lwsjs_socket_get_or_create(ctx, wsi);

      break;
    }

    case PROP_IS_PIPELINE_LEADER: {
      if(s->wsi)
        ret = JS_NewBool(ctx, lws_wsi_is_txn_queue_leader(s->wsi));

      break;
    }

    case PROP_PIPELINE_QUEUE_DEPTH: {
      if(s->wsi)
        ret = JS_NewInt32(ctx, lws_get_txn_queue_depth(s->wsi));

      break;
    }

    case PROP_SEND_PIPE_CHOKED: {
      ret = JS_NewBool(ctx, lws_send_pipe_choked(s->wsi));
      break;
    }

    case PROP_TLS_SESSION_REUSED: {
      ret = JS_NewBool(ctx, lws_tls_session_is_reused(s->wsi));
      break;
    }

    case PROP_PEER_CERTIFICATE: {
      uint8_t buf[WSI_CERT_INFO_BUF_SIZE];
      union lws_tls_cert_info_results* r = (union lws_tls_cert_info_results*)buf;

      if(!lws_is_ssl(s->wsi) || !wsi_cert_info(s->wsi, LWS_TLS_CERT_INFO_VERIFIED, buf)) {
        ret = JS_NULL;
        break;
      }

      ret = JS_NewObjectProto(ctx, JS_NULL);

      JS_SetPropertyStr(ctx, ret, "verified", JS_NewBool(ctx, r->verified));
      JS_SetPropertyStr(ctx, ret, "subjectCN", wsi_cert_info_string(s->wsi, ctx, LWS_TLS_CERT_INFO_COMMON_NAME));
      JS_SetPropertyStr(ctx, ret, "issuerCN", wsi_cert_info_string(s->wsi, ctx, LWS_TLS_CERT_INFO_ISSUER_NAME));
      JS_SetPropertyStr(ctx, ret, "validFrom", wsi_cert_info_date(s->wsi, ctx, LWS_TLS_CERT_INFO_VALIDITY_FROM));
      JS_SetPropertyStr(ctx, ret, "validTo", wsi_cert_info_date(s->wsi, ctx, LWS_TLS_CERT_INFO_VALIDITY_TO));

      break;
    }

    case PROP_DISPATCHING: {
      ret = JS_NewBool(ctx, s->dispatching);
      break;
    }

    case PROP_DISPATCH_REASON: {
      ret = JS_NewInt32(ctx, s->dispatch_reason);
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
    JS_CFUNC_DEF("wantWrite", 0, lwsjs_socket_want_write),
    JS_CFUNC_DEF("write", 1, lwsjs_socket_write),
    JS_CFUNC_DEF("respond", 1, lwsjs_socket_respond),
    JS_CFUNC_DEF("transactionCompleted", 0, lwsjs_socket_transaction_completed),
    JS_CFUNC_DEF("longPollRxOnly", 0, lwsjs_socket_long_poll_rxonly),
    JS_CFUNC_DEF("close", 0, lwsjs_socket_close),
    JS_CFUNC_DEF("httpClientRead", 1, lwsjs_socket_http_client_read),
    JS_CFUNC_DEF("addHeader", 4, lwsjs_socket_add_header),
    JS_CFUNC_DEF("clientHttpMultipart", 4, lwsjs_socket_client_http_multipart),
    JS_CFUNC_DEF("setTimeout", 1, lwsjs_socket_set_timeout),
    JS_CGETSET_MAGIC_FLAGS_DEF("id", lwsjs_socket_get, 0, PROP_ID, 0),
    JS_CGETSET_MAGIC_FLAGS_DEF("tag", lwsjs_socket_get, 0, PROP_TAG, JS_PROP_CONFIGURABLE),
    JS_CGETSET_MAGIC_DEF("vhost", lwsjs_socket_get, 0, PROP_VHOST),
    JS_CGETSET_MAGIC_DEF("headers", lwsjs_socket_get, 0, PROP_HEADERS),
    JS_CGETSET_MAGIC_DEF("tls", lwsjs_socket_get, 0, PROP_TLS),
    JS_CGETSET_MAGIC_DEF("peer", lwsjs_socket_get, 0, PROP_PEER),
    JS_CGETSET_MAGIC_DEF("local", lwsjs_socket_get, 0, PROP_LOCAL),
    JS_CGETSET_MAGIC_DEF("udp", lwsjs_socket_get, 0, PROP_UDP),
    JS_CGETSET_MAGIC_FLAGS_DEF("fd", lwsjs_socket_get, 0, PROP_FD, JS_PROP_ENUMERABLE),
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
    JS_CGETSET_MAGIC_DEF("dispatching", lwsjs_socket_get, 0, PROP_DISPATCHING),
    JS_CGETSET_MAGIC_DEF("dispatchReason", lwsjs_socket_get, 0, PROP_DISPATCH_REASON),
    JS_CGETSET_MAGIC_DEF("redirectedToGet", lwsjs_socket_get, 0, PROP_REDIRECTED_TO_GET),
    JS_CGETSET_MAGIC_DEF("extensions", lwsjs_socket_get, 0, PROP_EXTENSIONS),
    JS_CGETSET_MAGIC_DEF("h2", lwsjs_socket_get, 0, PROP_H2),
    JS_CGETSET_MAGIC_DEF("bufferedAmount", lwsjs_socket_get, 0, PROP_BUFFERED_AMOUNT),
    JS_CGETSET_MAGIC_DEF("pipelineLeader", lwsjs_socket_get, 0, PROP_PIPELINE_LEADER),
    JS_CGETSET_MAGIC_DEF("isPipelineLeader", lwsjs_socket_get, 0, PROP_IS_PIPELINE_LEADER),
    JS_CGETSET_MAGIC_DEF("pipelineQueueDepth", lwsjs_socket_get, 0, PROP_PIPELINE_QUEUE_DEPTH),
    JS_CGETSET_MAGIC_DEF("sendPipeChoked", lwsjs_socket_get, 0, PROP_SEND_PIPE_CHOKED),
    JS_CGETSET_MAGIC_DEF("tlsSessionReused", lwsjs_socket_get, 0, PROP_TLS_SESSION_REUSED),
    JS_CGETSET_MAGIC_DEF("peerCertificate", lwsjs_socket_get, 0, PROP_PEER_CERTIFICATE),
#ifdef LWS_WITH_CONMON
    JS_CGETSET_MAGIC_DEF("conmon", lwsjs_socket_get, 0, PROP_CONMON),
#endif
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
