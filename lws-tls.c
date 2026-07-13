#include "lws-tls.h"
#include "js-utils.h"
#include <time.h>

#ifdef LWS_WITH_TLS

/* struct lws_context_creation_info - server + client cert/key/CA material,
   cipher lists, private key passwords. Every *_cert/*_private_key/*_ca
   property accepts either a filesystem path (string) or the raw PEM/DER
   bytes directly (ArrayBuffer/view) - see str_or_buf_property()
   (js-utils.c): lws itself auto-detects PEM vs DER for the in-memory case
   (lws_tls_alloc_pem_to_der_file(), libwebsockets/lib/tls/tls.c), so a PEM
   ArrayBuffer (e.g. from generateSelfSignedCert()) works exactly like a
   file path would. */
void
tls_creation_info_fromobj(JSContext* ctx, JSValueConst obj, struct lws_context_creation_info* ci) {
  str_property(&ci->ssl_private_key_password, ctx, obj, "ssl_private_key_password");

  str_or_buf_property(&ci->ssl_cert_filepath, &ci->server_ssl_cert_mem, &ci->server_ssl_cert_mem_len, ctx, obj, "server_ssl_cert");
  str_or_buf_property(&ci->ssl_private_key_filepath, &ci->server_ssl_private_key_mem, &ci->server_ssl_private_key_mem_len, ctx, obj, "server_ssl_private_key");
  str_or_buf_property(&ci->ssl_ca_filepath, &ci->server_ssl_ca_mem, &ci->server_ssl_ca_mem_len, ctx, obj, "server_ssl_ca");

  str_property(&ci->ssl_cipher_list, ctx, obj, "ssl_cipher_list");
  str_property(&ci->tls1_3_plus_cipher_list, ctx, obj, "tls1_3_plus_cipher_list");
  str_property(&ci->client_ssl_private_key_password, ctx, obj, "client_ssl_private_key_password");

  str_or_buf_property(&ci->client_ssl_cert_filepath, &ci->client_ssl_cert_mem, &ci->client_ssl_cert_mem_len, ctx, obj, "client_ssl_cert");
  str_or_buf_property(&ci->client_ssl_private_key_filepath, &ci->client_ssl_key_mem, &ci->client_ssl_key_mem_len, ctx, obj, "client_ssl_private_key");
  str_or_buf_property(&ci->client_ssl_ca_filepath, &ci->client_ssl_ca_mem, &ci->client_ssl_ca_mem_len, ctx, obj, "client_ssl_ca");

  str_property(&ci->client_ssl_cipher_list, ctx, obj, "client_ssl_cipher_list");
  str_property(&ci->client_tls_1_3_plus_cipher_list, ctx, obj, "client_tls_1_3_plus_cipher_list");
}

void
tls_creation_info_free(JSRuntime* rt, struct lws_context_creation_info* ci) {
  if(ci->ssl_private_key_password)
    js_free_rt(rt, (char*)ci->ssl_private_key_password);

  if(ci->ssl_cert_filepath)
    js_free_rt(rt, (char*)ci->ssl_cert_filepath);

  if(ci->ssl_private_key_filepath)
    js_free_rt(rt, (char*)ci->ssl_private_key_filepath);

  if(ci->ssl_ca_filepath)
    js_free_rt(rt, (char*)ci->ssl_ca_filepath);

  if(ci->ssl_cipher_list)
    js_free_rt(rt, (char*)ci->ssl_cipher_list);

  if(ci->tls1_3_plus_cipher_list)
    js_free_rt(rt, (char*)ci->tls1_3_plus_cipher_list);

  if(ci->client_ssl_private_key_password)
    js_free_rt(rt, (char*)ci->client_ssl_private_key_password);

  if(ci->client_ssl_cert_filepath)
    js_free_rt(rt, (char*)ci->client_ssl_cert_filepath);

  if(ci->client_ssl_private_key_filepath)
    js_free_rt(rt, (char*)ci->client_ssl_private_key_filepath);

  if(ci->client_ssl_ca_filepath)
    js_free_rt(rt, (char*)ci->client_ssl_ca_filepath);

  if(ci->client_ssl_cipher_list)
    js_free_rt(rt, (char*)ci->client_ssl_cipher_list);

  if(ci->client_tls_1_3_plus_cipher_list)
    js_free_rt(rt, (char*)ci->client_tls_1_3_plus_cipher_list);
}

#else /* !LWS_WITH_TLS */

void
tls_creation_info_fromobj(JSContext* ctx, JSValueConst obj, struct lws_context_creation_info* ci) {
}

void
tls_creation_info_free(JSRuntime* rt, struct lws_context_creation_info* ci) {
}

#endif /* LWS_WITH_TLS */

/* struct lws_client_connect_info - not conditional on LWS_WITH_TLS, the
   ssl_connection (LCCSCF_*) field exists on the struct either way (it's
   just meaningless if TLS isn't compiled in). */
void
tls_connect_info_fromobj(JSContext* ctx, JSValueConst obj, struct lws_client_connect_info* ci) {
  JSValue value;

  if(js_has_property(ctx, obj, "ssl_connection"))
    ci->ssl_connection |= to_integerfree(ctx, js_get_property(ctx, obj, "ssl_connection"));

  if(js_has_property(ctx, obj, "ssl")) {
    value = js_get_property(ctx, obj, "ssl");
    ci->ssl_connection |= !JS_IsNumber(value)
                              ? (JS_ToBool(ctx, value) ? LCCSCF_USE_SSL | LCCSCF_ALLOW_SELFSIGNED | LCCSCF_ALLOW_INSECURE | LCCSCF_ALLOW_EXPIRED | LCCSCF_SKIP_SERVER_CERT_HOSTNAME_CHECK : 0)
                              : to_uint32(ctx, value);
    JS_FreeValue(ctx, value);
  }
}

#if defined(LWS_WITH_TLS) && !defined(LWS_WITH_MBEDTLS)

/* Self-signed cert generation is plain OpenSSL API use, not an lws
   facility - lws itself only has lws_tls_acme_sni_cert_create() (a
   hardcoded 1-hour placeholder cert used internally during ACME domain
   validation, not reusable here) and lws_tls_acme_sni_csr_create() (a CSR
   + key generator, meant to be POSTed to an ACME server, not a
   self-signed cert). This is modeled on lws_tls_acme_sni_cert_create's
   OpenSSL calls (libwebsockets/lib/tls/openssl/openssl-server.c) with
   configurable CN/SAN/validity/key size and PEM output instead of
   installing straight onto a vhost's SSL_CTX. Only built against the
   OpenSSL backend (this project's only configured TLS backend) - guarded
   out entirely otherwise rather than half-compiling against an API that
   isn't there. */

#include <openssl/bio.h>
#include <openssl/bn.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/pem.h>
#include <openssl/rsa.h>
#include <openssl/x509.h>
#include <openssl/x509v3.h>

static JSValue
bio_to_arraybuffer(JSContext* ctx, BIO* bio) {
  BUF_MEM* mem = 0;

  BIO_get_mem_ptr(bio, &mem);

  return mem ? JS_NewArrayBufferCopy(ctx, (const uint8_t*)mem->data, mem->length) : JS_NULL;
}

/* "example.com,192.168.1.1" -> "DNS:example.com,IP:192.168.1.1", the value
   X509V3_EXT_conf_nid() wants for NID_subject_alt_name. A name is treated
   as an IP if every character is a digit, '.' or ':' (IPv4/IPv6) - DNS
   otherwise. */
static BOOL
looks_like_ip(const char* s) {
  for(; *s; ++s)
    if(!((*s >= '0' && *s <= '9') || *s == '.' || *s == ':'))
      return FALSE;

  return TRUE;
}

static char*
build_san_value(JSContext* ctx, JSValueConst altNames, const char* fallback_cn) {
  DynBuf db;
  JSValue len_val;
  uint32_t i, n = 0;

  dbuf_init2(&db, ctx, (void*)&js_realloc);

  if(JS_IsArray(ctx, altNames)) {
    len_val = JS_GetPropertyStr(ctx, altNames, "length");
    JS_ToUint32(ctx, &n, len_val);
    JS_FreeValue(ctx, len_val);
  }

  for(i = 0; i < n; ++i) {
    JSValue item = JS_GetPropertyUint32(ctx, altNames, i);
    const char* s = JS_ToCString(ctx, item);

    if(s && *s) {
      if(db.size)
        dbuf_putc(&db, ',');

      dbuf_putstr(&db, looks_like_ip(s) ? "IP:" : "DNS:");
      dbuf_putstr(&db, s);
    }

    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, item);
  }

  if(db.size == 0)
    dbuf_printf(&db, "%s:%s", looks_like_ip(fallback_cn) ? "IP" : "DNS", fallback_cn);

  dbuf_putc(&db, '\0');

  return (char*)db.buf; /* caller js_free()s (dbuf uses js_realloc internally) */
}

JSValue
lwsjs_generate_self_signed_cert(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[]) {
  JSValueConst opts = argc > 0 ? argv[0] : JS_UNDEFINED;
  char* cn = 0;
  char* san = 0;
  int32_t days = 825, bits = 2048;
  BIGNUM* bn = 0;
  RSA* rsa = 0;
  EVP_PKEY* pkey = 0;
  X509* x509 = 0;
  BIO* cert_bio = 0;
  BIO* key_bio = 0;
  X509_NAME* name;
  X509_EXTENSION* ext;
  X509V3_CTX v3ctx;
  JSValue ret = JS_EXCEPTION;

  if(JS_IsObject(opts)) {
    if(js_has_property(ctx, opts, "commonName"))
      cn = to_stringfree(ctx, js_get_property(ctx, opts, "commonName"));

    if(js_has_property(ctx, opts, "days"))
      days = to_int32free(ctx, js_get_property(ctx, opts, "days"));

    if(js_has_property(ctx, opts, "keyBits"))
      bits = to_int32free(ctx, js_get_property(ctx, opts, "keyBits"));
  }

  if(!cn || !*cn) {
    str_free(ctx, &cn);
    cn = js_strdup(ctx, "localhost");
  }

  if(!(bn = BN_new()) || BN_set_word(bn, RSA_F4) != 1)
    goto fail;

  if(!(rsa = RSA_new()) || RSA_generate_key_ex(rsa, bits, bn, NULL) != 1)
    goto fail;

  BN_free(bn);
  bn = 0;

  if(!(pkey = EVP_PKEY_new()) || EVP_PKEY_assign_RSA(pkey, rsa) != 1)
    goto fail;

  rsa = 0; /* ownership transferred to pkey - freeing pkey frees this too */

  if(!(x509 = X509_new()))
    goto fail;

  ASN1_INTEGER_set(X509_get_serialNumber(x509), (long)time(NULL));
  X509_gmtime_adj(X509_get_notBefore(x509), 0);
  X509_gmtime_adj(X509_get_notAfter(x509), (long)days * 24 * 60 * 60);
  X509_set_pubkey(x509, pkey);

  name = X509_get_subject_name(x509);
  X509_NAME_add_entry_by_txt(name, "CN", MBSTRING_ASC, (const unsigned char*)cn, -1, -1, 0);
  X509_set_issuer_name(x509, name);

  {
    JSValue altNames = JS_IsObject(opts) ? JS_GetPropertyStr(ctx, opts, "altNames") : JS_UNDEFINED;

    san = build_san_value(ctx, altNames, cn);
    JS_FreeValue(ctx, altNames);
  }

  X509V3_set_ctx_nodb(&v3ctx);
  X509V3_set_ctx(&v3ctx, x509, x509, NULL, NULL, 0);

  if((ext = X509V3_EXT_conf_nid(NULL, &v3ctx, NID_subject_alt_name, san))) {
    X509_add_ext(x509, ext, -1);
    X509_EXTENSION_free(ext);
  }

  if(X509_sign(x509, pkey, EVP_sha256()) == 0)
    goto fail;

  if(!(cert_bio = BIO_new(BIO_s_mem())) || !(key_bio = BIO_new(BIO_s_mem())))
    goto fail;

  if(PEM_write_bio_X509(cert_bio, x509) != 1 || PEM_write_bio_PrivateKey(key_bio, pkey, NULL, NULL, 0, NULL, NULL) != 1)
    goto fail;

  ret = JS_NewObject(ctx);
  JS_SetPropertyStr(ctx, ret, "cert", bio_to_arraybuffer(ctx, cert_bio));
  JS_SetPropertyStr(ctx, ret, "key", bio_to_arraybuffer(ctx, key_bio));

fail:
  if(cert_bio)
    BIO_free(cert_bio);

  if(key_bio)
    BIO_free(key_bio);

  if(x509)
    X509_free(x509);

  if(pkey)
    EVP_PKEY_free(pkey);

  if(rsa)
    RSA_free(rsa);

  if(bn)
    BN_free(bn);

  js_free(ctx, cn);
  js_free(ctx, san);

  if(JS_IsException(ret)) {
    ERR_clear_error();
    return JS_ThrowInternalError(ctx, "generateSelfSignedCert: certificate generation failed");
  }

  return ret;
}

#else /* !(LWS_WITH_TLS && !LWS_WITH_MBEDTLS) */

JSValue
lwsjs_generate_self_signed_cert(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[]) {
  return JS_ThrowInternalError(ctx, "generateSelfSignedCert: not supported by this build's TLS backend");
}

#endif
