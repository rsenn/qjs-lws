#ifndef QJS_LWS_H
#define QJS_LWS_H

#include <quickjs.h>
#include <cutils.h>
#include <list.h>
#include <ctype.h>
#include <libwebsockets.h>

#if __SIZEOF_POINTER__ == 8
#define intptr int64_t
#elif __SIZEOF_POINTER__ == 4
#define intptr int32_t
#endif

#ifdef DEBUG_OUTPUT
#define DEBUG(fmt, x...) lwsl_user("\x1b[0m" fmt, x)
#define DEBUG_WSI(wsi, fmt, x...) lwsl_user("wsi#%d " fmt, socket_getid(wsi), x)
#else
#define DEBUG(fmt, x...)
#define DEBUG_WSI(wsi, fmt, x...)
#endif

#define MAX(a, b) ((a) > (b) ? (a) : (b))
#define MIN(a, b) ((a) < (b) ? (a) : (b))
#define CLAMP(a, min, max) MIN(MAX((a), (min)), (max))
#define WRAP(n, len) ((n) < 0 ? (n) + (len) : (n))

#define VISIBLE __attribute__((visibility("default")))

#define JS_ATOM_MAX_INT ((1u << 31) - 1)

size_t camelize(char*, size_t, const char*);
size_t decamelize(char*, size_t, const char*);
size_t log_escape(char*, size_t, const void*, size_t);

int lwsjs_html_process_args(JSContext*, struct lws_process_html_args*, int, JSValueConst[]);
int lwsjs_spa_init(JSContext*, JSModuleDef*);
void lwsjs_get_lws_callbacks(JSContext*, JSValueConst, JSValue[], size_t);

int lwsjs_init(JSContext*, JSModuleDef*);
JSModuleDef* js_init_module(JSContext*, const char*);

static inline int
clz(uint32_t i) {
  int ret = 0;

  for(ret = 0; !(i & 0x80000000); ++ret)
    i <<= 1;

  return ret;
}

static inline size_t
find_charset(const char* s, const char* set, size_t setlen) {
  size_t i, j;

  for(i = 0; s[i]; ++i)
    for(j = 0; j < setlen; ++j)
      if(s[i] == set[j])
        return i;

  return i;
}

static inline size_t
findb_charset(const char* s, size_t len, const char* set, size_t setlen) {
  size_t i, j;

  for(i = 0; i < len; ++i)
    for(j = 0; j < setlen; ++j)
      if(s[i] == set[j])
        return i;

  return i;
}

static inline int
list_size(struct list_head* list) {
  struct list_head* el;
  int i = 0;

  list_for_each(el, list) { ++i; }

  return i;
}

/* The reasons that carry a payload worth logging under LLL_USER - every
   client/server receive path across WS, HTTP, MQTT, and raw (proxy). */
static inline BOOL
is_rx_reason(enum lws_callback_reasons reason) {
  switch(reason) {
    case LWS_CALLBACK_CLIENT_RECEIVE:
    case LWS_CALLBACK_CLIENT_RECEIVE_PONG:
    case LWS_CALLBACK_MQTT_CLIENT_RX:
    case LWS_CALLBACK_RAW_PROXY_CLI_RX:
    case LWS_CALLBACK_RAW_PROXY_SRV_RX:
    case LWS_CALLBACK_RAW_RX:
    case LWS_CALLBACK_RAW_RX_FILE:
    case LWS_CALLBACK_RECEIVE:
    case LWS_CALLBACK_RECEIVE_CLIENT_HTTP:
    case LWS_CALLBACK_RECEIVE_CLIENT_HTTP_READ:
    case LWS_CALLBACK_RECEIVE_PONG: return TRUE;
    default: return FALSE;
  }
}

static inline BOOL
is_pollfd_reason(enum lws_callback_reasons reason) {
  switch(reason) {
    case LWS_CALLBACK_LOCK_POLL:
    case LWS_CALLBACK_UNLOCK_POLL:
    case LWS_CALLBACK_ADD_POLL_FD:
    case LWS_CALLBACK_DEL_POLL_FD:
    case LWS_CALLBACK_CHANGE_MODE_POLL_FD: return TRUE;
    default: return FALSE;
  }
}

static inline BOOL
is_writeable_reason(enum lws_callback_reasons reason) {
  switch(reason) {
    case LWS_CALLBACK_HTTP_WRITEABLE:
    case LWS_CALLBACK_CLIENT_HTTP_WRITEABLE:
    case LWS_CALLBACK_SERVER_WRITEABLE:
    case LWS_CALLBACK_CLIENT_WRITEABLE:
    case LWS_CALLBACK_RAW_PROXY_CLI_WRITEABLE:
    case LWS_CALLBACK_RAW_PROXY_SRV_WRITEABLE:
    case LWS_CALLBACK_RAW_WRITEABLE:
    case LWS_CALLBACK_RAW_WRITEABLE_FILE:
    case LWS_CALLBACK_MQTT_CLIENT_WRITEABLE:
    case LWS_CALLBACK_CLIENT_APPEND_HANDSHAKE_HEADER: return TRUE;
    default: return FALSE;
  }
}
static inline BOOL
is_loadcerts_reason(enum lws_callback_reasons reason) {
  switch(reason) {
    case LWS_CALLBACK_OPENSSL_LOAD_EXTRA_CLIENT_VERIFY_CERTS:
    case LWS_CALLBACK_OPENSSL_LOAD_EXTRA_SERVER_VERIFY_CERTS: return TRUE;
    default: return FALSE;
  }
}

static inline BOOL
is_headers_reason(enum lws_callback_reasons reason) {
  switch(reason) {
    case LWS_CALLBACK_FILTER_PROTOCOL_CONNECTION:
    case LWS_CALLBACK_CLIENT_FILTER_PRE_ESTABLISH:
    case LWS_CALLBACK_FILTER_HTTP_CONNECTION:
    case LWS_CALLBACK_HTTP_CONFIRM_UPGRADE:
    case LWS_CALLBACK_ESTABLISHED_CLIENT_HTTP: return TRUE;
    default: return FALSE;
  }
}

/* LWS_CALLBACK_CHECK_ACCESS_RIGHTS is deliberately excluded here even
   though it shares struct lws_process_html_args with the other two - its
   post-callback pointer-advance step (lws-protocol.c) only makes sense
   for a reason whose JS handler is given a real writable scratch buffer
   and reports back how many bytes it used; CHECK_ACCESS_RIGHTS's last arg
   is the auth_mask bitmask instead (see its own case in
   lwsjs_callback_protocol()), and lws itself never reads args.p back
   after this callback returns (server.c) - there's nothing to advance. */
static inline BOOL
is_htmlargs_reason(enum lws_callback_reasons reason) {
  switch(reason) {
    case LWS_CALLBACK_ADD_HEADERS:
    case LWS_CALLBACK_PROCESS_HTML: return TRUE;
    default: return FALSE;
  }
}

static inline BOOL
is_closed_reason(enum lws_callback_reasons reason) {
  switch(reason) {
    case LWS_CALLBACK_CLOSED_HTTP:
    case LWS_CALLBACK_CLOSED_CLIENT_HTTP:
    case LWS_CALLBACK_CLOSED:
    case LWS_CALLBACK_WS_PEER_INITIATED_CLOSE:
    case LWS_CALLBACK_CLIENT_CLOSED:
    case LWS_CALLBACK_CLIENT_CONNECTION_ERROR:
    case LWS_CALLBACK_RAW_PROXY_CLI_CLOSE:
    case LWS_CALLBACK_RAW_PROXY_SRV_CLOSE:
    case LWS_CALLBACK_RAW_CLOSE:
    case LWS_CALLBACK_RAW_CLOSE_FILE: return TRUE;
    default: return FALSE;
  }
}

static inline BOOL
is_connected_reason(enum lws_callback_reasons reason) {
  switch(reason) {
    case LWS_CALLBACK_ESTABLISHED_CLIENT_HTTP:
    case LWS_CALLBACK_ESTABLISHED:
    case LWS_CALLBACK_CLIENT_ESTABLISHED:
    case LWS_CALLBACK_RAW_PROXY_CLI_ADOPT:
    case LWS_CALLBACK_RAW_PROXY_SRV_ADOPT:
    case LWS_CALLBACK_RAW_ADOPT:
    case LWS_CALLBACK_RAW_CONNECTED:
    case LWS_CALLBACK_RAW_ADOPT_FILE:
    case LWS_CALLBACK_MQTT_CLIENT_ESTABLISHED: return TRUE;
    default: return FALSE;
  }
}

static inline BOOL
is_completed_reason(enum lws_callback_reasons reason) {
  switch(reason) {
    case LWS_CALLBACK_HTTP_BODY_COMPLETION:
    case LWS_CALLBACK_HTTP_FILE_COMPLETION:
    case LWS_CALLBACK_COMPLETED_CLIENT_HTTP: return TRUE;
    default: return FALSE;
  }
}

static inline BOOL
is_drop_reason(enum lws_callback_reasons reason) {
  switch(reason) {
    case LWS_CALLBACK_HTTP_DROP_PROTOCOL:
    case LWS_CALLBACK_CLIENT_HTTP_DROP_PROTOCOL:
    case LWS_CALLBACK_WS_SERVER_DROP_PROTOCOL:
    case LWS_CALLBACK_WS_CLIENT_DROP_PROTOCOL:
    case LWS_CALLBACK_RAW_PROXY_CLI_DROP_PROTOCOL:
    case LWS_CALLBACK_RAW_PROXY_SRV_DROP_PROTOCOL:
    case LWS_CALLBACK_RAW_SKT_DROP_PROTOCOL:
    case LWS_CALLBACK_RAW_FILE_DROP_PROTOCOL:
    case LWS_CALLBACK_MQTT_DROP_PROTOCOL: return TRUE;
    default: return FALSE;
  }
}

static inline BOOL
is_bind_reason(enum lws_callback_reasons reason) {
  switch(reason) {
    case LWS_CALLBACK_HTTP_BIND_PROTOCOL:
    case LWS_CALLBACK_CLIENT_HTTP_BIND_PROTOCOL:
    case LWS_CALLBACK_WS_SERVER_BIND_PROTOCOL:
    case LWS_CALLBACK_WS_CLIENT_BIND_PROTOCOL:
    case LWS_CALLBACK_RAW_PROXY_CLI_BIND_PROTOCOL:
    case LWS_CALLBACK_RAW_PROXY_SRV_BIND_PROTOCOL:
    case LWS_CALLBACK_RAW_SKT_BIND_PROTOCOL:
    case LWS_CALLBACK_RAW_FILE_BIND_PROTOCOL: return TRUE;
    default: return FALSE;
  }
}
#endif /* defined QJS_LWS_H */
