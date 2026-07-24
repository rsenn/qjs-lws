#ifndef QJS_LWS_MOUNT_H
#define QJS_LWS_MOUNT_H

#include <quickjs.h>
#include <libwebsockets.h>

struct lws_http_mount* lwsjs_mount_from(JSContext*, JSValueConst, const char* name);
const struct lws_http_mount* lwsjs_mounts_from(JSContext*, JSValueConst);
void lwsjs_mounts_free(JSRuntime*, struct lws_http_mount*);

#endif
