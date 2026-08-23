/**
 * Static gate for every JS example that ships in the docs and on the site.
 *
 *   qjsm tools/site/check-examples.js [-v]
 *
 * For each ```js block in README.md, ChangeLog.md, doc/ ** .md and the
 * <x-code> blocks in landing.html it checks two things:
 *
 *   1. it parses (via the AsyncFunction constructor - parses, never runs);
 *   2. every name it imports from 'lws'/'lws.so' actually exists in the
 *      built module, and every name imported from a lib/ path actually
 *      exists in that file's exports.
 *
 * (2) is the check that matters: a renamed or imagined API is the realistic
 * way a doc example rots, and it is invisible to a parse-only pass.
 *
 * Needs the built module on the module path:
 *   qjsm -I build/x86_64-linux-debug tools/site/check-examples.js
 *
 * Exits non-zero if anything fails.
 */

import * as std from 'std';
import * as os from 'os';

const SELF = import.meta.url.replace(/^file:\/\//, '').replace(/\/[^/]*$/, '');
const ROOT = SELF + '/../..';

/* The built native module, wherever this checkout put it. */
const NATIVE = (() => {
  for (const d of ["x86_64-linux-debug", "x86_64-linux-gnu", "x86_64-linux-profile"]) {
    const p = ROOT + "/build/" + d + "/lws.so";
    const [st] = os.stat(p);
    if (st) return p;
  }
  return null;
})();
const VERBOSE = scriptArgs.includes('-v');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/* ------------------------------------------------------------- collection */

function readdirRec(dir, out = []) {
  const [names, err] = os.readdir(dir);
  if (err) return out;
  for (const name of names) {
    if (name === '.' || name === '..') continue;
    const path = dir + '/' + name;
    const [st] = os.stat(path);
    if (st && (st.mode & os.S_IFMT) === os.S_IFDIR) readdirRec(path, out);
    else out.push(path);
  }
  return out;
}

function sources() {
  const list = [ROOT + '/README.md', ROOT + '/ChangeLog.md'];
  for (const p of readdirRec(ROOT + '/doc')) if (p.endsWith('.md')) list.push(p);
  list.push(ROOT + '/tools/site/landing.html');
  return list.sort();
}

/** Every js example in one file, with the line it starts on. */
function examples(path) {
  const text = std.loadFile(path);
  if (text === null) return [];
  const lines = text.split('\n');
  const out = [];

  if (path.endsWith('.html')) {
    // landing page: <x-code lang="js"> … </x-code>
    const re = /<x-code lang="js">([\s\S]*?)<\/x-code>/g;
    let m;
    while ((m = re.exec(text))) {
      const line = text.slice(0, m.index).split('\n').length;
      out.push({ path, line, code: m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') });
    }
    return out;
  }

  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*```js\s*$/.test(lines[i])) continue;
    const start = i + 1;
    const body = [];
    for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) body.push(lines[i]);
    out.push({ path, line: start, code: body.join('\n') });
  }
  return out;
}

/* ------------------------------------------------------------------ parse */

/** Import statements, and the body with them removed. */
function splitImports(code) {
  const imports = [];
  const body = code.replace(/^[ \t]*import\s+[\s\S]*?from\s*['"][^'"]+['"];?[ \t]*$/gm, m => {
    imports.push(m.trim());
    return '';
  }).replace(/^[ \t]*import\s+['"][^'"]+['"];?[ \t]*$/gm, m => {
    imports.push(m.trim());
    return '';
  });
  return { imports, body };
}

/**
 * Parse-only. Tries the snippet as statements, then as a parenthesised
 * expression, so bare `{ name: 'x', onReceive(wsi) {} }` handler fragments
 * are accepted for what they are.
 */
function parses(body) {
  try { new AsyncFunction(body); return true; } catch (e) { var first = e; }
  try { new AsyncFunction('return (' + body + '\n);'); return true; } catch (e) {}
  return first;
}

/* ----------------------------------------------------------- import check */

const moduleCache = new Map();

async function exportsOf(spec) {
  if (moduleCache.has(spec)) return moduleCache.get(spec);
  let names = null;
  try {
    names = new Set(Object.keys(await import(spec)));
  } catch (e) {
    names = null; // unresolvable here (relative path in a doc snippet, etc.)
  }
  moduleCache.set(spec, names);
  return names;
}

/** 'lws' in a doc snippet means the native module, built as lws.so. */
function resolveSpec(spec) {
  if (spec === 'lws' || spec === 'lws.so') return NATIVE;
  if (spec.startsWith('./lib/') || spec.startsWith('../lib/')) return ROOT + '/lib/' + spec.replace(/^\.+\/lib\//, '');
  if (spec.startsWith('./') || spec.startsWith('../')) return null; // snippet-relative, not checkable
  if (['std', 'os'].includes(spec)) return spec;
  return null;
}

function namedBindings(stmt) {
  const braces = stmt.match(/\{([^}]*)\}/);
  if (!braces) return [];
  return braces[1]
    .split(',')
    .map(s => s.trim().split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
}

/* ------------------------------------------------------------------- main */

let checked = 0, failed = 0;
const problems = [];

for (const path of sources()) {
  for (const ex of examples(path)) {
    checked++;
    const where = path.replace(/^\.\//, '') + ':' + ex.line;
    const { imports, body } = splitImports(ex.code);

    const syntax = parses(body);
    if (syntax !== true) {
      failed++;
      problems.push({ where, kind: 'syntax', detail: String(syntax), code: ex.code });
      continue;
    }

    for (const stmt of imports) {
      const spec = stmt.match(/from\s*['"]([^'"]+)['"]/)?.[1] ?? stmt.match(/import\s*['"]([^'"]+)['"]/)?.[1];
      const resolved = resolveSpec(spec);
      if (!resolved) continue;

      const have = await exportsOf(resolved);
      if (!have) {
        problems.push({ where, kind: 'unresolved', detail: `cannot load ${resolved} (from '${spec}')` });
        failed++;
        continue;
      }

      for (const name of namedBindings(stmt)) {
        if (!have.has(name)) {
          problems.push({ where, kind: 'missing-export', detail: `'${spec}' has no export '${name}'` });
          failed++;
        }
      }
    }

    if (VERBOSE) console.log('ok   ' + where);
  }
}

for (const p of problems) {
  console.log('FAIL ' + p.where + '  [' + p.kind + ']');
  console.log('     ' + p.detail.split('\n')[0]);
  if (p.code && VERBOSE) console.log(p.code.split('\n').map(l => '     | ' + l).join('\n'));
}

console.log('\n' + checked + ' examples checked, ' + problems.length + ' problems');
std.exit(problems.length ? 1 : 0);
