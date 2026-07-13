#ifndef QJS_LWS_TLS_H
#define QJS_LWS_TLS_H

#include <quickjs.h>
#include <libwebsockets.h>

/**
 * @file lws-tls.h
 *
 * Everything to do with TLS/SSL configuration: reading cert/key/CA material
 * and crypto-relevant flags out of JS option objects into the native lws
 * structs, freeing what was allocated for that, and generating a
 * self-signed certificate.
 */

/* struct lws_context_creation_info - server + client cert/key/CA material,
   cipher lists, private key passwords. */
void tls_creation_info_fromobj(JSContext*, JSValueConst, struct lws_context_creation_info*);
void tls_creation_info_free(JSRuntime*, struct lws_context_creation_info*);

/* struct lws_client_connect_info - the `ssl` / `ssl_connection` (LCCSCF_*)
   flags for one outbound connection. */
void tls_connect_info_fromobj(JSContext*, JSValueConst, struct lws_client_connect_info*);

/* generateSelfSignedCert(options) -> { cert: ArrayBuffer, key: ArrayBuffer },
   both PEM-encoded. `options`: { commonName, altNames: string[], days,
   keyBits }, all optional. */
JSValue lwsjs_generate_self_signed_cert(JSContext*, JSValueConst, int, JSValueConst[]);

#endif /* QJS_LWS_TLS_H */
