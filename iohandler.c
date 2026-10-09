#include "iohandler.h"
#include "js-utils.h"

typedef struct {
  struct list_head link;
  int fd;
  BOOL write;
} HandlerFunction;

/* os.setReadHandler/os.setWriteHandler; the `os` module namespace is loaded
   once per LWSContext and cached in lws->os (freed in context_free()). */
static JSValue
iohandler_function(LWSContext* lws, BOOL write) {
  if(JS_IsUndefined(lws->os)) {
    JSValue os = js_module_namespace_sync(lws->js, "os");

    if(JS_IsException(os))
      return os;

    lws->os = os;
  }

  return JS_GetPropertyStr(lws->js, lws->os, write ? "setWriteHandler" : "setReadHandler");
}

static HandlerFunction*
iohandler_find(LWSContext* lws, int fd, BOOL write) {
  struct list_head* el;

  list_for_each(el, &lws->handlers) {
    HandlerFunction* hf = list_entry(el, HandlerFunction, link);

    if(hf->fd == fd && hf->write == write)
      return hf;
  }

  return NULL;
}

static HandlerFunction*
iohandler_add(LWSContext* lws, int fd, BOOL write) {
  HandlerFunction* hf;

  if((hf = iohandler_find(lws, fd, write)))
    return hf;

  if((hf = js_malloc(lws->js, sizeof(HandlerFunction)))) {
    hf->fd = fd;
    hf->write = write;

    DEBUG("%s %d %s", __func__, fd, write ? "write" : "read");

    list_add(&hf->link, &lws->handlers);
    return hf;
  }

  return 0;
}

static BOOL
iohandler_remove(LWSContext* lws, int fd, BOOL write) {
  HandlerFunction* hf;

  if((hf = iohandler_find(lws, fd, write))) {
    DEBUG("%s %d %s", __func__, fd, write ? "write" : "read");

    list_del(&hf->link);
    js_free(lws->js, hf);
    return TRUE;
  }

  return FALSE;
}

void
iohandler_set(LWSContext* lws, int fd, JSValueConst handler, BOOL write) {
  JSValue fn = iohandler_function(lws, write);
  JSValue args[2] = {JS_NewInt32(lws->js, fd), handler};
  BOOL add = JS_IsFunction(lws->js, handler);

  DEBUG("%s %d %s", write ? "os.setWriteHandler" : "os.setReadHandler", fd, add ? "[function]" : "NULL");

  if(add)
    iohandler_add(lws, fd, write);
  else
    iohandler_remove(lws, fd, write);

  JSValue ret = JS_Call(lws->js, fn, JS_NULL, 2, args);
  JS_FreeValue(lws->js, ret);
  JS_FreeValue(lws->js, fn);
}

void
iohandler_clear(LWSContext* lws, int fd) {
  iohandler_set(lws, fd, JS_NULL, FALSE);
  iohandler_set(lws, fd, JS_NULL, TRUE);
}

void
iohandler_cleanup(LWSContext* lws) {
  struct list_head *el, *next;

  list_for_each_safe(el, next, &lws->handlers) {
    HandlerFunction* hf = list_entry(el, HandlerFunction, link);

    DEBUG("delete handler (fd = %d, %s)", hf->fd, hf->write ? "write" : "read");

    iohandler_set(lws, hf->fd, JS_NULL, hf->write);
  }
}
