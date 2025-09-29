#ifndef IOHANDLER_H
#define IOHANDLER_H

#include "lws-context.h"
#include <quickjs.h>
#include <cutils.h>
#include <list.h>

typedef struct {
  struct list_head link;
  int fd;
  BOOL write;
} HandlerFunction;

static JSValue iohandler_functions[2] = {JS_UNDEFINED, JS_UNDEFINED};

static JSValue
iohandler_function(JSContext* ctx, BOOL write) {
  if(!JS_IsUndefined(iohandler_functions[write]))
    return JS_DupValue(ctx, iohandler_functions[write]);

  JSValue glob = JS_GetGlobalObject(ctx);
  const char* str = "globalThis.io = await import('io');";

  JS_Eval(ctx, str, strlen(str), "-", JS_EVAL_TYPE_MODULE);

  JSValue os = JS_GetPropertyStr(ctx, glob, "io");

  JS_FreeValue(ctx, glob);
  JSValue fn = JS_GetPropertyStr(ctx, os, write ? "setWriteHandler" : "setReadHandler");
  JS_FreeValue(ctx, os);
  return fn;
}

static HandlerFunction*
iohandler_find(LWSContext* lc, int fd, BOOL write) {
  struct list_head* el;

  list_for_each(el, &lc->handlers) {
    HandlerFunction* hf = list_entry(el, HandlerFunction, link);

    if(hf->fd == fd && hf->write == write)
      return hf;
  }

  return NULL;
}

static HandlerFunction*
iohandler_add(LWSContext* lc, int fd, BOOL write) {
  HandlerFunction* hf;

  if((hf = iohandler_find(lc, fd, write)))
    return hf;

  if((hf = js_malloc(lc->js, sizeof(HandlerFunction)))) {
    hf->fd = fd;
    hf->write = write;

    DEBUG("%s %d %s", __func__, fd, write ? "write" : "read");

    list_add(&hf->link, &lc->handlers);
    return hf;
  }

  return 0;
}

static BOOL
iohandler_remove(LWSContext* lc, int fd, BOOL write) {
  HandlerFunction* hf;

  if((hf = iohandler_find(lc, fd, write))) {
    DEBUG("%s %d %s", __func__, fd, write ? "write" : "read");

    list_del(&hf->link);
    js_free(lc->js, hf);
    return TRUE;
  }

  return FALSE;
}

static void
iohandler_set(LWSContext* lc, int fd, JSValueConst handler, BOOL write) {
  JSValue fn = iohandler_function(lc->js, write);
  JSValue args[2] = {JS_NewInt32(lc->js, fd), handler};
  BOOL add = JS_IsFunction(lc->js, handler);

  DEBUG("%s %d %s", write ? "os.setWriteHandler" : "os.setReadHandler", fd, add ? "[function]" : "NULL");

  if(add)
    iohandler_add(lc, fd, write);
  else
    iohandler_remove(lc, fd, write);

  JSValue ret = JS_Call(lc->js, fn, JS_NULL, 2, args);
  JS_FreeValue(lc->js, ret);
  JS_FreeValue(lc->js, fn);
}

static void
iohandler_clear(LWSContext* lc, int fd) {
  iohandler_set(lc, fd, JS_NULL, FALSE);
  iohandler_set(lc, fd, JS_NULL, TRUE);
}

static void
iohandler_cleanup(LWSContext* lc) {
  struct list_head *el, *next;

  list_for_each_safe(el, next, &lc->handlers) {
    HandlerFunction* hf = list_entry(el, HandlerFunction, link);

    DEBUG("delete handler (fd = %d, %s)", hf->fd, hf->write ? "write" : "read");

    iohandler_set(lc, hf->fd, JS_NULL, hf->write);
  }
}

#endif /* defined IOHANDLER_H */
