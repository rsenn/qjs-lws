/**
 * TLS/SSL configuration: key material, certs, and the crypto-relevant lws
 * option flags - shared by lib/lws/context.js and lib/fetch.js so both
 * derive `ssl_connection`/context `options` bits from the same
 * `options.tls` shape instead of each hand-rolling their own version (which
 * is how they ended up setting the wrong native property names -
 * `sslCert`/`clientSslCert`/etc, silently ignored by the native
 * `server_ssl_cert`/`client_ssl_cert`/etc parser - for however long that
 * bug had been sitting there unnoticed).
 *
 * `options.tls` (matches Node/Bun's `tls` option loosely):
 *
 *   - falsy: no TLS.
 *   - `true`: TLS wanted, no cert given - a self-signed one is generated on
 *     the spot (a fresh one per call; pass `{ dir: '...' }` instead to
 *     reuse the same cert/key across restarts).
 *   - `{ cert, key, ca, rejectUnauthorized, dir, ...selfSignedOptions }` -
 *     `cert`/`key`/`ca` are each a filesystem path (string) or raw PEM/DER
 *     bytes (ArrayBuffer/view). If `cert`/`key` are both missing, the same
 *     self-signed fallback as `tls: true` kicks in, using `dir` and the
 *     rest of `tls` (commonName/altNames/days/keyBits) as
 *     generateSelfSignedCert() options.
 */
import {
  generateSelfSignedCert as nativeGenerateSelfSignedCert,
  toArrayBuffer,
  toString,
  LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT,
  LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX,
  LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT,
  LWS_SERVER_OPTION_IGNORE_MISSING_CERT,
  LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED,
  LWS_SERVER_OPTION_REDIRECT_HTTP_TO_HTTPS,
  LCCSCF_ALLOW_EXPIRED,
  LCCSCF_ALLOW_INSECURE,
  LCCSCF_ALLOW_SELFSIGNED,
  LCCSCF_SKIP_SERVER_CERT_HOSTNAME_CHECK,
} from 'lws.so';
import { loadFile, open } from 'std';
import { mkdir, stat } from 'os';

/**
 * Generates a self-signed certificate/key pair, both PEM-encoded.
 *
 * @param  {object}   [options]
 * @param  {string}   [options.commonName='localhost']
 * @param  {string[]} [options.altNames]    Defaults to `[commonName]`. Each
 *                                          entry becomes a DNS: or IP:
 *                                          SAN entry, auto-detected.
 * @param  {number}   [options.days=825]    Validity period.
 * @param  {number}   [options.keyBits=2048] RSA key size.
 * @return {{cert: ArrayBuffer, key: ArrayBuffer}}
 */
export function generateSelfSignedCert(options) {
  return nativeGenerateSelfSignedCert(options ?? {});
}

/**
 * Like generateSelfSignedCert(), but persisted to `dir/cert.pem` +
 * `dir/key.pem`: returns the existing pair if both files are already
 * there, otherwise generates a fresh self-signed cert and writes it before
 * returning it - so a server started with `tls: { dir: '...' }` reuses the
 * same cert/key (and the same "this is the site I already told my browser
 * to trust" identity) across restarts instead of minting a new one every
 * time.
 *
 * @param  {string} dir
 * @param  {object} [options]  Same as generateSelfSignedCert(), used only
 *                             when generating a fresh pair.
 * @return {{cert: ArrayBuffer, key: ArrayBuffer}}
 */
export function loadOrCreateCert(dir, options) {
  const certPath = `${dir}/cert.pem`;
  const keyPath = `${dir}/key.pem`;

  const certPem = loadFile(certPath);
  const keyPem = loadFile(keyPath);

  if(certPem != null && keyPem != null) return { cert: toArrayBuffer(certPem), key: toArrayBuffer(keyPem) };

  const { cert, key } = generateSelfSignedCert(options);

  if(stat(dir)[1] !== 0) mkdir(dir, 0o700);

  writePem(certPath, cert);
  writePem(keyPath, key);

  return { cert, key };
}

function writePem(path, arrayBuffer) {
  const f = open(path, 'w');

  f.puts(toString(arrayBuffer));
  f.close();
}

function resolveTls(tls) {
  const opts = tls === true ? {} : tls;

  return opts.cert && opts.key ? opts : { ...opts, ...(opts.dir ? loadOrCreateCert(opts.dir, opts) : generateSelfSignedCert(opts)) };
}

/**
 * The fields createContext() needs on its `lws_context_creation_info` for
 * `options.tls` - the crypto-relevant `LWS_SERVER_OPTION_*` bits, plus
 * `server_ssl_*`/`client_ssl_*` (this binding models a single default
 * vhost used for both directions, so both sides get the same material).
 *
 * @param  {true|object} tls
 * @return {object}      Fields to merge into `lws_context_creation_info`,
 *                       or `{}` if `tls` is falsy.
 */
export function tlsContextOptions(tls) {
  if(!tls) return {};

  const opts = resolveTls(tls);

  const options =
    LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT |
    LWS_SERVER_OPTION_CREATE_VHOST_SSL_CTX |
    LWS_SERVER_OPTION_IGNORE_MISSING_CERT |
    ('rejectUnauthorized' in opts && !opts.rejectUnauthorized
      ? LWS_SERVER_OPTION_PEER_CERT_NOT_REQUIRED | LWS_SERVER_OPTION_ALLOW_NON_SSL_ON_SSL_PORT | LWS_SERVER_OPTION_REDIRECT_HTTP_TO_HTTPS
      : 0);

  return {
    options,
    server_ssl_ca: opts.ca,
    server_ssl_cert: opts.cert,
    server_ssl_private_key: opts.key,
    client_ssl_ca: opts.ca,
    client_ssl_cert: opts.cert,
    client_ssl_private_key: opts.key,
  };
}

/**
 * The crypto-relevant `ssl_connection` (LCCSCF_*) flags for one outbound
 * `ctx.clientConnect()` call, from the same `tls` shape
 * tlsContextOptions() takes. Separate from that function because these are
 * per-connect-call flags, not context-creation fields (lib/fetch.js is the
 * caller - one shared/pooled context can serve calls with different `tls`
 * postures).
 *
 * @param  {true|object} tls
 * @return {number}      `ssl_connection` (LCCSCF_*) bits to OR in, or `0`.
 */
export function tlsConnectFlags(tls) {
  if(!tls) return 0;

  const opts = tls === true ? {} : tls;

  return 'rejectUnauthorized' in opts && !opts.rejectUnauthorized ? LCCSCF_ALLOW_SELFSIGNED | LCCSCF_ALLOW_INSECURE | LCCSCF_ALLOW_EXPIRED | LCCSCF_SKIP_SERVER_CERT_HOSTNAME_CHECK : 0;
}
