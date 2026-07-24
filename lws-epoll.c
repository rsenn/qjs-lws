#ifdef USE_EPOLL
#include "lws-epoll.h"
#include "iohandler.h"
#include "js-utils.h"

#include <sys/epoll.h>
#include <poll.h>
#include <unistd.h>

typedef struct {
  struct list_head link;
  int fd;
  int events; /* POLLIN/POLLOUT interest, as registered by lws */
} LWSEpollFd;

struct LWSEpoll {
  int epfd;
  LWSContext* lws;
  struct list_head fds;
};

static LWSEpollFd*
epoll_fd_find(LWSEpoll* ep, int fd) {
  struct list_head* el;

  list_for_each(el, &ep->fds) {
    LWSEpollFd* e = list_entry(el, LWSEpollFd, link);

    if(e->fd == fd)
      return e;
  }

  return NULL;
}

static void
epoll_drain(LWSEpoll* ep) {
  struct epoll_event events[32];
  int i, n;

  for(;;) {
    n = epoll_wait(ep->epfd, events, countof(events), 0);

    if(n <= 0)
      break;

    for(i = 0; i < n; i++) {
      LWSEpollFd* e = epoll_fd_find(ep, events[i].data.fd);
      struct lws_pollfd pfd = {
          .fd = events[i].data.fd,
          .events = e ? e->events : 0,
          .revents = 0,
      };

      if(events[i].events & EPOLLIN)
        pfd.revents |= POLLIN;
      if(events[i].events & EPOLLOUT)
        pfd.revents |= POLLOUT;
      if(events[i].events & (EPOLLERR | EPOLLHUP))
        pfd.revents |= POLLHUP;

      lws_service_fd(ep->lws->ctx, &pfd);
    }

    if(n < (int)countof(events))
      break;
  }
}

static JSValue
epoll_readable(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst* argv, int magic, void* opaque) {
  epoll_drain(opaque);
  return JS_UNDEFINED;
}

static LWSEpoll*
epoll_new(LWSContext* lws) {
  LWSEpoll* ep;

  if(!(ep = js_mallocz(lws->js, sizeof(LWSEpoll))))
    return NULL;

  if((ep->epfd = epoll_create1(EPOLL_CLOEXEC)) < 0) {
    js_free(lws->js, ep);
    return NULL;
  }

  ep->lws = lws;
  init_list_head(&ep->fds);

  JSValue fn = js_function_cclosure(lws->js, epoll_readable, 0, 0, ep, NULL);
  iohandler_set(lws, ep->epfd, fn, FALSE);
  JS_FreeValue(lws->js, fn);

  return ep;
}

void
lws_epoll_ctl(LWSContext* lws, int fd, int events) {
  LWSEpoll* ep;
  LWSEpollFd* e;
  struct epoll_event ev = {0};

  if(!(ep = lws->epoll) && !(ep = lws->epoll = epoll_new(lws)))
    return;

  if(events & POLLIN)
    ev.events |= EPOLLIN;
  if(events & POLLOUT)
    ev.events |= EPOLLOUT;
  ev.data.fd = fd;

  if((e = epoll_fd_find(ep, fd))) {
    e->events = events;
    epoll_ctl(ep->epfd, EPOLL_CTL_MOD, fd, &ev);
  } else if((e = js_mallocz(lws->js, sizeof(LWSEpollFd)))) {
    e->fd = fd;
    e->events = events;
    list_add(&e->link, &ep->fds);
    epoll_ctl(ep->epfd, EPOLL_CTL_ADD, fd, &ev);
  }
}

void
lws_epoll_del(LWSContext* lws, int fd) {
  LWSEpoll* ep;
  LWSEpollFd* e;

  if(!(ep = lws->epoll))
    return;

  if((e = epoll_fd_find(ep, fd))) {
    epoll_ctl(ep->epfd, EPOLL_CTL_DEL, fd, NULL);
    list_del(&e->link);
    js_free(lws->js, e);
  }
}

void
lws_epoll_destroy(LWSContext* lws) {
  LWSEpoll* ep;
  struct list_head *el, *next;

  if(!(ep = lws->epoll))
    return;

  iohandler_set(lws, ep->epfd, JS_NULL, FALSE);

  list_for_each_safe(el, next, &ep->fds) {
    LWSEpollFd* e = list_entry(el, LWSEpollFd, link);

    list_del(&e->link);
    js_free(lws->js, e);
  }

  close(ep->epfd);
  js_free(lws->js, ep);
  lws->epoll = NULL;
}
#endif /* defined(USE_EPOLL) */
