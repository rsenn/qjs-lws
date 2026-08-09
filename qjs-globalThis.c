#include "quickjs.h"

static JSValue
js_global_this(JSContext* ctx) {
  return JS_NewObject(ctx);
}

static const JSCFunctionListEntry global_methods[] = {
    JS_CFUNC_DEF("log", 0, js_console_log),
    JS_CFUNC_MAGIC_DEF("error", 0, js_console_error, (void*)JS_LOG_ERROR),
    JS_CFUNC_MAGIC_DEF("warn", 0, js_console_warn, (void*)JS_LOG_WARNING),
};

static int
init_module_globalThis(JSContext* ctx, JSModuleDef* m) {
  JSValue global_this = js_global_this(ctx);
  if(JS_IsException(global_this)) {
    return -1;
  }

  if(JS_SetPropertyFunctionList(ctx, global_this, global_methods, countof(global_methods), 0) < 0) {
    return -1;
  }

  if(JS_SetModuleExport(ctx, m, "globalThis", global_this) < 0) {
    JS_FreeValue(ctx, global_this);
    return -1;
  }

  return 0;
}

JSModuleDef*
js_init_module_globalThis(JSContext* ctx, const char* module_name) {
  return JS_NewCModule(ctx, module_name, init_module_globalThis);
}