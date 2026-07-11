import { Body } from './lws/body.js';
import createContext from './lws/context.js';
import { Headers } from './lws/headers.js';
import { Request } from './lws/request.js';
import { Response } from './lws/response.js';
import { ReadableStream } from './lws/streams.js';
import { ConnectionError, debug, define } from './lws/util.js';
import { getCallbackName, LCCSCF_ALLOW_SELFSIGNED, LCCSCF_H2_PRIOR_KNOWLEDGE, LCCSCF_HTTP_MULTIPART_MIME, LCCSCF_PIPELINE, LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT, LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX, LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT, LWS_SERVER_OPTION_IGNORE_MISSING_CERT, LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED, LWS_SERVER_OPTION_REDIRECT_HTTP_TO_HTTPS, } from 'lws';

const log = debug;

/*
 * One context (and the single 'http' protocol registered on it) is reused
 * across calls by default, so LCCSCF_PIPELINE can actually queue (h1) or
 * mux (h2) repeat requests onto an existing connection instead of always
 * opening a new one - the point of a crawler doing many requests to the
 * same host. Because many requests now share one protocol object, each
 * request's state (req/resp/resolve/reject/controller) is attached
 * directly to the wsi object clientConnect() returns rather than closed
 * over - every callback for that connection receives that same wrapper.
 */
let sharedContext;

// clientConnect() fires callbacks synchronously, before it returns the
// wsi - too early to attach per-call state onto the returned object by
// property assignment afterwards. Worse, which callback fires *first*
// for a given wsi depends on whether LCCSCF_PIPELINE queued it behind an
// existing connection: a fresh "leader" gets onServerNewClientInstantiated
// first, but a queued/piggybacked wsi's first callback is
// onClientAppendHandshakeHeader instead - onServerNewClientInstantiated
// never fires for it at all.
//
// `pending` bridges the gap regardless of which callback goes first:
// fetch() fills it in right before calling clientConnect(), and every
// callback below calls transferPending(wsi) as its first line, which
// moves it onto `wsi` (once) before any other clientConnect() call
// (single-threaded JS) could overwrite it. This assumes callers await
// each fetch() before starting the next - true overlapping/concurrent
// fetch() calls could race here.
let pending;

function transferPending(wsi) {
  if(pending && wsi.req === undefined) {
    define(wsi, pending);
    pending = undefined;
    wsi.pwsi?.(wsi);
  }
}

function httpProtocol() {
  return {
    name: 'http',
    onServerNewClientInstantiated(wsi) {
      transferPending(wsi);
    },
    onEstablishedClientHttp(wsi, status) {
      transferPending(wsi);

      const { h2, headers, uri: url } = wsi;

      log('onEstablishedClientHttp', { wsi, status, h2, headers });

      wsi.resp.status = status;
      wsi.resp.headers = new Headers(headers);
      wsi.resolve(wsi.resp);
    },
    onClientAppendHandshakeHeader(wsi, data, len) {
      transferPending(wsi);

      for(const [name, value] of wsi.req.headers) wsi.addHeader(name, value, data, len);

      if(!wsi.redirectedToGet && wsi.method == 'POST') wsi.bodyPending = 1;
    },
    onClientHttpRedirect(wsi, url, status) {
      transferPending(wsi);
      log('onClientHttpRedirect', wsi, url, status);

      wsi.resp.status = status;
      wsi.resp.headers = new Headers(wsi.headers);
    },
    onReceiveClientHttpRead(wsi, data) {
      transferPending(wsi);
      log('onReceiveClientHttpRead', wsi, data.byteLength);
      wsi.controller.readable.enqueue(new Uint8Array(data));
    },
    onReceiveClientHttp(wsi, buf, len) {
      transferPending(wsi);

      if(buf || len) log('onReceiveClientHttp', wsi, buf, len);

      const ab = new ArrayBuffer(0xff0 * 16);
      let ret;

      try {
        ret = wsi.httpClientRead(ab);
      } catch(e) {
        console.log('exception', e);
      }

      if(ret) this.onReceiveClientHttpRead(wsi, ab);
    },
    onCompletedClientHttp(wsi) {
      log('onCompletedClientHttp', wsi);
      wsi.controller.readable.close();
    },
    onClosedClientHttp(wsi) {
      transferPending(wsi);
      log('onClosedClientHttp', wsi);
      wsi.resolve(wsi.resp);
      if(wsi.ctx !== sharedContext) wsi.ctx.cancelService();
    },
    onClientConnectionError(wsi, msg, errno) {
      transferPending(wsi);
      log('onClientConnectionError', { msg, errno });
      wsi.reject?.(new ConnectionError(msg));
      if(wsi.ctx !== sharedContext) wsi.ctx.cancelService();
    },
    onClientHttpDropProtocol(wsi) {
      log('onClientHttpDropProtocol', wsi);
      /* Connection dropped without onCompletedClientHttp/onClosedClientHttp/
       * onClientConnectionError ever firing (e.g. the server rejected/reset
       * the request) - settle the promise and error the body stream so
       * callers don't hang forever instead of seeing a rejection. Harmless
       * no-op if the promise/stream was already settled. */
      wsi.reject?.(new ConnectionError('dropped'));
      wsi.controller?.readable?.error(new ConnectionError('dropped'));
    },
    callback(wsi, reason, ...args) {
      log('on' + getCallbackName(reason), wsi, args);
    },
  };
}

function buildContext(tls) {
  return createContext({
    options: tls
      ? LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT |
        LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX |
        LWS_SERVER_OPTION_IGNORE_MISSING_CERT |
        ('rejectUnauthorized' in tls && !tls.rejectUnauthorized ? LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED | LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT | LWS_SERVER_OPTION_REDIRECT_HTTP_TO_HTTPS : 0)
      : LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT | LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX | LWS_SERVER_OPTION_IGNORE_MISSING_CERT,
    clientSslCa: tls?.ca,
    clientSslCert: tls?.cert,
    clientSslPrivateKey: tls?.key,
    protocols: [httpProtocol()],
  });
}

/**
 * fetch(url, options) - WHATWG-shaped. `options.keepAlive` (default true)
 * reuses a single shared LWSContext/vhost across calls so LCCSCF_PIPELINE
 * can queue/mux onto an existing connection; pass `keepAlive: false` or a
 * custom `tls` to get an isolated one-off context instead (the previous
 * per-call behaviour).
 */
export function fetch(url, options = {}) {
  const { body, method, headers, cache, credentials, mode, signal, tls, keepAlive = true, ...rest } = options;

  const req = new Request(url, { body, method, headers, cache, credentials, mode, signal });
  const controller = {};
  const resp = new Response(new ReadableStream({ start: c => (controller.readable = c) }), {});

  return new Promise((resolve, reject) => {
    const shared = keepAlive && !tls;
    const ctx = shared ? (sharedContext ??= buildContext()) : buildContext(tls);

    rest.local_protocol_name = rest.protocol ??= 'http';
    rest.method ??= req.method ?? 'GET';

    rest.ssl_connection ??= 0;
    rest.ssl_connection |= LCCSCF_ALLOW_SELFSIGNED;
    if(keepAlive) rest.ssl_connection |= LCCSCF_PIPELINE;
    if(rest.h2) rest.ssl_connection |= LCCSCF_H2_PRIOR_KNOWLEDGE;
    if(rest.method == 'POST') rest.ssl_connection |= LCCSCF_HTTP_MULTIPART_MIME;

    rest.alpn ??= rest.h2 === false ? 'http/1.1' : 'h2,http/1.1';

    pending = { ctx, req, resp, resolve, reject, controller, pwsi: options.pwsi };

    const wsi = ctx.clientConnect(req.url, rest);

    if(signal) signal.onabort = () => wsi.close();

    log('rest', rest);
  });
}
