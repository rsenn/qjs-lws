# QuickJS native binding cheat sheet

Curated excerpt of `quickjs.h` (~1041 lines total) - just the signatures
that recur across almost every hand-written C binding, each with the
ownership/lifecycle rule that actually causes bugs when missed. For
anything not covered here (an exact struct layout, a rarer function,
BigInt handling, ...), `READ: quickjs.h` for the real thing - this is a
starting point, not a replacement.

## Values & conversion

```c
JSValue JS_NewBool(JSContext *ctx, JS_BOOL val);
JSValue JS_NewInt32(JSContext *ctx, int32_t val);
JSValue JS_NewUint32(JSContext *ctx, uint32_t val);
JSValue JS_NewFloat64(JSContext *ctx, double d);

int JS_ToInt32(JSContext *ctx, int32_t *pres, JSValueConst val);
int JS_ToInt64(JSContext *ctx, int64_t *pres, JSValueConst val);
```

`JSValueConst` in an argument position means "borrowed, don't free it."
`JS_ToInt32`/`JS_ToInt64` return `-1` and throw on failure (e.g. the value
isn't coercible to a number) - check the return, not just `*pres`.

## Exceptions are values, not control flow

```c
JSValue JS_ThrowTypeError(JSContext *ctx, const char *fmt, ...);
JSValue JS_ThrowRangeError(JSContext *ctx, const char *fmt, ...);
JSValue JS_ThrowInternalError(JSContext *ctx, const char *fmt, ...);
JS_BOOL JS_IsException(JSValueConst v);
void JS_FreeValue(JSContext *ctx, JSValue v);
```

There's no C-level `try`/`catch`. A C function signals failure by calling
one of the `JS_Throw*` functions (which return `JS_EXCEPTION` as a
convenience - `return JS_ThrowTypeError(ctx, "...")` is the idiom) and
every call that can fail must be checked (`if (JS_IsException(v)) goto
fail;`) and propagated up. A `JSValue` a function *returns or stores*
(not just borrows) must eventually reach `JS_FreeValue(ctx, v)`, or
`JS_FreeValueRT` from a finalizer, which only has a `JSRuntime*`, not a
`JSContext*`.

## Classes & opaque data

```c
JSClassID JS_NewClassID(JSClassID *pclass_id);
int JS_NewClass(JSRuntime *rt, JSClassID class_id, const JSClassDef *class_def);
JSValue JS_NewObjectProtoClass(JSContext *ctx, JSValueConst proto, JSClassID class_id);
void JS_SetOpaque(JSValue obj, void *opaque);
void *JS_GetOpaque(JSValueConst obj, JSClassID class_id);
void *JS_GetOpaque2(JSContext *ctx, JSValueConst obj, JSClassID class_id);
```

The whole mechanism for attaching a C struct to a JS object: allocate a
`JSClassID` once (module init), register it with `JS_NewClass()` (which
takes a `JSClassDef` with a `.finalizer`), then in the constructor
`JS_NewObjectProtoClass()` + `JS_SetOpaque()`. Getters/setters/methods
retrieve it with `JS_GetOpaque2()` (throws on the wrong class) rather
than the unchecked `JS_GetOpaque()`. See `examples/point.c` for the
complete, working four-piece shape.

## Memory

```c
void *js_malloc(JSContext *ctx, size_t size);
void *js_mallocz(JSContext *ctx, size_t size);
void js_free(JSContext *ctx, void *ptr);
void js_free_rt(JSRuntime *rt, void *ptr);
```

`js_malloc`/`js_mallocz`/`js_free` are context-bound; `js_free_rt` is
runtime-bound, needed in a finalizer (which only has `JSRuntime*`, not
`JSContext*`). Not libc `malloc`/`free`, and never mix a `js_malloc`'d
pointer with libc `free()` or vice versa.

## ArrayBuffer in/out

```c
JSValue JS_NewArrayBuffer(JSContext *ctx, uint8_t *buf, size_t len,
                           JSFreeArrayBufferDataFunc *free_func, void *opaque,
                           JS_BOOL is_shared);
uint8_t *JS_GetArrayBuffer(JSContext *ctx, size_t *psize, JSValueConst obj);
```

`JS_GetArrayBuffer` returns a pointer *into* the buffer - don't free it;
freeing the buffer is the ArrayBuffer object's own job, via whatever
`free_func` it was created with. To hand back an owned buffer: allocate
with `js_malloc`, fill it, then `JS_NewArrayBuffer(ctx, buf, actual_len,
free_func, NULL, FALSE)` with a `free_func` that calls `js_free_rt` on
the pointer - see `qjs-modules/quickjs-arraybuffer-sink.c`'s
`js_arraybuffer_sink_free`/`METHOD_FLUSH` for the exact pattern:

```c
static void js_arraybuffer_sink_free(JSRuntime *rt, void *opaque, void *ptr) {
  js_free_rt(rt, ptr);
}
/* ... */
ret = JS_NewArrayBuffer(ctx, s->buf, s->size, js_arraybuffer_sink_free, 0, FALSE);
```

Pass the *actual* used length, not whatever bound you allocated with (a
compression call's worst-case size, e.g.).

## Module registration

```c
#define JS_CFUNC_DEF(name, length, func1) { ... }
#define JS_CGETSET_MAGIC_DEF(name, fgetter, fsetter, magic) { ... }
```

`JSCFunctionListEntry` arrays built with these macros are what
`JS_SetPropertyFunctionList()` installs on an object/prototype - see
`examples/fib.c` (plain function export) and `examples/point.c` (class
methods + a magic-numbered getter/setter pair) for both in use.
