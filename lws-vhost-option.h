#ifndef QJS_LWS_VHOST_OPTION_H
#define QJS_LWS_VHOST_OPTION_H

#include <quickjs.h>
#include <libwebsockets.h>
#include "lws.h"

struct lws_protocol_vhost_options* lwsjs_vhost_option_from(JSContext* ctx, JSValueConst obj);

struct lws_protocol_vhost_options* lwsjs_vhost_options_from(JSContext* ctx, JSValueConst value);

struct lws_protocol_vhost_options* lwsjs_vhost_options_fromfree(JSContext* ctx, JSValue value);

void lwsjs_vhost_options_free(JSRuntime* rt, struct lws_protocol_vhost_options* vho);

#endif
