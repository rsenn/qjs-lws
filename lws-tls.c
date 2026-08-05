#include "lws-tls.h"
#include "js-utils.h"
#include <time.h>
#include <stdlib.h>

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

#if defined(LWS_WITH_CACHE_NSCOOKIEJAR) && defined(LWS_WITH_CLIENT)
  /* Per-connection opt-in to the context's cookie jar (see the `cookieJar`
     context-creation option, lws-context.c) - captures Set-Cookie from the
     response and replays matching cookies on this and future requests. */
  if(to_boolfree(ctx, js_get_property(ctx, obj, "cache_cookies")))
    ci->ssl_connection |= LCCSCF_CACHE_COOKIES;
#endif

#ifdef LWS_WITH_CONMON
  /* Per-connection opt-in to collecting DNS/connect/TLS/TTFB timing - see
     the wsi.conmon getter (lws-socket.c). */
  if(to_boolfree(ctx, js_get_property(ctx, obj, "conmon")))
    ci->ssl_connection |= LCCSCF_CONMON;
#endif
}

/* Self-signed cert generation, via lws_x509_create_cert()
   (libwebsockets/lws-x509.h) - a TLS-backend-agnostic facility lws itself
   provides (OpenSSL/mbedTLS/GnuTLS/... backends each implement it), so this
   needs no direct OpenSSL (or any other backend's) calls at all. It outputs
   DER; pem_wrap() below does the PEM armor (base64 + line-wrap + BEGIN/END)
   ourselves, since that's plain text formatting with no crypto backend
   involved either. */

#ifdef LWS_WITH_TLS

static JSValue
pem_wrap(JSContext* ctx, const char* label, const uint8_t* der, size_t der_len) {
  /* lws_b64_encode_string() rejects out_size <= (encoded_len + 1) - i.e. it
     needs strictly more than one byte of headroom past the encoded length
     for its NUL terminator - so +1 isn't enough; give it a few bytes of
     slack rather than matching its off-by-one exactly. */
  int cap = (int)(((der_len + 2) / 3) * 4) + 4;
  char* b64 = js_malloc(ctx, cap);
  int n, i;
  DynBuf db;
  JSValue ret;

  if(!b64)
    return JS_ThrowOutOfMemory(ctx);

  if((n = lws_b64_encode_string((const char*)der, (int)der_len, b64, cap)) < 0) {
    js_free(ctx, b64);
    return JS_ThrowInternalError(ctx, "generateSelfSignedCert: base64 encoding failed");
  }

  dbuf_init2(&db, ctx, (void*)&js_realloc);
  dbuf_printf(&db, "-----BEGIN %s-----\n", label);

  for(i = 0; i < n; i += 64)
    dbuf_printf(&db, "%.*s\n", n - i < 64 ? n - i : 64, b64 + i);

  dbuf_printf(&db, "-----END %s-----\n", label);
  js_free(ctx, b64);

  /* ArrayBuffer, not string, to match generateSelfSignedCert()'s documented
     `{cert: ArrayBuffer, key: ArrayBuffer}` return shape (and what
     writePem()/tlsContextOptions() in lib/lws/tls.js expect to hand onward
     as PEM bytes). */
  ret = JS_NewArrayBufferCopy(ctx, db.buf, db.size);
  dbuf_free(&db);
  return ret;
}

JSValue
lwsjs_generate_self_signed_cert(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[]) {
  JSValueConst opts = argc > 0 ? argv[0] : JS_UNDEFINED;
  struct lws_x509_cert_gen_info info;
  char* cn = 0;
  uint8_t* cert_der = 0;
  uint8_t* key_der = 0;
  size_t cert_len = 0, key_len = 0;
  JSValue ret;

  memset(&info, 0, sizeof(info));
  info.is_server = 1;
  info.validity_days = 825;
  info.key_bits = 2048;

  if(JS_IsObject(opts)) {
    if(js_has_property(ctx, opts, "common_name"))
      cn = to_stringfree(ctx, js_get_property(ctx, opts, "common_name"));

    if(!cn || !*cn) {
      str_free(ctx, &cn);

      JSValue altNames = js_get_property(ctx, opts, "alt_names");

      if(JS_IsArray(ctx, altNames))
        cn = to_stringfree(ctx, JS_GetPropertyUint32(ctx, altNames, 0));

      JS_FreeValue(ctx, altNames);
    }

    if(js_has_property(ctx, opts, "days"))
      info.validity_days = to_int32free(ctx, js_get_property(ctx, opts, "days"));

    if(js_has_property(ctx, opts, "key_bits"))
      info.key_bits = to_int32free(ctx, js_get_property(ctx, opts, "key_bits"));
  }

  if(!cn || !*cn) {
    str_free(ctx, &cn);
    cn = js_strdup(ctx, "localhost");
  }

  info.san = cn;

  if(lws_x509_create_cert(NULL, &cert_der, &cert_len, &key_der, &key_len, &info)) {
    js_free(ctx, cn);
    return JS_ThrowInternalError(ctx, "generateSelfSignedCert: certificate generation failed");
  }

  ret = JS_NewObject(ctx);
  JS_SetPropertyStr(ctx, ret, "cert", pem_wrap(ctx, "CERTIFICATE", cert_der, cert_len));
  JS_SetPropertyStr(ctx, ret, "key", pem_wrap(ctx, "RSA PRIVATE KEY", key_der, key_len));

  /* lws_x509_create_cert()'s DER buffers come from plain malloc() in every
     backend that implements it (openssl-x509.c/gnutls-x509.c/mbedtls-x509.c
     all use libc malloc() directly) - free() them the same way. The doc
     comment on lws_x509_create_cert() says to use lws_free(), but that
     (like lws_malloc() and friends) isn't actually an exported symbol in
     this lws version (see lws-misc.h's own "not exported from the library"
     note on lws_malloc()), so it's not usable from here anyway. */
  free(cert_der);
  free(key_der);
  js_free(ctx, cn);

  return ret;
}

#else /* !LWS_WITH_TLS */

JSValue
lwsjs_generate_self_signed_cert(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[]) {
  return JS_ThrowInternalError(ctx, "generateSelfSignedCert: not supported by this build's TLS backend");
}

#endif /* LWS_WITH_TLS */

#ifdef LWS_WITH_TLS

/* X509Certificate(pemString) - read-only certificate inspection, backed by
   struct lws_x509_cert (libwebsockets/lws-x509.h) instead of any TLS
   backend's native cert type, via lws_x509_info()/lws_x509_verify()/
   lws_x509_cert_fingerprint() - all backend-agnostic. Much smaller surface
   than the old OpenSSL-based version modeled on Node's crypto.X509Certificate
   (no checkHost/checkEmail/checkIP/checkPrivateKey/verify-with-a-raw-key,
   no keyUsage/subjectAltName/infoAccess/serialNumber, no error/errorDepth):
   lws's public API doesn't expose hostname/email/IP SAN matching, arbitrary
   extension access, or a way to check a cert against a raw key, and the
   error/errorDepth pair only ever made sense wrapping a
   LWS_CALLBACK_OPENSSL_PERFORM_*_CERT_VERIFICATION-supplied X509_STORE_CTX*,
   a reason pair with no backend-agnostic equivalent (see lws-tls.h). What's
   left: commonName/issuer/validFromDate/validToDate/raw/publicKey/
   authorityKeyId/subjectKeyId as properties, fingerprint()/checkIssued()/
   toString() as methods. */
JSClassID lwsjs_x509_class_id;
static JSValue lwsjs_x509_proto, lwsjs_x509_ctor;

typedef struct lws_x509_cert LWSX509Cert;

enum {
  X509_PROP_COMMON_NAME,
  X509_PROP_ISSUER,
  X509_PROP_VALID_FROM_DATE,
  X509_PROP_VALID_TO_DATE,
  X509_PROP_RAW,
  X509_PROP_PUBLIC_KEY,
  X509_PROP_AUTHORITY_KEY_ID,
  X509_PROP_SUBJECT_KEY_ID,
};

enum {
  X509_METHOD_CHECK_ISSUED,
  X509_METHOD_FINGERPRINT,
  X509_METHOD_TO_STRING,
};

static LWSX509Cert*
lwsjs_x509_data(JSValueConst val) {
  return JS_GetOpaque(val, lwsjs_x509_class_id);
}

/* Generously-sized scratch buffer for lws_x509_info() - see its doc comment
   for why the `len` argument has to be computed this way: callers give it a
   buffer bigger than sizeof(union lws_tls_cert_info_results) and tell it
   how much bigger via `len`, and it treats buf->ns.name as extending into
   that extra space rather than being capped at its declared name[64]. 8KiB
   comfortably covers any cert this is likely to see (SPKI DER for even a
   4096-bit RSA key is under 1KiB; a name with a couple of SANs is a few
   hundred bytes) - if lws_x509_info() ever returns -1 for a genuinely
   bigger cert, buf->ns.len holds the size it actually needed, but nothing
   here retries larger since that's not expected in practice. */
#define X509_INFO_BUF_SIZE 8192

static BOOL
x509_info(LWSX509Cert* x509, enum lws_tls_cert_info type, uint8_t* buf) {
  union lws_tls_cert_info_results* r = (union lws_tls_cert_info_results*)buf;

  return lws_x509_info(x509, type, r, X509_INFO_BUF_SIZE - sizeof(*r) + sizeof(r->ns.name)) == 0;
}

static JSValue
x509_info_string(LWSX509Cert* x509, JSContext* ctx, enum lws_tls_cert_info type) {
  uint8_t buf[X509_INFO_BUF_SIZE];
  union lws_tls_cert_info_results* r = (union lws_tls_cert_info_results*)buf;

  if(!x509_info(x509, type, buf))
    return JS_UNDEFINED;

  return JS_NewStringLen(ctx, r->ns.name, (size_t)r->ns.len);
}

static JSValue
x509_info_bytes(LWSX509Cert* x509, JSContext* ctx, enum lws_tls_cert_info type) {
  uint8_t buf[X509_INFO_BUF_SIZE];
  union lws_tls_cert_info_results* r = (union lws_tls_cert_info_results*)buf;

  if(!x509_info(x509, type, buf))
    return JS_NULL;

  return JS_NewArrayBufferCopy(ctx, (const uint8_t*)r->ns.name, (size_t)r->ns.len);
}

static JSValue
x509_info_date(LWSX509Cert* x509, JSContext* ctx, enum lws_tls_cert_info type) {
  uint8_t buf[X509_INFO_BUF_SIZE];
  union lws_tls_cert_info_results* r = (union lws_tls_cert_info_results*)buf;
  JSValue global, ctor, ret, arg;

  if(!x509_info(x509, type, buf))
    return JS_UNDEFINED;

  global = JS_GetGlobalObject(ctx);
  ctor = JS_GetPropertyStr(ctx, global, "Date");
  JS_FreeValue(ctx, global);

  arg = JS_NewFloat64(ctx, (double)r->time * 1000.0);
  ret = JS_CallConstructor(ctx, ctor, 1, &arg);
  JS_FreeValue(ctx, ctor);

  return ret;
}

static JSValue
lwsjs_x509_get(JSContext* ctx, JSValueConst this_val, int magic) {
  LWSX509Cert* x509;

  if(!(x509 = lwsjs_x509_data(this_val)))
    return JS_UNDEFINED;

  switch(magic) {
    case X509_PROP_COMMON_NAME: return x509_info_string(x509, ctx, LWS_TLS_CERT_INFO_COMMON_NAME);
    case X509_PROP_ISSUER: return x509_info_string(x509, ctx, LWS_TLS_CERT_INFO_ISSUER_NAME);
    case X509_PROP_VALID_FROM_DATE: return x509_info_date(x509, ctx, LWS_TLS_CERT_INFO_VALIDITY_FROM);
    case X509_PROP_VALID_TO_DATE: return x509_info_date(x509, ctx, LWS_TLS_CERT_INFO_VALIDITY_TO);
    case X509_PROP_RAW: return x509_info_bytes(x509, ctx, LWS_TLS_CERT_INFO_DER_RAW);
    case X509_PROP_PUBLIC_KEY: return x509_info_bytes(x509, ctx, LWS_TLS_CERT_INFO_DER_SPKI);
    case X509_PROP_AUTHORITY_KEY_ID: return x509_info_bytes(x509, ctx, LWS_TLS_CERT_INFO_AUTHORITY_KEY_ID);
    case X509_PROP_SUBJECT_KEY_ID: return x509_info_bytes(x509, ctx, LWS_TLS_CERT_INFO_SUBJECT_KEY_ID);
  }

  return JS_UNDEFINED;
}

static JSValue
lwsjs_x509_methods(JSContext* ctx, JSValueConst this_val, int argc, JSValueConst argv[], int magic) {
  LWSX509Cert* x509;

  if(!(x509 = lwsjs_x509_data(this_val)))
    return JS_EXCEPTION;

  switch(magic) {
    case X509_METHOD_CHECK_ISSUED: {
      LWSX509Cert* other;

      if(!(other = lwsjs_x509_data(argv[0])))
        return JS_ThrowTypeError(ctx, "checkIssued: expected X509Certificate");

      /* lws_x509_verify(a, b, NULL) returns 0 if `a` is validly signed by
         `b` - i.e. `b` issued `a`. checkIssued(other) asks "did other issue
         *this*", so this is the callee, argv[0] the candidate issuer. */
      return JS_NewBool(ctx, lws_x509_verify(x509, other, NULL) == 0);
    }

    case X509_METHOD_FINGERPRINT: {
      const char* name = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
      int type = LWS_GENHASH_TYPE_SHA1;
      uint8_t buf[LWS_GENHASH_LARGEST];
      char out[LWS_GENHASH_LARGEST * 3], *p = out;
      int len, i;

      if(name) {
        if(!strcmp(name, "sha256"))
          type = LWS_GENHASH_TYPE_SHA256;
        else if(!strcmp(name, "sha384"))
          type = LWS_GENHASH_TYPE_SHA384;
        else if(!strcmp(name, "sha512"))
          type = LWS_GENHASH_TYPE_SHA512;
        else if(!strcmp(name, "md5"))
          type = LWS_GENHASH_TYPE_MD5;

        JS_FreeCString(ctx, name);
      }

      if((len = lws_x509_cert_fingerprint(x509, type, buf, sizeof(buf))) <= 0)
        return JS_NULL;

      for(i = 0; i < len; i++) {
        if(i)
          *p++ = ':';

        p += sprintf(p, "%02X", buf[i]);
      }

      *p = 0;
      return JS_NewString(ctx, out);
    }

    case X509_METHOD_TO_STRING: {
      uint8_t buf[X509_INFO_BUF_SIZE];
      union lws_tls_cert_info_results* r = (union lws_tls_cert_info_results*)buf;

      if(!x509_info(x509, LWS_TLS_CERT_INFO_DER_RAW, buf))
        return JS_UNDEFINED;

      return pem_wrap(ctx, "CERTIFICATE", (const uint8_t*)r->ns.name, (size_t)r->ns.len);
    }
  }

  return JS_UNDEFINED;
}

static void
lwsjs_x509_finalizer(JSRuntime* rt, JSValue val) {
  LWSX509Cert* x509;

  if((x509 = JS_GetOpaque(val, lwsjs_x509_class_id)))
    lws_x509_destroy(&x509);
}

/* new X509Certificate(pem) - `pem` is a PEM string (or an ArrayBuffer/view
   of PEM text). Unlike the old OpenSSL-based constructor, DER input isn't
   supported: lws_x509_parse_from_pem() (libwebsockets/lws-x509.h) is the
   only backend-agnostic parse entry point lws exposes, and it's PEM-only. */
static JSValue
lwsjs_x509_constructor(JSContext* ctx, JSValueConst new_target, int argc, JSValueConst argv[]) {
  LWSX509Cert* x509 = NULL;
  uint8_t* buf;
  size_t len;
  char* str = NULL;
  JSValue proto, obj;

  if(argc < 1)
    return JS_ThrowTypeError(ctx, "X509Certificate: expected a PEM string");

  /* lws_x509_parse_from_pem() requires the last used byte to be '\0' and
     len to include it - str_property()/JS_ToCStringLen() already
     NUL-terminate, so pass len+1; a raw ArrayBuffer of PEM text usually
     isn't NUL-terminated, so copy it into a NUL-terminated buffer first. */
  if((buf = get_buffer(ctx, 1, argv, &len))) {
    if((str = js_malloc(ctx, len + 1))) {
      memcpy(str, buf, len);
      str[len] = '\0';
    }
  } else {
    const char* cstr;
    size_t clen;

    if((cstr = JS_ToCStringLen(ctx, &clen, argv[0]))) {
      str = js_strndup(ctx, cstr, clen);
      len = clen;
      JS_FreeCString(ctx, cstr);
    }
  }

  if(!str)
    return JS_ThrowTypeError(ctx, "X509Certificate: expected a PEM string");

  if(lws_x509_create(&x509) || lws_x509_parse_from_pem(x509, str, len + 1)) {
    js_free(ctx, str);

    if(x509)
      lws_x509_destroy(&x509);

    return JS_ThrowTypeError(ctx, "X509Certificate: invalid certificate data");
  }

  js_free(ctx, str);

  proto = JS_GetPropertyStr(ctx, new_target, "prototype");
  if(JS_IsException(proto))
    proto = JS_DupValue(ctx, lwsjs_x509_proto);

  obj = JS_NewObjectProtoClass(ctx, proto, lwsjs_x509_class_id);
  JS_FreeValue(ctx, proto);

  if(JS_IsException(obj)) {
    lws_x509_destroy(&x509);
    return obj;
  }

  JS_SetOpaque(obj, x509);
  return obj;
}

static const JSClassDef lws_x509_class = {
    "X509Certificate",
    .finalizer = lwsjs_x509_finalizer,
};

static const JSCFunctionListEntry lws_x509_proto_funcs[] = {
    JS_CGETSET_MAGIC_DEF("commonName", lwsjs_x509_get, 0, X509_PROP_COMMON_NAME),
    JS_CGETSET_MAGIC_DEF("issuer", lwsjs_x509_get, 0, X509_PROP_ISSUER),
    JS_CGETSET_MAGIC_DEF("validFromDate", lwsjs_x509_get, 0, X509_PROP_VALID_FROM_DATE),
    JS_CGETSET_MAGIC_DEF("validToDate", lwsjs_x509_get, 0, X509_PROP_VALID_TO_DATE),
    JS_CGETSET_MAGIC_DEF("raw", lwsjs_x509_get, 0, X509_PROP_RAW),
    JS_CGETSET_MAGIC_DEF("publicKey", lwsjs_x509_get, 0, X509_PROP_PUBLIC_KEY),
    JS_CGETSET_MAGIC_DEF("authorityKeyId", lwsjs_x509_get, 0, X509_PROP_AUTHORITY_KEY_ID),
    JS_CGETSET_MAGIC_DEF("subjectKeyId", lwsjs_x509_get, 0, X509_PROP_SUBJECT_KEY_ID),
    JS_CFUNC_MAGIC_DEF("checkIssued", 1, lwsjs_x509_methods, X509_METHOD_CHECK_ISSUED),
    JS_CFUNC_MAGIC_DEF("fingerprint", 0, lwsjs_x509_methods, X509_METHOD_FINGERPRINT),
    JS_CFUNC_MAGIC_DEF("toString", 0, lwsjs_x509_methods, X509_METHOD_TO_STRING),
    JS_PROP_STRING_DEF("[Symbol.toStringTag]", "X509Certificate", JS_PROP_CONFIGURABLE),
};

int
lwsjs_tls_certverify_init(JSContext* ctx, JSModuleDef* m) {
  JS_NewClassID(&lwsjs_x509_class_id);
  JS_NewClass(JS_GetRuntime(ctx), lwsjs_x509_class_id, &lws_x509_class);
  lwsjs_x509_proto = JS_NewObjectProto(ctx, JS_NULL);
  JS_SetPropertyFunctionList(ctx, lwsjs_x509_proto, lws_x509_proto_funcs, countof(lws_x509_proto_funcs));

  lwsjs_x509_ctor = JS_NewCFunction2(ctx, lwsjs_x509_constructor, "X509Certificate", 1, JS_CFUNC_constructor, 0);
  JS_SetConstructor(ctx, lwsjs_x509_ctor, lwsjs_x509_proto);

  if(m)
    JS_SetModuleExport(ctx, m, "X509Certificate", lwsjs_x509_ctor);

  return 0;
}

#endif /* LWS_WITH_TLS */
