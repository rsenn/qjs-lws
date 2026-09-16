import { fetchSync } from './fetch.js';
import { URL } from './lws/url.js';

/* A module compiled from a returned `data:...` URL uses that whole URL
   string as its own path for resolving specifiers it imports in turn
   (jsm_module_data()/jsm_module_normalize() in qjs-modules/src/qjsm.c) - so
   a relative import inside a CDN-fetched file (e.g. one package file
   importing a sibling file, as unbundled multi-file packages do) arrives
   at normalize() with `path` set to that data: URL, not the original
   https:// one, and can't be resolved against it. This maps each data: URL
   this loader produced back to the https:// URL it came from, so a
   relative specifier seen with that data: URL as `path` can still be
   resolved against the right CDN directory. */
const sourceUrls = new Map();

/**
 * Installs a moduleLoader() hook (see qjs-modules/lib/module.js for the same
 * pattern) that resolves a bare `https://`/`http://` import specifier - e.g.
 * `import OpenAI from 'https://unpkg.com/openai'` - by fetching it
 * synchronously and handing the source back as a `data:` URL, which the
 * engine's own module loader already knows how to compile (see
 * jsm_module_data() in qjs-modules/src/qjsm.c).
 */
export default async function() {
  /* LWSContext registers its fd/timer handlers on the "os" module through
     plain globalThis.os.setReadHandler/setTimeout lookups (iohandler.h,
     lws-context.c) rather than an import - it's never bound there for a
     plain `import`ed script (only qjsm's own REPL bootstrap does that),
     same reason qjs-modules/lib/dbi.js's PGSQLAdapter#connect() sets it
     itself before touching anything that needs the event loop. */
  if(typeof globalThis.os === 'undefined') globalThis.os = await import('os');

  moduleLoader({
    normalize(path, name) {
      /* Root-relative ("/npm/preact@.../+esm", as jsdelivr's and esm.sh's
         bundlers emit) as well as "./"/"../" - both resolve correctly
         against the origin the fetch came from via the URL constructor. */
      if(/^\.{0,2}\//.test(name) && sourceUrls.has(path)) return new URL(name, sourceUrls.get(path)).href;

      return name;
    },
    loader(name) {
      if(/^https?:\/\//.test(name)) {
        /* jsm_call_loader_method() (qjs-modules/src/qjsm.c) exit(1)s the
           whole process on an exception escaping this hook - not just this
           one import - so a network/TLS failure fetching `name` must turn
           into a normal module-evaluation-time throw (via the returned
           data: URL's own code) instead of throwing here directly, or one
           flaky CDN request would take the entire process down instead of
           just failing that one import() call. */
        let code;

        try {
          /* h2: false works around BUGS: h2-rst-stream-protocol-error-closes-connection -
             several real CDNs (unpkg.com, esm.sh's underlying infra) RST_STREAM an h2
             request outright, so preferring h2 here would make every fetch fail. */
          code = fetchSync(name, { h2: false });
        } catch(e) {
          return `data:application/javascript,throw new Error(${JSON.stringify(`fetching '${name}' failed: ${e.message}`)});`;
        }

        const dataUrl = `data:application/javascript,${code}`;
        sourceUrls.set(dataUrl, name);
        return dataUrl;
      }

      return name;
    },
  });
}
