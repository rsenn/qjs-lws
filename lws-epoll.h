#ifndef QJS_LWS_EPOLL_H
#define QJS_LWS_EPOLL_H

#include "lws-context.h"

/* Add or modify epoll interest for fd (POLLIN/POLLOUT bitmask). Lazily
   creates the LWSContext's epoll instance and its single quickjs-libc
   read-handler registration on first use. */
void lws_epoll_ctl(LWSContext*, int fd, int events);

/* Drop fd from the epoll instance. */
void lws_epoll_del(LWSContext*, int fd);

/* Tear down the epoll instance: close epfd and unregister its read handler. */
void lws_epoll_destroy(LWSContext*);

#endif /* defined QJS_LWS_EPOLL_H */
