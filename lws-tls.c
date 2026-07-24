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

  if(ci->server_ssl_cert_mem)
    js_free_rt(rt, (void*)ci->server_ssl_cert_mem);

  if(ci->server_ssl_private_key_mem)
    js_free_rt(rt, (void*)ci->server_ssl_private_key_mem);

  if(ci->server_ssl_ca_mem)
    js_free_rt(rt, (void*)ci->server_ssl_ca_mem);

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

  if(ci->client_ssl_cert_mem)
    js_free_rt(rt, (void*)ci->client_ssl_cert_mem);

  if(ci->client_ssl_key_mem)
    js_free_rt(rt, (void*)ci->client_ssl_key_mem);

  if(ci->client_ssl_ca_mem)
    js_free_rt(rt, (void*)ci->client_ssl_ca_mem);

  if(ci->client_ssl_cipher_list)
    js_free_rt(rt, (char*)ci->client_ssl_cipher_list);

  if(ci->client_tls_1_3_plus_cipher_list)
    js_free_rt(rt, (char*)ci->client_tls_1_3_plus_cipher_list);
}

#else /* !LWS_WITH_TLS */

void
tls_creation_info_fromobj(JSContext* ctx, JSValueConst obj, struct lws_context_creation_info* ci) {}

void
tls_creation_info_free(JSRuntime* rt, struct lws_context_creation_info* ci) {}

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

#include <openssl/ssl.h>
#include <openssl/x509_vfy.h>
#include <openssl/x509v3.h>
#include <openssl/asn1.h>

/* X509Certificate - modeled on Node's crypto.X509Certificate
   (https://nodejs.org/api/crypto.html#class-x509certificate), close enough
   to be a drop-in for read-only certificate inspection. Deviations, all
   because this binding has no crypto.KeyObject equivalent: `publicKey` is
   DER (SPKI) as an ArrayBuffer instead of a KeyObject, and
   checkPrivateKey()/verify() take a PEM string or DER ArrayBuffer directly
   instead of a KeyObject. `error`/`errorDepth` (get) and `error` (set) are
   an addition with no Node equivalent - only meaningful when this wraps a
   certificate handed to LWS_CALLBACK_OPENSSL_PERFORM_{CLIENT,SERVER}_CERT_VERIFICATION
   (see is_certverify_reason(), lws.h): they read/override the enclosing
   X509_STORE_CTX's verification result and are inert (undefined/no-op)
   otherwise. Every wrapped X509* is ref-counted (X509_up_ref()) at wrap
   time and freed in the finalizer, so - unlike the callback's raw
   X509_STORE_CTX* / SSL* - an X509Certificate is safe to retain past the
   callback that produced it. */
JSClassID lwsjs_x509_class_id;
static JSValue lwsjs_x509_proto, lwsjs_x509_ctor;

typedef struct {
  X509* cert;
  X509_STORE_CTX* store; /* borrowed, may be NULL - see comment above */
} LWSX509;

enum {
  X509_PROP_CA,
  X509_PROP_FINGERPRINT,
  X509_PROP_FINGERPRINT256,
  X509_PROP_FINGERPRINT512,
  X509_PROP_INFO_ACCESS,
  X509_PROP_ISSUER,
  X509_PROP_ISSUER_CERTIFICATE,
  X509_PROP_KEY_USAGE,
  X509_PROP_PUBLIC_KEY,
  X509_PROP_RAW,
  X509_PROP_SERIAL_NUMBER,
  X509_PROP_SUBJECT,
  X509_PROP_SUBJECT_ALT_NAME,
  X509_PROP_VALID_FROM,
  X509_PROP_VALID_FROM_DATE,
  X509_PROP_VALID_TO,
  X509_PROP_VALID_TO_DATE,
  X509_PROP_ERROR,
  X509_PROP_ERROR_DEPTH,
};

enum {
  X509_METHOD_CHECK_EMAIL,
  X509_METHOD_CHECK_HOST,
  X509_METHOD_CHECK_IP,
  X509_METHOD_CHECK_ISSUED,
  X509_METHOD_CHECK_PRIVATE_KEY,
  X509_METHOD_VERIFY,
  X509_METHOD_TO_JSON,
  X509_METHOD_TO_LEGACY_OBJECT,
  X509_METHOD_TO_STRING,
};

static LWSX509*
lwsjs_x509_data(JSValueConst val) {
  return JS_GetOpaque(val, lwsjs_x509_class_id);
}

static JSValue
lwsjs_x509_wrap_ex(JSContext* ctx, X509* cert, X509_STORE_CTX* store) {
  LWSX509* x;
  JSValue obj;

  if(!cert)
    return JS_NULL;

  if(!(x = js_mallocz(ctx, sizeof(LWSX509))))
    return JS_ThrowOutOfMemory(ctx);

  X509_up_ref(cert);
  x->cert = cert;
  x->store = store;

  if(JS_IsException((obj = JS_NewObjectProtoClass(ctx, lwsjs_x509_proto, lwsjs_x509_class_id)))) {
    X509_free(cert);
    js_free(ctx, x);
    return obj;
  }

  JS_SetOpaque(obj, x);
  return obj;
}

/* Used from lwsjs_callback_protocol() (lws-protocol.c) - `store` is the
   X509_STORE_CTX* handed to LWS_CALLBACK_OPENSSL_PERFORM_*_CERT_VERIFICATION;
   its "current cert" is the one actually being verified. */
JSValue
lwsjs_x509_wrap(JSContext* ctx, X509_STORE_CTX* store) {
  return lwsjs_x509_wrap_ex(ctx, store ? X509_STORE_CTX_get_current_cert(store) : NULL, store);
}

static JSValue
x509_to_pem(JSContext* ctx, X509* cert) {
  BIO* bio;
  JSValue ret = JS_UNDEFINED;

  if((bio = BIO_new(BIO_s_mem()))) {
    if(PEM_write_bio_X509(bio, cert) == 1) {
      BUF_MEM* mem = 0;

      BIO_get_mem_ptr(bio, &mem);
      ret = mem ? JS_NewStringLen(ctx, mem->data, mem->length) : JS_UNDEFINED;
    }

    BIO_free(bio);
  }

  return ret;
}

static JSValue
x509_name_string(JSContext* ctx, X509_NAME* name) {
  DynBuf db;
  int n, count = name ? X509_NAME_entry_count(name) : 0;

  dbuf_init2(&db, ctx, (void*)&js_realloc);

  for(n = 0; n < count; n++) {
    X509_NAME_ENTRY* e = X509_NAME_get_entry(name, n);
    ASN1_OBJECT* obj = X509_NAME_ENTRY_get_object(e);
    ASN1_STRING* data = X509_NAME_ENTRY_get_data(e);
    int nid = OBJ_obj2nid(obj);
    const char* sn = nid != NID_undef ? OBJ_nid2sn(nid) : NULL;
    char sn_buf[80];
    unsigned char* utf8 = 0;
    int len;

    if(!sn) {
      OBJ_obj2txt(sn_buf, sizeof(sn_buf), obj, 0);
      sn = sn_buf;
    }

    len = ASN1_STRING_to_UTF8(&utf8, data);

    if(n)
      dbuf_putc(&db, '\n');

    dbuf_putstr(&db, sn);
    dbuf_putc(&db, '=');

    if(len > 0)
      dbuf_put(&db, utf8, len);

    if(utf8)
      OPENSSL_free(utf8);
  }

  dbuf_putc(&db, '\0');

  JSValue ret = JS_NewString(ctx, (const char*)db.buf);
  dbuf_free(&db);
  return ret;
}

static JSValue
x509_fingerprint(JSContext* ctx, X509* cert, const EVP_MD* md) {
  uint8_t buf[EVP_MAX_MD_SIZE];
  unsigned int len = 0, i;
  char out[EVP_MAX_MD_SIZE * 3], *p = out;

  if(!X509_digest(cert, md, buf, &len))
    return JS_NULL;

  for(i = 0; i < len; i++) {
    if(i)
      *p++ = ':';

    p += sprintf(p, "%02X", buf[i]);
  }

  *p = 0;
  return JS_NewString(ctx, out);
}

static JSValue
x509_time_date(JSContext* ctx, const ASN1_TIME* t) {
  struct tm tm;
  JSValue global, ctor, ret, arg;

  if(!t || !ASN1_TIME_to_tm(t, &tm))
    return JS_UNDEFINED;

  global = JS_GetGlobalObject(ctx);
  ctor = JS_GetPropertyStr(ctx, global, "Date");
  JS_FreeValue(ctx, global);

  arg = JS_NewFloat64(ctx, (double)timegm(&tm) * 1000.0);
  ret = JS_CallConstructor(ctx, ctor, 1, &arg);
  JS_FreeValue(ctx, ctor);

  return ret;
}

static const char* const x509_key_usage_names[] = {
    "digitalSignature",
    "nonRepudiation",
    "keyEncipherment",
    "dataEncipherment",
    "keyAgreement",
    "keyCertSign",
    "cRLSign",
    "encipherOnly",
    "decipherOnly",
};

static JSValue
lwsjs_x509_get(JSContext* ctx, JSValueConst this_val, int magic) {
  LWSX509* x;
  X509* cert;

  if(!(x = lwsjs_x509_data(this_val)))
    return JS_UNDEFINED;

  cert = x->cert;

  switch(magic) {
    case X509_PROP_CA: return JS_NewBool(ctx, X509_check_ca(cert) > 0);
    case X509_PROP_FINGERPRINT: return x509_fingerprint(ctx, cert, EVP_sha1());
    case X509_PROP_FINGERPRINT256: return x509_fingerprint(ctx, cert, EVP_sha256());
    case X509_PROP_FINGERPRINT512: return x509_fingerprint(ctx, cert, EVP_sha512());
    case X509_PROP_ISSUER: return x509_name_string(ctx, X509_get_issuer_name(cert));
    case X509_PROP_SUBJECT: return x509_name_string(ctx, X509_get_subject_name(cert));
    case X509_PROP_VALID_FROM_DATE: return x509_time_date(ctx, X509_get0_notBefore(cert));
    case X509_PROP_VALID_TO_DATE: return x509_time_date(ctx, X509_get0_notAfter(cert));

    case X509_PROP_VALID_FROM:
    case X509_PROP_VALID_TO: {
      const ASN1_TIME* t = magic == X509_PROP_VALID_FROM ? X509_get0_notBefore(cert) : X509_get0_notAfter(cert);
      BIO* bio;
      JSValue ret = JS_UNDEFINED;

      if(t && (bio = BIO_new(BIO_s_mem()))) {
        if(ASN1_TIME_print(bio, t) == 1) {
          BUF_MEM* mem = 0;

          BIO_get_mem_ptr(bio, &mem);
          ret = mem ? JS_NewStringLen(ctx, mem->data, mem->length) : JS_UNDEFINED;
        }

        BIO_free(bio);
      }

      return ret;
    }

    case X509_PROP_SERIAL_NUMBER: {
      ASN1_INTEGER* serial = X509_get_serialNumber(cert);
      BIGNUM* bn = serial ? ASN1_INTEGER_to_BN(serial, NULL) : NULL;
      JSValue ret = JS_UNDEFINED;

      if(bn) {
        char* hex = BN_bn2hex(bn);

        if(hex)
          ret = JS_NewString(ctx, hex);

        OPENSSL_free(hex);
        BN_free(bn);
      }

      return ret;
    }

    case X509_PROP_RAW: {
      uint8_t* der = 0;
      int len = i2d_X509(cert, &der);
      JSValue ret;

      if(len <= 0)
        return JS_NULL;

      ret = JS_NewArrayBufferCopy(ctx, der, len);
      OPENSSL_free(der);
      return ret;
    }

    case X509_PROP_PUBLIC_KEY: {
      EVP_PKEY* pkey = X509_get_pubkey(cert);
      uint8_t* der = 0;
      int len;
      JSValue ret;

      if(!pkey)
        return JS_NULL;

      len = i2d_PUBKEY(pkey, &der);
      EVP_PKEY_free(pkey);

      if(len <= 0)
        return JS_NULL;

      ret = JS_NewArrayBufferCopy(ctx, der, len);
      OPENSSL_free(der);
      return ret;
    }

    case X509_PROP_KEY_USAGE: {
      ASN1_BIT_STRING* bs = X509_get_ext_d2i(cert, NID_key_usage, NULL, NULL);
      JSValue arr;
      uint32_t idx = 0;
      int b;

      if(!bs)
        return JS_UNDEFINED;

      arr = JS_NewArray(ctx);

      for(b = 0; b < (int)countof(x509_key_usage_names); b++)
        if(ASN1_BIT_STRING_get_bit(bs, b))
          JS_SetPropertyUint32(ctx, arr, idx++, JS_NewString(ctx, x509_key_usage_names[b]));

      ASN1_BIT_STRING_free(bs);
      return arr;
    }

    case X509_PROP_SUBJECT_ALT_NAME: {
      GENERAL_NAMES* names = X509_get_ext_d2i(cert, NID_subject_alt_name, NULL, NULL);
      BIO* bio;
      JSValue ret = JS_UNDEFINED;
      int i;

      if(!names)
        return JS_UNDEFINED;

      if((bio = BIO_new(BIO_s_mem()))) {
        for(i = 0; i < sk_GENERAL_NAME_num(names); i++) {
          if(i)
            BIO_puts(bio, ", ");

          GENERAL_NAME_print(bio, sk_GENERAL_NAME_value(names, i));
        }

        BUF_MEM* mem = 0;

        BIO_get_mem_ptr(bio, &mem);
        ret = mem ? JS_NewStringLen(ctx, mem->data, mem->length) : JS_UNDEFINED;
        BIO_free(bio);
      }

      GENERAL_NAMES_free(names);
      return ret;
    }

    case X509_PROP_INFO_ACCESS: {
      int loc = X509_get_ext_by_NID(cert, NID_info_access, -1);
      X509_EXTENSION* ext;
      BIO* bio;
      JSValue ret = JS_UNDEFINED;

      if(loc < 0 || !(ext = X509_get_ext(cert, loc)))
        return JS_UNDEFINED;

      if((bio = BIO_new(BIO_s_mem()))) {
        X509V3_EXT_print(bio, ext, 0, 0);

        BUF_MEM* mem = 0;

        BIO_get_mem_ptr(bio, &mem);
        ret = mem ? JS_NewStringLen(ctx, mem->data, mem->length) : JS_UNDEFINED;
        BIO_free(bio);
      }

      return ret;
    }

    case X509_PROP_ISSUER_CERTIFICATE: {
      /* Node populates this from the peer's verified chain, which we don't
         have (X509_STORE_CTX does, via X509_STORE_CTX_get0_chain(), but
         wiring that through would mean carrying the whole chain, not just
         the current cert). Best-effort fallback matching Node's own
         behavior for a self-signed cert: point back at itself. */
      if(X509_check_issued(cert, cert) == X509_V_OK)
        return lwsjs_x509_wrap_ex(ctx, cert, NULL);

      return JS_UNDEFINED;
    }

    case X509_PROP_ERROR: return x->store ? JS_NewInt32(ctx, X509_STORE_CTX_get_error(x->store)) : JS_UNDEFINED;
    case X509_PROP_ERROR_DEPTH: return x->store ? JS_NewInt32(ctx, X509_STORE_CTX_get_error_depth(x->store)) : JS_UNDEFINED;
  }

  return JS_UNDEFINED;
}

static JSValue
lwsjs_x509_set_error(JSContext* ctx, JSValueConst this_val, JSValueConst value, int magic) {
  LWSX509* x;

  if(!(x = lwsjs_x509_data(this_val)))
    return JS_EXCEPTION;

  if(x->store)
    X509_STORE_CTX_set_error(x->store, to_int32(ctx, value));

  return JS_UNDEFINED;
}

static unsigned int
x509_check_flags(JSContext* ctx, JSValueConst options) {
  unsigned int flags = 0;
  JSValue v;

  if(!JS_IsObject(options))
    return flags;

  if(js_has_property(ctx, options, "wildcards") && !to_boolfree(ctx, js_get_property(ctx, options, "wildcards")))
    flags |= X509_CHECK_FLAG_NO_WILDCARDS;

  if(js_has_property(ctx, options, "partialWildcards") && !to_boolfree(ctx, js_get_property(ctx, options, "partialWildcards")))
    flags |= X509_CHECK_FLAG_NO_PARTIAL_WILDCARDS;

  if(to_boolfree(ctx, js_get_property(ctx, options, "multiLabelWildcards")))
    flags |= X509_CHECK_FLAG_MULTI_LABEL_WILDCARDS;

  if(to_boolfree(ctx, js_get_property(ctx, options, "singleLabelSubdomains")))
    flags |= X509_CHECK_FLAG_SINGLE_LABEL_SUBDOMAINS;

  if(!JS_IsUndefined((v = js_get_property(ctx, options, "subject")))) {
    const char* subj = JS_ToCString(ctx, v);

    if(subj) {
      if(!strcmp(subj, "always"))
        flags |= X509_CHECK_FLAG_ALWAYS_CHECK_SUBJECT;
      else if(!strcmp(subj, "never"))
        flags |= X509_CHECK_FLAG_NEVER_CHECK_SUBJECT;

      JS_FreeCString(ctx, subj);
    }
  }

  JS_FreeValue(ctx, v);
  return flags;
}

/* Accepts a PEM string or DER ArrayBuffer for a private (is_public=FALSE) or
   public (is_public=TRUE) key - see the class comment above for why this
   isn't a crypto.KeyObject like Node's checkPrivateKey()/verify() take. */
static EVP_PKEY*
x509_parse_pkey(JSContext* ctx, JSValueConst val, BOOL is_public) {
  uint8_t* buf;
  size_t len;
  char* str;
  EVP_PKEY* pkey = NULL;
  BIO* bio;

  if((buf = get_buffer(ctx, 1, &val, &len))) {
    const uint8_t* p = buf;

    pkey = is_public ? d2i_PUBKEY(NULL, &p, len) : d2i_AutoPrivateKey(NULL, &p, len);

    if(!pkey && (bio = BIO_new_mem_buf(buf, len))) {
      pkey = is_public ? PEM_read_bio_PUBKEY(bio, NULL, NULL, NULL) : PEM_read_bio_PrivateKey(bio, NULL, NULL, NULL);
      BIO_free(bio);
    }
  } else if((str = to_string(ctx, val))) {
    if((bio = BIO_new_mem_buf(str, -1))) {
      pkey = is_public ? PEM_read_bio_PUBKEY(bio, NULL, NULL, NULL) : PEM_read_bio_PrivateKey(bio, NULL, NULL, NULL);
      BIO_free(bio);
    }

    js_free(ctx, str);
  }

  return pkey;
}

static JSValue
lwsjs_x509_methods(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[], int magic) {
  LWSX509* x;
  X509* cert;

  if(!(x = lwsjs_x509_data(this_val)))
    return JS_EXCEPTION;

  cert = x->cert;

  switch(magic) {
    case X509_METHOD_CHECK_HOST: {
      const char* name;
      size_t namelen;
      unsigned int flags = argc > 1 ? x509_check_flags(ctx, argv[1]) : 0;
      char* peername = NULL;
      JSValue ret = JS_UNDEFINED;
      int r;

      if(!(name = JS_ToCStringLen(ctx, &namelen, argv[0])))
        return JS_ThrowTypeError(ctx, "checkHost: expected string");

      r = X509_check_host(cert, name, namelen, flags, &peername);

      if(r == 1)
        ret = peername ? JS_NewString(ctx, peername) : JS_NewStringLen(ctx, name, namelen);
      else if(r < 0)
        ret = JS_ThrowInternalError(ctx, "X509_check_host failed");

      if(peername)
        OPENSSL_free(peername);

      JS_FreeCString(ctx, name);
      return ret;
    }

    case X509_METHOD_CHECK_EMAIL: {
      const char* email;
      size_t len;
      unsigned int flags = argc > 1 ? x509_check_flags(ctx, argv[1]) : 0;
      JSValue ret;
      int r;

      if(!(email = JS_ToCStringLen(ctx, &len, argv[0])))
        return JS_ThrowTypeError(ctx, "checkEmail: expected string");

      r = X509_check_email(cert, email, len, flags);
      ret = r == 1 ? JS_NewStringLen(ctx, email, len) : JS_UNDEFINED;

      JS_FreeCString(ctx, email);
      return ret;
    }

    case X509_METHOD_CHECK_IP: {
      const char* ip;
      JSValue ret;

      if(!(ip = JS_ToCString(ctx, argv[0])))
        return JS_ThrowTypeError(ctx, "checkIP: expected string");

      ret = X509_check_ip_asc(cert, ip, 0) == 1 ? JS_NewString(ctx, ip) : JS_UNDEFINED;

      JS_FreeCString(ctx, ip);
      return ret;
    }

    case X509_METHOD_CHECK_ISSUED: {
      LWSX509* other;

      if(!(other = lwsjs_x509_data(argv[0])))
        return JS_ThrowTypeError(ctx, "checkIssued: expected X509Certificate");

      return JS_NewBool(ctx, X509_check_issued(cert, other->cert) == X509_V_OK);
    }

    case X509_METHOD_CHECK_PRIVATE_KEY: {
      EVP_PKEY* pkey = x509_parse_pkey(ctx, argv[0], FALSE);
      BOOL ok;

      if(!pkey)
        return JS_ThrowTypeError(ctx, "checkPrivateKey: invalid private key");

      ok = X509_check_private_key(cert, pkey) == 1;
      EVP_PKEY_free(pkey);
      return JS_NewBool(ctx, ok);
    }

    case X509_METHOD_VERIFY: {
      EVP_PKEY* pkey = x509_parse_pkey(ctx, argv[0], TRUE);
      BOOL ok;

      if(!pkey)
        return JS_ThrowTypeError(ctx, "verify: invalid public key");

      ok = X509_verify(cert, pkey) == 1;
      EVP_PKEY_free(pkey);
      return JS_NewBool(ctx, ok);
    }

    case X509_METHOD_TO_STRING:
    case X509_METHOD_TO_JSON: return x509_to_pem(ctx, cert);

    case X509_METHOD_TO_LEGACY_OBJECT: {
      JSValue obj = JS_NewObject(ctx);

      JS_SetPropertyStr(ctx, obj, "subject", lwsjs_x509_get(ctx, this_val, X509_PROP_SUBJECT));
      JS_SetPropertyStr(ctx, obj, "issuer", lwsjs_x509_get(ctx, this_val, X509_PROP_ISSUER));
      JS_SetPropertyStr(ctx, obj, "subjectaltname", lwsjs_x509_get(ctx, this_val, X509_PROP_SUBJECT_ALT_NAME));
      JS_SetPropertyStr(ctx, obj, "infoAccess", lwsjs_x509_get(ctx, this_val, X509_PROP_INFO_ACCESS));
      JS_SetPropertyStr(ctx, obj, "valid_from", lwsjs_x509_get(ctx, this_val, X509_PROP_VALID_FROM));
      JS_SetPropertyStr(ctx, obj, "valid_to", lwsjs_x509_get(ctx, this_val, X509_PROP_VALID_TO));
      JS_SetPropertyStr(ctx, obj, "fingerprint", lwsjs_x509_get(ctx, this_val, X509_PROP_FINGERPRINT));
      JS_SetPropertyStr(ctx, obj, "fingerprint256", lwsjs_x509_get(ctx, this_val, X509_PROP_FINGERPRINT256));
      JS_SetPropertyStr(ctx, obj, "fingerprint512", lwsjs_x509_get(ctx, this_val, X509_PROP_FINGERPRINT512));
      JS_SetPropertyStr(ctx, obj, "serialNumber", lwsjs_x509_get(ctx, this_val, X509_PROP_SERIAL_NUMBER));
      JS_SetPropertyStr(ctx, obj, "raw", lwsjs_x509_get(ctx, this_val, X509_PROP_RAW));

      return obj;
    }
  }

  return JS_UNDEFINED;
}

static void
lwsjs_x509_finalizer(JSRuntime* rt, JSValue val) {
  LWSX509* x;

  if((x = JS_GetOpaque(val, lwsjs_x509_class_id))) {
    if(x->cert)
      X509_free(x->cert);

    js_free_rt(rt, x);
  }
}

/* new X509Certificate(buffer) - `buffer` is a DER ArrayBuffer or a PEM
   string, matching Node's constructor. */
static JSValue
lwsjs_x509_constructor(JSContext* ctx, JSValueConst new_target, int argc, JSValueConst argv[]) {
  LWSX509* x;
  X509* cert = NULL;
  uint8_t* buf;
  size_t len;
  char* str;
  JSValue proto, obj;

  if(argc < 1)
    return JS_ThrowTypeError(ctx, "X509Certificate: expected a DER ArrayBuffer or PEM string");

  if((buf = get_buffer(ctx, 1, argv, &len))) {
    const uint8_t* p = buf;
    BIO* bio;

    if(len > 10 && !memcmp(buf, "-----BEGIN", 10)) {
      if((bio = BIO_new_mem_buf(buf, len))) {
        cert = PEM_read_bio_X509(bio, NULL, NULL, NULL);
        BIO_free(bio);
      }
    } else {
      cert = d2i_X509(NULL, &p, len);
    }
  } else if((str = to_string(ctx, argv[0]))) {
    BIO* bio;

    if((bio = BIO_new_mem_buf(str, -1))) {
      cert = PEM_read_bio_X509(bio, NULL, NULL, NULL);
      BIO_free(bio);
    }

    js_free(ctx, str);
  }

  if(!cert)
    return JS_ThrowTypeError(ctx, "X509Certificate: invalid certificate data");

  if(!(x = js_mallocz(ctx, sizeof(LWSX509)))) {
    X509_free(cert);
    return JS_ThrowOutOfMemory(ctx);
  }

  x->cert = cert;
  x->store = NULL;

  /* using new_target to get the prototype is necessary when the class is extended. */
  proto = JS_GetPropertyStr(ctx, new_target, "prototype");
  if(JS_IsException(proto))
    proto = JS_DupValue(ctx, lwsjs_x509_proto);

  obj = JS_NewObjectProtoClass(ctx, proto, lwsjs_x509_class_id);
  JS_FreeValue(ctx, proto);

  if(JS_IsException(obj)) {
    X509_free(cert);
    js_free(ctx, x);
    return obj;
  }

  JS_SetOpaque(obj, x);
  return obj;
}

static const JSClassDef lws_x509_class = {
    "X509Certificate",
    .finalizer = lwsjs_x509_finalizer,
};

static const JSCFunctionListEntry lws_x509_proto_funcs[] = {
    JS_CGETSET_MAGIC_DEF("ca", lwsjs_x509_get, 0, X509_PROP_CA),
    JS_CGETSET_MAGIC_DEF("fingerprint", lwsjs_x509_get, 0, X509_PROP_FINGERPRINT),
    JS_CGETSET_MAGIC_DEF("fingerprint256", lwsjs_x509_get, 0, X509_PROP_FINGERPRINT256),
    JS_CGETSET_MAGIC_DEF("fingerprint512", lwsjs_x509_get, 0, X509_PROP_FINGERPRINT512),
    JS_CGETSET_MAGIC_DEF("infoAccess", lwsjs_x509_get, 0, X509_PROP_INFO_ACCESS),
    JS_CGETSET_MAGIC_DEF("issuer", lwsjs_x509_get, 0, X509_PROP_ISSUER),
    JS_CGETSET_MAGIC_DEF("issuerCertificate", lwsjs_x509_get, 0, X509_PROP_ISSUER_CERTIFICATE),
    JS_CGETSET_MAGIC_DEF("keyUsage", lwsjs_x509_get, 0, X509_PROP_KEY_USAGE),
    JS_CGETSET_MAGIC_DEF("publicKey", lwsjs_x509_get, 0, X509_PROP_PUBLIC_KEY),
    JS_CGETSET_MAGIC_DEF("raw", lwsjs_x509_get, 0, X509_PROP_RAW),
    JS_CGETSET_MAGIC_DEF("serialNumber", lwsjs_x509_get, 0, X509_PROP_SERIAL_NUMBER),
    JS_CGETSET_MAGIC_DEF("subject", lwsjs_x509_get, 0, X509_PROP_SUBJECT),
    JS_CGETSET_MAGIC_DEF("subjectAltName", lwsjs_x509_get, 0, X509_PROP_SUBJECT_ALT_NAME),
    JS_CGETSET_MAGIC_DEF("validFrom", lwsjs_x509_get, 0, X509_PROP_VALID_FROM),
    JS_CGETSET_MAGIC_DEF("validFromDate", lwsjs_x509_get, 0, X509_PROP_VALID_FROM_DATE),
    JS_CGETSET_MAGIC_DEF("validTo", lwsjs_x509_get, 0, X509_PROP_VALID_TO),
    JS_CGETSET_MAGIC_DEF("validToDate", lwsjs_x509_get, 0, X509_PROP_VALID_TO_DATE),
    JS_CGETSET_MAGIC_DEF("error", lwsjs_x509_get, lwsjs_x509_set_error, X509_PROP_ERROR),
    JS_CGETSET_MAGIC_DEF("errorDepth", lwsjs_x509_get, 0, X509_PROP_ERROR_DEPTH),
    JS_CFUNC_MAGIC_DEF("checkEmail", 1, lwsjs_x509_methods, X509_METHOD_CHECK_EMAIL),
    JS_CFUNC_MAGIC_DEF("checkHost", 1, lwsjs_x509_methods, X509_METHOD_CHECK_HOST),
    JS_CFUNC_MAGIC_DEF("checkIP", 1, lwsjs_x509_methods, X509_METHOD_CHECK_IP),
    JS_CFUNC_MAGIC_DEF("checkIssued", 1, lwsjs_x509_methods, X509_METHOD_CHECK_ISSUED),
    JS_CFUNC_MAGIC_DEF("checkPrivateKey", 1, lwsjs_x509_methods, X509_METHOD_CHECK_PRIVATE_KEY),
    JS_CFUNC_MAGIC_DEF("verify", 1, lwsjs_x509_methods, X509_METHOD_VERIFY),
    JS_CFUNC_MAGIC_DEF("toJSON", 0, lwsjs_x509_methods, X509_METHOD_TO_JSON),
    JS_CFUNC_MAGIC_DEF("toLegacyObject", 0, lwsjs_x509_methods, X509_METHOD_TO_LEGACY_OBJECT),
    JS_CFUNC_MAGIC_DEF("toString", 0, lwsjs_x509_methods, X509_METHOD_TO_STRING),
    JS_PROP_STRING_DEF("[Symbol.toStringTag]", "X509Certificate", JS_PROP_CONFIGURABLE),
};

/* TLSSocket - wraps the SSL* OpenSSL hands to the same verify callback.
   Just enough to let JS correlate the certificate above with the
   connection it belongs to (SNI hostname, for hostname-check logic). */
JSClassID lwsjs_tls_socket_class_id;
static JSValue lwsjs_tls_socket_proto;

enum {
  TLS_SOCKET_PROP_SERVERNAME,
};

static SSL*
lwsjs_tls_socket_data(JSValueConst val) {
  return JS_GetOpaque(val, lwsjs_tls_socket_class_id);
}

static JSValue
lwsjs_tls_socket_get(JSContext* ctx, JSValueConst this_val, int magic) {
  SSL* ssl;

  if(!(ssl = lwsjs_tls_socket_data(this_val)))
    return JS_UNDEFINED;

  switch(magic) {
    case TLS_SOCKET_PROP_SERVERNAME: {
      const char* name = SSL_get_servername(ssl, TLSEXT_NAMETYPE_host_name);
      return name ? JS_NewString(ctx, name) : JS_NULL;
    }
  }

  return JS_UNDEFINED;
}

static const JSClassDef lws_tls_socket_class = {
    "TLSSocket",
};

static const JSCFunctionListEntry lws_tls_socket_proto_funcs[] = {
    JS_CGETSET_MAGIC_DEF("servername", lwsjs_tls_socket_get, 0, TLS_SOCKET_PROP_SERVERNAME),
    JS_PROP_STRING_DEF("[Symbol.toStringTag]", "TLSSocket", JS_PROP_CONFIGURABLE),
};

JSValue
lwsjs_tls_socket_wrap(JSContext* ctx, SSL* ssl) {
  JSValue obj;

  if(!ssl)
    return JS_NULL;

  if(JS_IsException((obj = JS_NewObjectProtoClass(ctx, lwsjs_tls_socket_proto, lwsjs_tls_socket_class_id))))
    return obj;

  JS_SetOpaque(obj, ssl);
  return obj;
}

int
lwsjs_tls_certverify_init(JSContext* ctx, JSModuleDef* m) {
  JS_NewClassID(&lwsjs_x509_class_id);
  JS_NewClass(JS_GetRuntime(ctx), lwsjs_x509_class_id, &lws_x509_class);
  lwsjs_x509_proto = JS_NewObjectProto(ctx, JS_NULL);
  JS_SetPropertyFunctionList(ctx, lwsjs_x509_proto, lws_x509_proto_funcs, countof(lws_x509_proto_funcs));

  lwsjs_x509_ctor = JS_NewCFunction2(ctx, lwsjs_x509_constructor, "X509Certificate", 1, JS_CFUNC_constructor, 0);
  JS_SetConstructor(ctx, lwsjs_x509_ctor, lwsjs_x509_proto);

  JS_NewClassID(&lwsjs_tls_socket_class_id);
  JS_NewClass(JS_GetRuntime(ctx), lwsjs_tls_socket_class_id, &lws_tls_socket_class);
  lwsjs_tls_socket_proto = JS_NewObjectProto(ctx, JS_NULL);
  JS_SetPropertyFunctionList(ctx, lwsjs_tls_socket_proto, lws_tls_socket_proto_funcs, countof(lws_tls_socket_proto_funcs));

  if(m) {
    JS_SetModuleExport(ctx, m, "X509Certificate", lwsjs_x509_ctor);
  }

  return 0;
}

#else /* !(LWS_WITH_TLS && !LWS_WITH_MBEDTLS) */

JSValue
lwsjs_generate_self_signed_cert(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[]) {
  return JS_ThrowInternalError(ctx, "generateSelfSignedCert: not supported by this build's TLS backend");
}

#endif
