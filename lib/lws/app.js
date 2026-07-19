/**
 * Express-style middleware chain on top of qjs-lws.
 *
 * Minimal surface — just enough to host a real app:
 *
 *   const app = new App();
 *   app.use(json());
 *   app.use(cors({ origin: '*' }));
 *   app.get('/users/:id', (req, res) => res.json({ id: req.params.id }));
 *   app.listen({ port: 8080 });
 *
 * A handler is `(req, res, next)` or `(err, req, res, next)`. Return a
 * promise (or use async) and await `next()` to chain. Throwing inside a
 * handler is equivalent to calling `next(err)`.
 */

import { LWSContext, LWSMPRO_CALLBACK } from 'lws.so';
import { http } from './protocols.js';

/* ServerRequest/ServerResponse now live in ./request.js/./response.js
   (alongside Request/Response, which they share cookie-handling code
   with) - re-exported here since App.listen() (below) is their most
   common entry point and existing code may still import them from here. */
export { ServerRequest } from './request.js';
export { ServerResponse } from './response.js';

/* ---------------------------------------------------------------- *
 * path matching
 * ---------------------------------------------------------------- */

/**
 * Compile a path pattern into a regex + the list of capture names.
 *
 * - `:name` captures a path segment.
 * - `*` at the end captures the rest.
 * - When `end` is false (mount prefixes), the regex anchors at a `/`
 *   boundary instead of EOL, so `app.use('/api', …)` matches both
 *   `/api` and `/api/users/42`.
 */
export function compilePath(pattern, end = true) {
  if(pattern === '*' || pattern === '/*') return { regex: /^.*/, keys: [] };
  if(pattern === '/' || pattern === '') return { regex: end ? /^\/?$/ : /^\//, keys: [] };

  const keys = [];
  const parts = pattern.split('/').map(seg => {
    if(seg === '') return '';
    if(seg.startsWith(':')) {
      keys.push(seg.slice(1).replace(/[^a-zA-Z0-9_]/g, ''));
      return '([^/]+)';
    }
    if(seg === '*') return '.*';
    return seg.replace(/[.+?^=!${}()|[\]\\]/g, '\\$&');
  });

  const body = parts.join('/');
  const suffix = end ? '/?$' : '(?:/|$)';

  return { regex: new RegExp('^' + body + suffix), keys };
}

/* ---------------------------------------------------------------- *
 * the chain itself
 * ---------------------------------------------------------------- */

/* HTTP verbs we expose as shorthand methods. */
const METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'];

class Layer {
  constructor({ method, prefix, regex, keys, handler }) {
    this.method = method; // null for use(), 'GET' etc. otherwise
    this.prefix = prefix; // for stripping mount paths (sub-routers)
    this.regex = regex;
    this.keys = keys;
    this.handler = handler;
    this.isError = handler.length === 4;
  }
}

/**
 * App / Router. Both expose `use`, `get`, `post`, etc. Mount a sub-router
 * with `app.use('/api', router)`.
 */
export class App {
  layers = [];

  use(arg, ...rest) {
    let path = '/',
      handlers = rest;

    if(typeof arg === 'string') {
      path = arg;
    } else {
      handlers = [arg, ...rest];
    }

    for(const h of handlers.flat()) {
      if(h instanceof App) {
        const { regex, keys } = compilePath(path, false);
        this.layers.push(
          new Layer({
            method: null,
            prefix: path,
            regex,
            keys,
            handler: (req, res, next) => {
              const saved = req.path;
              req.path = req.path.slice(path.length) || '/';
              return h
                .dispatch(req, res)
                .then(handled => {
                  req.path = saved;
                  if(!handled) next();
                })
                .catch(err => {
                  req.path = saved;
                  next(err);
                });
            },
          }),
        );
      } else if(typeof h === 'function') {
        const { regex, keys } = compilePath(path, false);
        this.layers.push(new Layer({ method: null, prefix: path, regex, keys, handler: h }));
      }
    }

    return this;
  }

  /**
   * Internal: register a method+path handler.
   */
  _route(method, path, handlers) {
    const { regex, keys } = compilePath(path, true);
    for(const h of handlers.flat()) if(typeof h === 'function') this.layers.push(new Layer({ method, prefix: '/', regex, keys, handler: h }));
    return this;
  }

  /**
   * Run the chain. Resolves to `true` if a handler responded, `false`
   * otherwise — App.listen()'s onHttp uses the latter to emit a 404.
   */
  async dispatch(req, res) {
    const layers = this.layers;
    let i = 0,
      responded = false;

    const next = err => run(err);

    const run = async err => {
      while(i < layers.length) {
        const layer = layers[i++];

        if(layer.method && layer.method !== req.method) continue;

        const m = layer.regex.exec(req.path);
        if(!m) continue;

        for(let k = 0; k < layer.keys.length; k++) req.params[layer.keys[k]] = decodeURIComponent(m[k + 1]);

        if(err && !layer.isError) continue;
        if(!err && layer.isError) continue;

        try {
          let advanced = false;
          const localNext = e => {
            advanced = true;
            return run(e);
          };

          if(err) await layer.handler(err, req, res, localNext);
          else await layer.handler(req, res, localNext);

          if(advanced) return; /* handler chained — run() recursed */
          responded = true; /* handler owned the response */
          return;
        } catch(e) {
          return run(e);
        }
      }

      /* Stack drained. */
      if(err) {
        responded = true;
        if(!res.headersSent)
          res
            .status(500)
            .type('text/plain')
            .end(String(err.stack || err.message || err));
      }
    };

    await run();
    return responded || res.sent;
  }

  /**
   * Spin up an LWSContext, register an `'http'` protocol built from
   * `lib/lws/protocols.js`'s `http()` (which constructs the
   * `ServerRequest`/`ServerResponse` pair per connection and feeds
   * `onHttpBody`/`onHttpBodyCompletion` into them - same wiring
   * `lib/serve.js` uses), and return the context.
   *
   * `opts` is forwarded to LWSContext (port, vhostName, tls, options,
   * extra mounts, …). Pass `protocols: […]` to register additional
   * non-HTTP protocols (e.g. WebSocket) alongside the chain.
   */
  listen(opts = {}) {
    const { protocols = [], mounts = [], ...rest } = opts;
    const app = this;

    const handleRequest = (req, res) => {
      req.app = app;

      /* Synchronously dispatch — for GET requests with no body the chain
         runs immediately; for bodied methods it'll await req.readBody() /
         req.readJson(), fed by http()'s own onHttpBody/onHttpBodyCompletion
         wiring. */
      app
        .dispatch(req, res)
        .then(handled => {
          if(!handled && !res.headersSent) res.status(404).type('text/plain').end('Not Found');
        })
        .catch(err => {
          if(!res.headersSent) {
            try {
              res
                .status(500)
                .type('text/plain')
                .end(String(err.stack || err));
            } catch {}
          }
        });
    };

    const ctx = new LWSContext({
      ...rest,
      mounts: [...mounts, { mountpoint: '/', protocol: '__app', originProtocol: LWSMPRO_CALLBACK }],
      protocols: [...protocols, { name: '__app', ...http(handleRequest) }],
    });

    /* Expose the underlying context so middleware (e.g. session) can
       reach LWSContext-level helpers like getRandom(). */
    this.context = ctx;
    return ctx;
  }
}

/* Sugar: app.get / app.post / ... */
for(const m of METHODS)
  App.prototype[m] = function(path, ...handlers) {
    return this._route(m.toUpperCase(), path, handlers);
  };

App.prototype.all = function(path, ...handlers) {
  for(const m of METHODS) this._route(m.toUpperCase(), path, handlers);
  return this;
};

/** Router is just an App without listen() — same surface. */
export const Router = App;
