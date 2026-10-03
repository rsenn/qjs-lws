import { fetchSync } from './fetch.js';
import { URL } from './lws/url.js';

/**
 * Installs a registerHooks() resolve/load pair (qjsm's Node-compatible
 * module.registerHooks, see qjs-modules/lib/module.js) that makes a bare
 * `https://`/`http://` import specifier - e.g.
 * `import OpenAI from 'https://unpkg.com/openai'` - load by fetching it
 * synchronously and handing the source back as an ES module. Relative and
 * root-relative imports inside a fetched file resolve against its own URL.
 */
export default async function() {
  /* LWSContext registers its fd/timer handlers on the "os" module through
     plain globalThis.os.setReadHandler/setTimeout lookups (iohandler.h,
     lws-context.c) rather than an import - it's never bound there for a
     plain `import`ed script (only qjsm's own REPL bootstrap does that),
     same reason qjs-modules/lib/dbi.js's PGSQLAdapter#connect() sets it
     itself before touching anything that needs the event loop. */
  if(typeof globalThis.os === 'undefined') globalThis.os = await import('os');

  const { registerHooks } = await import('module');

  return registerHooks({
    resolve(specifier, context, nextResolve) {
      if(/^https?:\/\//.test(specifier)) return { url: specifier, shortCircuit: true };

      /* Root-relative ("/npm/preact@.../+esm", as jsdelivr's and esm.sh's
         bundlers emit) as well as "./"/"../" - both resolve correctly
         against the origin the fetch came from via the URL constructor. */
      if(/^\.{0,2}\//.test(specifier) && /^https?:\/\//.test(context.parentURL ?? ''))
        return { url: new URL(specifier, context.parentURL).href, shortCircuit: true };

      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if(!/^https?:\/\//.test(url)) return nextLoad(url, context);

      /* h2: false works around BUGS: h2-rst-stream-protocol-error-closes-connection -
         several real CDNs (unpkg.com, esm.sh's underlying infra) RST_STREAM an h2
         request outright, so preferring h2 here would make every fetch fail. */
      let source;

      try {
        source = fetchSync(url, { h2: false });
      } catch(e) {
        throw new Error(`fetching '${url}' failed: ${e.message}`);
      }

      return { format: 'module', source, shortCircuit: true };
    },
  });
}
