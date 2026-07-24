#include "lws-mount.h"
#include "lws-vhost-option.h"
#include "js-utils.h"

struct lws_http_mount*
lwsjs_http_mount_from(JSContext* ctx, JSValueConst obj, const char* name) {
  struct lws_http_mount* m;
  JSValue value;

  if(!(m = js_mallocz(ctx, sizeof(struct lws_http_mount))))
    return NULL;

  if(name) {
    m->mountpoint = js_strdup(ctx, name);
    m->mountpoint_len = strlen(name);
  }

  if(JS_IsArray(ctx, obj)) {
    int i = 0;

    if(!name) {
      value = JS_GetPropertyUint32(ctx, obj, i++);
      m->mountpoint = to_stringfree(ctx, value);
      m->mountpoint_len = strlen(m->mountpoint);
    }

    value = JS_GetPropertyUint32(ctx, obj, i++);
    m->origin = to_stringfree(ctx, value);

    value = JS_GetPropertyUint32(ctx, obj, i++);
    m->def = to_stringfree(ctx, value);

    value = JS_GetPropertyUint32(ctx, obj, i++);
    m->protocol = to_stringfree(ctx, value);

    value = JS_GetPropertyUint32(ctx, obj, i++);
    m->basic_auth_login_file = to_stringfree(ctx, value);

  } else if(JS_IsObject(obj)) {
    value = JS_GetPropertyStr(ctx, obj, "mountpoint");

    m->mountpoint = to_stringfree(ctx, value);
    m->mountpoint_len = strlen(m->mountpoint);

    value = JS_GetPropertyStr(ctx, obj, "origin");
    m->origin = to_stringfree(ctx, value);

    value = JS_GetPropertyStr(ctx, obj, "def");
    m->def = to_stringfree(ctx, value);

    value = JS_GetPropertyStr(ctx, obj, "protocol");
    m->protocol = to_stringfree(ctx, value);

    value = JS_GetPropertyStr(ctx, obj, "cgienv");
    m->cgienv = lwsjs_vhost_options_fromfree(ctx, value);

    value = js_get_property(ctx, obj, "extra_mimetypes");
    m->extra_mimetypes = lwsjs_vhost_options_fromfree(ctx, value);

    value = JS_GetPropertyStr(ctx, obj, "interpret");
    m->interpret = lwsjs_vhost_options_fromfree(ctx, value);

    value = js_get_property(ctx, obj, "cgi_timeout");
    m->cgi_timeout = to_integerfree(ctx, value);

    value = js_get_property(ctx, obj, "cache_max_age");
    m->cache_max_age = to_integerfree(ctx, value);

    value = js_get_property(ctx, obj, "auth_mask");
    m->auth_mask = to_integerfree(ctx, value);

    value = js_get_property(ctx, obj, "cache_reusable");
    m->cache_reusable = to_boolfree(ctx, value);

    value = js_get_property(ctx, obj, "cache_revalidate");
    m->cache_revalidate = to_boolfree(ctx, value);

    value = js_get_property(ctx, obj, "cache_intermediaries");
    m->cache_intermediaries = to_boolfree(ctx, value);

    /*value = js_get_property(ctx, obj, "cache_no");
    m->cache_no = to_boolfree(ctx, value);*/

    value = js_get_property(ctx, obj, "origin_protocol");
    m->origin_protocol = to_integerfree(ctx, value);

    value = js_get_property(ctx, obj, "basic_auth_login_file");
    m->basic_auth_login_file = to_stringfree(ctx, value);
  }

  return m;
}

const struct lws_http_mount*
lwsjs_http_mounts_from(JSContext* ctx, JSValueConst value) {
  const struct lws_http_mount *m = 0, **ptr = &m, *tmp;
  uint32_t len;

  if(JS_IsArray(ctx, value) && (len = to_uint32free(ctx, JS_GetPropertyStr(ctx, value, "length"))) > 0) {
    if(!(m = js_malloc(ctx, sizeof(struct lws_http_mount))))
      return NULL;

    for(uint32_t i = 0; i < len; i++) {
      JSValue obj = JS_GetPropertyUint32(ctx, value, i);

      if((*ptr = tmp = lwsjs_http_mount_from(ctx, obj, 0)))
        ptr = (const struct lws_http_mount**)&(*ptr)->mount_next;

      JS_FreeValue(ctx, obj);

      if(!tmp)
        break;
    }
  } else if(JS_IsObject(value)) {
    JSPropertyEnum* tmp_tab = 0;

    if(!JS_GetOwnPropertyNames(ctx, &tmp_tab, &len, value, JS_GPN_STRING_MASK | JS_GPN_SET_ENUM)) {
      for(uint32_t i = 0; i < len; i++) {
        const char* name = JS_AtomToCString(ctx, tmp_tab[i].atom);
        JSValue obj = JS_GetProperty(ctx, value, tmp_tab[i].atom);

        if((*ptr = tmp = lwsjs_http_mount_from(ctx, obj, name)))
          ptr = (const struct lws_http_mount**)&(*ptr)->mount_next;

        JS_FreeCString(ctx, name);
        JS_FreeValue(ctx, obj);

        if(!tmp)
          break;
      }
    }
  }

  return m;
}

void
lwsjs_http_mounts_free(JSRuntime* rt, struct lws_http_mount* m) {
  do {
    if(m->mountpoint) {
      js_free_rt(rt, (char*)m->mountpoint);
      m->mountpoint = 0;
    }

    if(m->origin) {
      js_free_rt(rt, (char*)m->origin);
      m->origin = 0;
    }

    if(m->def) {
      js_free_rt(rt, (char*)m->def);
      m->def = 0;
    }

    if(m->protocol) {
      js_free_rt(rt, (char*)m->protocol);
      m->protocol = 0;
    }

    if(m->cgienv) {
      lwsjs_vhost_options_free(rt, (struct lws_protocol_vhost_options*)m->cgienv);
      m->cgienv = 0;
    }

    if(m->extra_mimetypes) {
      lwsjs_vhost_options_free(rt, (struct lws_protocol_vhost_options*)m->extra_mimetypes);
      m->extra_mimetypes = 0;
    }

    if(m->interpret) {
      lwsjs_vhost_options_free(rt, (struct lws_protocol_vhost_options*)m->interpret);
      m->interpret = 0;
    }

    if(m->basic_auth_login_file) {
      js_free_rt(rt, (char*)m->basic_auth_login_file);
      m->basic_auth_login_file = 0;
    }
  } while((m = (struct lws_http_mount*)m->mount_next));
}
