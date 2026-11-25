/* dietlibc's <linux/types.h> is a stub: provide what the kernel UAPI headers
   libwebsockets includes (linux/if_packet.h) expect */
#ifndef DIET_LWS_COMPAT_H
#define DIET_LWS_COMPAT_H

/* u_int & co (lib/tls/chacha.c) are declared by dietlibc only under _BSD_SOURCE */
#ifndef _BSD_SOURCE
#define _BSD_SOURCE 1
#endif
/* fstatat(), openat() ... (lib/misc/dir.c) */
#ifndef _ATFILE_SOURCE
#define _ATFILE_SOURCE 1
#endif

#ifndef __aligned_u64
#define __aligned_u64 unsigned long long __attribute__((aligned(8)))
#endif
#ifndef __aligned_be64
#define __aligned_be64 unsigned long long __attribute__((aligned(8)))
#endif
#ifndef __aligned_le64
#define __aligned_le64 unsigned long long __attribute__((aligned(8)))
#endif

/* dietlibc ships <ifaddrs.h> but no getifaddrs(): lws uses its built-in BSD
   version, whose struct ifaddrs would clash with the one from that header */
#ifndef _IFADDRS_H
#define _IFADDRS_H 1
#endif

/* unix-spawn.c (pulled in by lws plugins) wants a pty: dietlibc has
   grantpt/unlockpt/ptsname but declares them only under _XOPEN_SOURCE and has
   no posix_openpt */
#include <fcntl.h>
extern int grantpt(int fd);
extern int unlockpt(int fd);
extern char* ptsname(int fd);
static inline int
posix_openpt(int flags) {
  return open("/dev/ptmx", flags);
}

/* lws-adopt.h embeds sockaddr_in/in6 without including <netinet/in.h> */
#include <sys/socket.h>
#include <netinet/in.h>

#endif
