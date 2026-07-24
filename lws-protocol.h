#ifndef QJS_LWS_PROTOCOL_H
#define QJS_LWS_PROTOCOL_H

#include <quickjs.h>
#include <libwebsockets.h>

JSValue lwsjs_protocol_obj(JSContext*, const struct lws_protocols*);
struct lws_protocols lwsjs_protocol_from(JSContext*, JSValueConst);
const struct lws_protocols* lwsjs_protocols_fromarray(JSContext*, JSValueConst);
void lwsjs_protocols_free(JSRuntime*, struct lws_protocols*);
void lwsjs_protocol_free(JSRuntime*, struct lws_protocols*);
int lwsjs_protocol_callback(struct lws*, enum lws_callback_reasons, void*, void*, size_t);
int lwsjs_dummy_callback(struct lws*, enum lws_callback_reasons, void*, void*, size_t);
int lwsjs_js_callback(struct lws*, enum lws_callback_reasons, void*, void*, size_t);
int lwsjs_pollfd_callback(struct lws*, enum lws_callback_reasons, void*, void*, size_t);

#endif
