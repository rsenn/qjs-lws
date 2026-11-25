/* dietlibc's <endian.h> lacks the BSD/glibc byte-order conversion macros
   LibreSSL's crypto_internal.h uses (be32toh, htobe64, ...), so supply them */
#ifndef DIET_ENDIAN_COMPAT_H
#define DIET_ENDIAN_COMPAT_H

#include <endian.h>

#ifndef be32toh
#if __BYTE_ORDER == __LITTLE_ENDIAN
#define htobe16(x) __builtin_bswap16(x)
#define htobe32(x) __builtin_bswap32(x)
#define htobe64(x) __builtin_bswap64(x)
#define htole16(x) (x)
#define htole32(x) (x)
#define htole64(x) (x)
#else
#define htobe16(x) (x)
#define htobe32(x) (x)
#define htobe64(x) (x)
#define htole16(x) __builtin_bswap16(x)
#define htole32(x) __builtin_bswap32(x)
#define htole64(x) __builtin_bswap64(x)
#endif
#define be16toh(x) htobe16(x)
#define be32toh(x) htobe32(x)
#define be64toh(x) htobe64(x)
#define le16toh(x) htole16(x)
#define le32toh(x) htole32(x)
#define le64toh(x) htole64(x)
#endif

#endif
