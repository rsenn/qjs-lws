/**
 * @file js-utils.h
 */
#ifndef JS_UTILS_H
#define JS_UTILS_H

#include <quickjs.h>
#include <cutils.h>
#include <list.h>

typedef JSValue CClosureFunc(JSContext*, JSValueConst, int, JSValueConst[], int, void*);

JSValue js_function_cclosure(JSContext*, CClosureFunc* func, int length, int magic, void* opaque, void (*opaque_finalize)(void*));

#endif /* JS_UTILS_H */
