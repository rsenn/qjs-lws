#ifndef QJS_LWS_VHOST_OPTION_H
#define QJS_LWS_VHOST_OPTION_H

#include <quickjs.h>
#include <libwebsockets.h>

struct lws_protocol_vhost_options* lwsjs_vhost_option_from(JSContext*, JSValueConst);
struct lws_protocol_vhost_options* lwsjs_vhost_options_from(JSContext*, JSValueConst);
struct lws_protocol_vhost_options* lwsjs_vhost_options_fromfree(JSContext*, JSValue);
void lwsjs_vhost_options_free(JSRuntime*, struct lws_protocol_vhost_options*);

#endif
