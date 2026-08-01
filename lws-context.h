#ifndef QJS_LWS_CONTEXT_H
#define QJS_LWS_CONTEXT_H

#include <quickjs.h>
#include <list.h>
#include <libwebsockets.h>

#ifdef USE_EPOLL
typedef struct LWSEpoll LWSEpoll;
#endif

typedef struct LWSContext {
  struct lws_context* ctx;
  struct lws_context_creation_info info;
  JSContext* js;
  struct list_head handlers;
  /* Live ctx.schedule() timers (lws-context.c: LWSTimer), so .cancel()
     can safely no-op on a stale handle (already fired or already
     cancelled) instead of dereferencing a freed pointer - same list+lookup
     idiom as `handlers`/iohandler_find() above. */
  struct list_head timers;
  /* Holds whatever os.setTimeout() returned - an opaque JS "OSTimer"
     object in this quickjs-libc, not a plain numeric id - so it must be
     passed back to os.clearTimeout() as-is, never coerced to a number.
     JS_UNDEFINED means no service tick is currently scheduled. */
  JSValue service_timer_id;
#ifdef USE_EPOLL
  LWSEpoll* epoll;
#endif
} LWSContext;

typedef struct LWSHandlers {
  JSContext* ctx;
  void* obj;
  JSValue callback, callbacks[LWS_CALLBACK_USER + 1];
} LWSHandlers;

extern JSClassID lwsjs_context_class_id;

int lwsjs_context_init(JSContext*, JSModuleDef*);
void lwsjs_context_creation_info_fromobj(JSContext*, JSValueConst, struct lws_context_creation_info*);
void lwsjs_context_creation_info_free(JSRuntime*, struct lws_context_creation_info*);

static inline LWSContext*
lwsjs_context_data(JSValueConst value) {
  return JS_GetOpaque(value, lwsjs_context_class_id);
}

static inline LWSContext*
lwsjs_context_data2(JSContext* ctx, JSValueConst value) {
  return JS_GetOpaque2(ctx, value, lwsjs_context_class_id);
}

static inline JSContext*
lwsjs_context_jsctx(LWSContext* lc) {
  return lc ? lc->js : NULL;
}

static inline LWSContext*
lwsjs_context_fromlws(struct lws_context* context) {
  void* obj = lws_context_user(context);

  return JS_GetOpaque(JS_MKPTR(JS_TAG_OBJECT, obj), lwsjs_context_class_id);
}

static inline struct lws_context*
lws_context_data(JSValueConst value) {
  LWSContext* lws;

  if((lws = lwsjs_context_data(value)))
    return lws->ctx;

  return 0;
}

static inline LWSContext*
lwsjs_wsi_context(struct lws* wsi) {
  struct lws_context* lws;

  if(wsi && (lws = lws_get_context(wsi))) {
    void* obj;

    if((obj = lws_context_user(lws)))
      return lwsjs_context_data(JS_MKPTR(JS_TAG_OBJECT, obj));
  }

  return 0;
}

static inline JSContext*
lwsjs_wsi_jscontext(struct lws* wsi) {
  struct lws_protocols const* pro = lws_get_protocol(wsi);
  LWSHandlers* handlers = pro ? pro->user : 0;
  JSContext* ctx = handlers ? handlers->ctx : 0;

  if(!ctx) {
    LWSContext* lws;

    if((lws = lwsjs_wsi_context(wsi)))
      ctx = lws->js;
  }

  return ctx;
}

#endif /* QJS_LWS_CONTEXT_H */
