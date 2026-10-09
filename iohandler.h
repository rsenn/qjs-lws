#ifndef IOHANDLER_H
#define IOHANDLER_H

#include <quickjs.h>
#include <cutils.h>
#include "lws-context.h"

void iohandler_set(LWSContext*, int fd, JSValueConst handler, BOOL write);
void iohandler_clear(LWSContext*, int fd);
void iohandler_cleanup(LWSContext*);

#endif /* defined IOHANDLER_H */
