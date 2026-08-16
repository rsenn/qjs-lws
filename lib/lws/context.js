import { CONTEXT_PORT_NO_LISTEN, getLogLevelColour, getLogLevelName, LLL_ERR, LLL_USER, LLL_WARN, logLevel, LWS_SERVER_OPTION_ADOPT_APPLY_LISTEN_ACCEPT_CONFIG, LWSContext } from 'lws.so';
import { tlsContextOptions } from './tls.js';
import { typeIsObject } from './util.js';
import { assert_default as assert } from './assert.js';
import { loadFile } from 'std';
import { stat, realpath } from 'os';

const { DEBUG, HOSTNAME } = process.env;

logLevel((DEBUG ? LLL_USER : 0) | LLL_ERR | LLL_WARN, (level, msg) =>
  console.log('\x1b[2K\r\x1b[0;30m' + getLogLevelColour(level).replace(/\b38\b/g, '48') + centerPad(8, getLogLevelName(level)) + '\x1b[0m ' + msg),
);

const PREFIX = realpath('/proc/self/exe')?.[0]?.replace(/\/bin\/.*/g, '');

const resolvConfFile = 'xresolv.conf';
const etcResolvConf = '/etc/' + resolvConfFile;
const resolvConf = ['/run/systemd/resolve/' + resolvConfFile, PREFIX + etcResolvConf, etcResolvConf].find(p => stat(p)?.[1] == 0);

console.log('resolvConf', resolvConf);

/**
 * Extracts nameserver addresses from a resolv.conf file, filtering out
 * loopback addresses (127.x.x.x) which don't work with lws async DNS.
 *
 * @param  {string} path  Path to resolv.conf file
 * @return {string[]}     Array of DNS server IP addresses
 */
function parseResolvConf(path) {
  if(stat(path)[1]) return [];

  const content = loadFile(path);
  if(!content) return [];

  const servers = [...content.matchAll(/nameserver\s+([\w\d.]+)/g)].map(m => m[1]);

  // Filter out loopback addresses (127.x.x.x) - lws async DNS can't use them
  return servers.filter(ip => !ip.startsWith('127.'));
}

/**
 * Creates an \class LWSContext.
 *
 * @param  {object} info  struct lws_context_creation_info
 * @return {object}       LWSContext object
 */
export function createContext(info = {}) {
  info.options ??= 0;
  info.port ??= CONTEXT_PORT_NO_LISTEN;
  info.vhostName ??= HOSTNAME ?? loadFile('/etc/hostname')?.trimEnd();

  if(empty(info.asyncDnsServers))
    // Try /etc/resolv.conf first, then systemd-resolved's actual config
    info.asyncDnsServers = parseResolvConf(resolvConf);

  if(empty(info.asyncDnsServers)) info.asyncDnsServers = ['8.8.8.8', '8.8.4.4', '4.2.2.1'];

  //console.log('asyncDnsServers', info.asyncDnsServers);

  /** @see: https://bun.com/docs/api/fetch#tls */
  if('tls' in info) {
    const { options: tlsOptions = 0, ...rest } = tlsContextOptions(info.tls);

    info.options |= tlsOptions;
    Object.assign(info, rest);
  }

  if(typeIsObject(info.protocols)) {
    if(!Array.isArray(info.protocols)) {
      const protocols = [];

      for(const name in info.protocols) {
        assert(typeIsObject(info.protocols[name]));
        let p = info.protocols[name];

        if(typeof p == 'function') p = { name, callback: p };
        else p.name = name;

        protocols.push(p);
      }

      info.protocols = protocols;
    } else {
      if(typeof info.protocols[0] == 'function') info.protocols = info.protocols.map(p => ({ name: p.name, callback: p }));
    }
  }

  // info.options |= LWS_SERVER_OPTION_ADOPT_APPLY_LISTEN_ACCEPT_CONFIG;

  //console.log('info', info);

  const lws = new LWSContext(info);

  for(let dnsServer of info.asyncDnsServers) {
    lws.asyncDnsServerAdd(dnsServer);
  }

  return lws;
}

/**
 * Is not an array or array is empty.
 *
 * @param  {object} obj  Array object
 * @return {boolean}     false if Array contains elements
 */
function empty(obj) {
  return !Array.isArray(obj) || obj?.length == 0;
}

/**
 * Center a string by padding.
 *
 * @param  {number} len  Resulting string length
 * @param  {string} str  The string
 * @param  {string} ch   The padding character
 * @return {string}      Padded string
 */
function centerPad(len, str, ch = ' ') {
  len = Math.max(0, len - str.length);
  const start = ch.repeat(Math.floor(len / 2));
  return start + str + ch.repeat(len - start.length);
}

export default createContext;

/**
 * Ref-counts users of a lazily-created, shared `LWSContext` so the last
 * release can destroy it - freeing the os.setReadHandler/setTimeout service
 * registrations that would otherwise keep a script alive with nothing left
 * to do(see `service_tick`/`service_tick_schedule` in lws-context.c).
 *
 * Each user is tracked by an opaque `key` - a wsi, for the evented classes
 * that dispatch 'close'/'error' through one shared callback per class
 * (`TCPSocket`, `UDPSocket`, `WebSocket`), or the instance itself, for the
 * Promise-based `*Stream` classes (`TCPSocketStream`, `UDPSocketStream`,
 * `WebSocketStream`) - so `release()` is safe to call more than once, or
 * from more than one event, for the same user: a `WeakSet` remembers
 * whether `key` still holds a ref, and a redundant release is a no-op
 * rather than a double-decrement.
 *
 * `destroy` is called at most once, when the last ref releases (and, if
 * `markServer()` was ever called, never again) - resetting whatever static
 * fields hold the context/adapter/sockets-map is the caller's job, since
 * those differ per class; this only tracks *when* to do it.
 */
export class ContextRefCounter {
  #count = 0;
  #serverMode = false;
  #keys = new WeakSet();
  #destroy;

  constructor(destroy) {
    this.#destroy = destroy;
  }

  /**
   * Permanently disables auto-destroy - for a context that's hosting a
   * long-lived listen()/bind() socket whose own lifecycle isn't tracked
   * here (see lib/tcpsocket.js's/lib/udpsocket.js's `#serverMode` doc): a
   * server is expected to run until something explicitly closes it, not
   * get torn down the moment its connection count happens to hit zero.
   */
  markServer() {
    this.#serverMode = true;
  }

  /** Registers a ref held under `key`. */
  add(key) {
    this.#keys.add(key);
    this.#count++;
  }

  /**
   * Releases the ref held under `key`, if one is still outstanding (safe to
   * call more than once, or for a key that was never `add()`ed). Once the
   * last ref is gone - and `markServer()` was never called - runs `destroy`.
   *
   * `destroy` is deferred to a microtask rather than called synchronously:
   * `release()` is typically reached from a wsi's native 'close' callback
   * (see lib/tcpsocket.js et al.), and `LWSContext#destroy()` ->
   * `lws_context_destroy()` (lws-context.c) has no guard against running
   * while lws is still unwinding `lws_close_free_wsi()` for a wsi owned by
   * that same context - calling it synchronously from within that callback
   * is a use-after-free. Deferring lets the native close finish first.
   *
   * The ref count is rechecked once the microtask actually runs, not just
   * when it's scheduled: a new `add()` can land in between (e.g. a fresh
   * connection reusing the shared context right after the previous one's
   * last ref released) - destroying on stale zero-count information would
   * pull the context out from under that new user.
   */
  release(key) {
    if(!this.#keys.delete(key)) return;
    if(--this.#count > 0 || this.#serverMode) return;

    Promise.resolve().then(() => {
      if(this.#count === 0 && !this.#serverMode) this.#destroy();
    });
  }

  /**
   * Convenience for the Promise-based `*Stream` classes: `add()`s `key` now,
   * then `release()`s it once whichever of `opened`/`closed` settles first.
   * `closed` only settles once a wsi actually existed and got torn down
   * (`StreamAdapter#close`, see lib/lws/protocols.js); a wsi that never
   * opened (`StreamAdapter#error`, which only rejects `opened`) leaves
   * `closed` pending forever, so `opened`'s rejection is the release signal
   * for that case instead.
   */
  track(key, opened, closed) {
    this.add(key);
    closed.then(() => this.release(key));
    opened.catch(() => this.release(key));
  }
}
