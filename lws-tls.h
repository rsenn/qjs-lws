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
   both PEM-encoded. `options`: { commonName, days, keyBits }, all optional.
   Built on lws_x509_create_cert() (libwebsockets/lws-x509.h), so it works
   under any TLS backend lws is built with (OpenSSL, mbedTLS, GnuTLS, ...) -
   no direct OpenSSL calls. Unlike the old OpenSSL-based implementation,
   lws_x509_cert_gen_info only carries a single `san` field (used as both CN
   and the sole SAN entry), so `altNames` (multiple SANs) is no longer
   supported - only the first of commonName/altNames[0] is used. */
JSValue lwsjs_generate_self_signed_cert(JSContext*, JSValueConst, int, JSValueConst[]);

/* X509Certificate(pemString) - read-only certificate inspection, built
   entirely on libwebsockets' own backend-agnostic lws-x509.h API
   (lws_x509_parse_from_pem()/lws_x509_info()/lws_x509_verify()/
   lws_x509_cert_fingerprint()), not any TLS backend's native API - so it
   works under OpenSSL, mbedTLS, GnuTLS, etc. This project used to also wrap
   whatever raw X509_STORE_CTX* and SSL* pointers OpenSSL specifically hands
   to LWS_CALLBACK_OPENSSL_PERFORM_{CLIENT,SERVER}_CERT_VERIFICATION for
   verify-time inspection, but that pair of reasons (note the "OPENSSL" in
   the name) has no backend-agnostic equivalent in lws's public API, so that
   capability - and the properties/methods it uniquely needed (error/
   errorDepth, checkHost/checkEmail/checkIP/checkPrivateKey/verify-with-a-
   raw-key) - is gone rather than half-supported. */
extern JSClassID lwsjs_x509_class_id;

int lwsjs_tls_certverify_init(JSContext*, JSModuleDef*);

#endif /* QJS_LWS_TLS_H */
