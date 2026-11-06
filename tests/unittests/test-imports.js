import { tests, eq } from './tinytest.js';
import * as os from 'os';
import { loadFile } from 'std';

/* lib/ and tests/ are self-contained: they import nothing but std, os, lws.so
   and files of this repository. Anything else (textcode, console, other qjs-*
   modules) would make them depend on a qjs-modules install.

   The one exception is an *optional* feature: a dynamic import() that is
   listed in OPTIONAL below, for exactly that file, and that must throw a
   clear error when the module is missing. */
const ALLOWED = new Set(['std', 'os', 'lws.so']);

const OPTIONAL = {
  'lib/lws/body.js': ['blob'],
  'lib/rpc/common.js': ['bjson', 'inspect'],
  'lib/cdn-loader.js': ['module'],
  'lib/logger.js': ['console'],
  'tests/test-jsonrpc-ws.js': ['repl'],
};

/* vendored or browser-side code, not ours to constrain */
const SKIP = ['tests/wpt', 'tests/lib', 'tests/jsonrpc-ws-playground', 'tests/unittests/fixtures'];

function walk(dir, out = []) {
  const [names] = os.readdir(dir);
  for(const name of names.sort()) {
    if(name == '.' || name == '..') continue;
    const path = `${dir}/${name}`;
    if(SKIP.includes(path)) continue;
    const [st] = os.stat(path);
    if((st.mode & os.S_IFMT) == os.S_IFDIR) walk(path, out);
    else if(/\.m?js$/.test(name)) out.push(path);
  }
  return out;
}

/* comment lines are blanked so prose such as "import 'x'" is not scanned */
function code(text) {
  let inBlock = false;
  return text
    .split('\n')
    .map(line => {
      const t = line.trim();
      if(inBlock) {
        if(t.includes('*/')) inBlock = false;
        return '';
      }
      if(t.startsWith('/*')) {
        if(!t.includes('*/')) inBlock = true;
        return '';
      }
      return t.startsWith('//') || t.startsWith('*') ? '' : line;
    })
    .join('\n');
}

const isLocal = spec => spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/');

function violations(root) {
  const bad = [];
  for(const file of [...walk(`${root}/lib`), ...walk(`${root}/tests`)]) {
    const src = code(loadFile(file));
    const rel = file.slice(root.length + 1);
    const optional = OPTIONAL[rel] ?? [];

    for(const m of src.matchAll(/\b(?:import|export)\s*(?:[^'";(]*?\s*from\s*)?['"]([^'"]+)['"]/g))
      if(!isLocal(m[1]) && !ALLOWED.has(m[1])) bad.push(`${rel}: static import of '${m[1]}'`);

    for(const m of src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g))
      if(!isLocal(m[1]) && !ALLOWED.has(m[1]) && !optional.includes(m[1])) bad.push(`${rel}: dynamic import of '${m[1]}'`);
  }
  return bad;
}

await tests({
  'lib/ and tests/ import only std, os, lws.so and repository files'() {
    eq('', violations('.').join('\n'));
  },
});
