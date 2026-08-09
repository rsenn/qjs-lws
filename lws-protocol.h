#ifndef QJS_LWS_PROTOCOL_H
#define QJS_LWS_PROTOCOL_H

#include <quickjs.h>
#include <libwebsockets.h>

int lwsjs_callback_find(const char*);
const char* lwsjs_callback_name(enum lws_callback_reasons);
JSValue lwsjs_protocol_obj(JSContext*, const struct lws_protocols*);
int lwsjs_protocol_from(JSContext*, JSValueConst, struct lws_protocols*);
const struct lws_protocols* lwsjs_protocols_fromarray(JSContext*, JSValueConst);
void lwsjs_protocols_free(JSRuntime*, struct lws_protocols*);
void lwsjs_protocol_free(JSRuntime*, struct lws_protocols*);
int lwsjs_callback_dummy(struct lws*, enum lws_callback_reasons, void*, void*, size_t);
int lwsjs_callback_js(struct lws*, enum lws_callback_reasons, void*, void*, size_t);
int lwsjs_callback_pollfd(struct lws*, enum lws_callback_reasons, void*, void*, size_t);
int lwsjs_callback_protocol(struct lws*, enum lws_callback_reasons, void*, void*, size_t);

#endif
