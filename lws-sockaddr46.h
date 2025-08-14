#ifndef QJS_LWS_SOCKADDR46_H
#define QJS_LWS_SOCKADDR46_H

#include <quickjs.h>

extern JSClassID lwsjs_sockaddr46_class_id;

int lwsjs_sockaddr46_init(JSContext*, JSModuleDef*);
JSValue lwsjs_sockaddr46_value(JSContext*, JSValueConst);
lws_sockaddr46* lwsjs_sockaddr46_data(JSContext*, JSValueConst);

#endif
