// Reports how much of libwebsockets' API is actually pulled in by the
// qjs-lws native module.
//
// qjs-lws is a plain C module (not C++), so unlike a mangled-symbol based
// coverage tool, this one works directly off plain nm symbol names - no
// demangling, no class/constructor inference.
//
// Method:
//   - `nm -A --undefined` on qjs-lws's own object files (*.o, before they're
//     linked into lws.so) lists every symbol qjs-lws's C code *references*
//     but doesn't itself define - i.e. everything it imports, from
//     libwebsockets and elsewhere (libc, quickjs, ...).
//   - `nm -A --defined-only` on a candidate library (typically
//     libwebsockets.a) lists every symbol it *exports*. Only uppercase-typed
//     symbols are global/external (nm convention: lowercase = local to the
//     object file, e.g. `t`/`r`/`d` for static functions/data); lowercase
//     ones are dropped since qjs-lws could never have linked against them.
//   - A library symbol counts as "implemented" if its exact name appears in
//     qjs-lws's imported-symbol set. Symbols are further split into
//     functions (nm type T/W) and data (everything else global: D/B/R/G/S/...)
//     for the report, purely for readability - the matching itself doesn't
//     care about the split.
//   - By default, exported symbols are further restricted to libwebsockets'
//     public API: a symbol only counts (in either direction - as "total" or
//     as "implemented") if its name shows up somewhere under
//     libwebsockets/include/. This is intentionally a dumb text scan (`grep
//     -rhoE` for identifier-shaped tokens across the public headers, no
//     preprocessing/parsing), not a real declaration parser - it's a coarse
//     "does this name appear anywhere in the public headers" filter, which
//     is enough to drop internal-only symbols (e.g. role_ops_h1, only
//     declared in a private-lib-*.h that qjs-lws reaches by directly
//     #including libwebsockets .c files as static plugins) without needing
//     to actually parse C declarations. The same scan records which
//     header(s) mention each name, and each symbol in the report carries
//     the first one (sorted) as its "header" field - grep is coarse, so
//     this is "a header that mentions this name", not a verified
//     declaration site.
//
// Usage:
//   qjs binding_coverage.js [options]
//
// Options:
//   --objects=DIR        directory of qjs-lws *.o files to scan for imports
//                         (default: build/x86_64-linux-debug/CMakeFiles/qjs-lws.dir)
//   --obj-pattern=RE      regex matching object filenames inside --objects (default: \.o$)
//   --lib=PATH            a single library (.a or .so) to scan for exported symbols (repeatable)
//   --lib-dir=DIR         a directory of libraries to scan (repeatable)
//   --lib-pattern=RE      regex matching library filenames inside --lib-dir (default: \.(a|so)$)
//   --public-headers=DIR  header tree to scan for the public-API filter (default: libwebsockets/include)
//   --no-public-only      disable the public-API filter; count every exported symbol
//   --json=PATH           JSON report output path (default: ./binding_coverage.json)
//   --out=PATH            human-readable report output path (default: stdout)
//   --verbose             list missing symbols even for 0%-bound libraries
//                         (JSON output always contains the full per-symbol lists)

import * as std from 'std';
import * as os from 'os';

function die(msg) {
  std.err.puts(msg + '\n');
  std.exit(1);
}

function parseArgs(argv) {
  const opts = {
    objects: 'build/x86_64-linux-debug/CMakeFiles/qjs-lws.dir',
    objPattern: '\\.o$',
    libs: [],
    libDirs: [],
    libPattern: '\\.(a|so)$',
    publicHeaders: 'libwebsockets/include',
    publicOnly: true,
    json: './binding_coverage.json',
    out: null,
    verbose: false,
  };
  for(let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if(a === '--verbose') {
      opts.verbose = true;
      continue;
    }
    if(a === '--no-public-only') {
      opts.publicOnly = false;
      continue;
    }
    const m = /^--([a-z-]+)=(.*)$/.exec(a);
    if(!m) die(`unrecognized argument: ${a}`);
    const key = m[1],
      val = m[2];
    switch(key) {
      case 'objects':
        opts.objects = val;
        break;
      case 'obj-pattern':
        opts.objPattern = val;
        break;
      case 'lib':
        opts.libs.push(val);
        break;
      case 'lib-dir':
        opts.libDirs.push(val);
        break;
      case 'lib-pattern':
        opts.libPattern = val;
        break;
      case 'public-headers':
        opts.publicHeaders = val;
        break;
      case 'json':
        opts.json = val;
        break;
      case 'out':
        opts.out = val;
        break;
      default:
        die(`unknown option: --${key}`);
    }
  }
  if(opts.libs.length === 0 && opts.libDirs.length === 0) opts.libs.push('build/x86_64-linux-debug/libwebsockets/lib/libwebsockets.a');
  return opts;
}

function basename(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

function shQuote(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function run(cmd) {
  const f = std.popen(cmd, 'r');
  if(!f) throw new Error('popen failed: ' + cmd);
  const out = f.readAsString();
  const status = f.close();
  if(status !== 0) std.err.puts(`warning: command exited ${status}: ${cmd}\n`);
  return out;
}

function listFiles(dir, pattern) {
  const [entries, err] = os.readdir(dir);
  if(err) die(`cannot read directory: ${dir}`);
  return entries.filter(n => pattern.test(n)).sort().map(n => `${dir}/${n}`);
}

// Parses one line of `nm -A ...` output. -A prefixes every line with the
// containing file (and, for archives, "archive:member.o" both before the
// colon), so the layout is "<file(s)>:[address] <type> <name>" - undefined
// symbols have no address, just spaces where it'd be. We only need the type
// and name, which are always the last two whitespace-separated fields.
function parseNmLine(line) {
  const parts = line.trim().split(/\s+/);
  if(parts.length < 2) return null;
  const name = parts[parts.length - 1];
  const type = parts[parts.length - 2];
  if(!/^[A-Za-z?-]$/.test(type)) return null;
  return { type, name };
}

// Undefined (imported) plain symbol names referenced across a set of object files.
function getUndefinedSymbols(objPaths) {
  const out = run(`nm -A --undefined ${objPaths.map(shQuote).join(' ')}`);
  const set = new Set();
  for(const line of out.split('\n')) {
    const sym = parseNmLine(line);
    if(sym && sym.type === 'U') set.add(sym.name);
  }
  return set;
}

// Exported (global, defined) plain symbol names of a library, split into
// functions (T/W) and data (any other uppercase/global type). Lowercase
// types (local-to-object-file symbols) are dropped - nothing outside that
// object file, including qjs-lws, can ever reference them. If headerMap is
// given and filterToPublic is true, symbols not found in it are dropped too.
function getExportedSymbols(libPath, headerMap, filterToPublic) {
  const out = run(`nm -A --defined-only ${shQuote(libPath)}`);
  const functions = new Map();
  const data = new Map();
  for(const line of out.split('\n')) {
    const sym = parseNmLine(line);
    if(!sym) continue;
    if(!/^[A-Z]$/.test(sym.type)) continue; // local symbol, not exported
    const headers = headerMap ? headerMap.get(sym.name) || null : null;
    if(filterToPublic && !headers) continue; // not in the public headers
    const bucket = sym.type === 'T' || sym.type === 'W' ? functions : data;
    if(!bucket.has(sym.name)) bucket.set(sym.name, { type: sym.type, headers });
  }
  return { functions, data };
}

// Very coarse "which header(s) declare this name" map: for every
// identifier-shaped token that occurs anywhere under a header tree, the set
// of header files it occurs in. Not a declaration parser - just a grep - so
// it can't distinguish a real declaration from a macro body, a comment, or
// a parameter name, but that's fine here: it's only ever used to check
// whether an already-known exported symbol name shows up in the public
// headers at all (and where), and a name qjs-lws could plausibly bind
// against necessarily appears literally as a token wherever it's declared.
function scanPublicApiHeaders(headerDir) {
  const out = run(`grep -rnoE '[A-Za-z_][A-Za-z0-9_]*' ${shQuote(headerDir)} --include='*.h'`);
  const map = new Map();
  const lineRe = /^(.*):(\d+):([A-Za-z_][A-Za-z0-9_]*)$/;
  for(const line of out.split('\n')) {
    const m = lineRe.exec(line);
    if(!m) continue;
    const [, path, , name] = m;
    if(!map.has(name)) map.set(name, new Set());
    map.get(name).add(path);
  }
  for(const [name, set] of map) map.set(name, Array.from(set).sort());
  return map;
}

function pct(implemented, total) {
  return total === 0 ? null : Math.round((implemented / total) * 10000) / 100;
}

function buildCategoryReport(symbolMap, undefinedSet) {
  const list = Array.from(symbolMap.entries())
    .map(([name, info]) => ({
      name,
      type: info.type,
      header: info.headers ? info.headers[0] : null,
      implemented: undefinedSet.has(name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const implemented = list.filter(s => s.implemented).length;
  return { total: list.length, implemented, percentage: pct(implemented, list.length), list };
}

function buildLibraryReport(libPath, undefinedSet, headerMap, filterToPublic) {
  const { functions, data } = getExportedSymbols(libPath, headerMap, filterToPublic);
  const functionsReport = buildCategoryReport(functions, undefinedSet);
  const dataReport = buildCategoryReport(data, undefinedSet);
  return {
    functions: functionsReport,
    data: dataReport,
    overall: {
      total: functionsReport.total + dataReport.total,
      implemented: functionsReport.implemented + dataReport.implemented,
      percentage: pct(functionsReport.implemented + dataReport.implemented, functionsReport.total + dataReport.total),
    },
  };
}

function formatPct(p) {
  return p === null ? 'n/a' : `${p.toFixed(2)}%`;
}

const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';

function colorize(text, implemented, color) {
  if(!color) return text;
  return (implemented ? ANSI_GREEN : ANSI_RED) + text + ANSI_RESET;
}

function renderText(report, verbose, color) {
  const lines = [];
  lines.push(`qjs-lws binding coverage report`);
  lines.push(`generated: ${report.generatedAt}`);
  lines.push(`objects:   ${report.objects.join(', ')}`);
  lines.push(`lib sources: ${report.libSources.join(', ')}`);
  lines.push(`public API filter: ${report.publicApiFilter ? report.publicApiFilter : 'disabled (--no-public-only)'}`);
  lines.push('');

  const names = Object.keys(report.libraries).sort();
  const w = Math.max(...names.map(n => n.length), 20);
  lines.push(`${'library'.padEnd(w)}  functions          data               overall`);
  for(const name of names) {
    const lib = report.libraries[name];
    const fn = lib.functions,
      d = lib.data,
      o = lib.overall;
    lines.push(
      `${name.padEnd(w)}  ${`${fn.implemented}/${fn.total}`.padEnd(8)} ${formatPct(fn.percentage).padStart(7)}  ` +
        `${`${d.implemented}/${d.total}`.padEnd(8)} ${formatPct(d.percentage).padStart(7)}  ` +
        `${`${o.implemented}/${o.total}`.padEnd(8)} ${formatPct(o.percentage).padStart(7)}`,
    );
  }
  lines.push('');
  const s = report.summary;
  lines.push(`TOTAL functions: ${s.functions.implemented}/${s.functions.total} (${formatPct(s.functions.percentage)})`);
  lines.push(`TOTAL data:      ${s.data.implemented}/${s.data.total} (${formatPct(s.data.percentage)})`);
  lines.push(`TOTAL overall:   ${s.overall.implemented}/${s.overall.total} (${formatPct(s.overall.percentage)})`);

  for(const name of names) {
    const lib = report.libraries[name];
    if(lib.overall.total === 0) continue;
    lines.push('');
    const header = lib.overall.implemented === 0 ? 'not bound' : `bound (${formatPct(lib.overall.percentage)})`;
    lines.push(`--- ${name}: ${header} ---`);
    if(!verbose && lib.overall.implemented === 0) continue;
    for(const [label, cat] of [['functions', lib.functions], ['data', lib.data]]) {
      if(!cat.list.length) continue;
      lines.push(`  ${label} (${cat.implemented}/${cat.total}):`);
      for(const sym of cat.list) {
        if(!verbose && !sym.implemented) continue;
        const where = sym.header ? ` (${sym.header})` : '';
        lines.push(`    ${sym.implemented ? ' ' : '*'}${colorize(sym.name, sym.implemented, color)}${where}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

function main() {
  const opts = parseArgs(scriptArgs);

  const objPattern = new RegExp(opts.objPattern);
  const objPaths = listFiles(opts.objects, objPattern);
  if(objPaths.length === 0) die(`no object files found in ${opts.objects} (pattern ${opts.objPattern})`);

  const libPattern = new RegExp(opts.libPattern);
  const libPaths = [...opts.libs];
  for(const dir of opts.libDirs) libPaths.push(...listFiles(dir, libPattern));
  if(libPaths.length === 0) die(`no libraries found (pattern ${opts.libPattern})`);

  std.err.puts(`scanning qjs-lws object imports: ${opts.objects} (${objPaths.length} files matching ${opts.objPattern})\n`);
  const undefinedSet = getUndefinedSymbols(objPaths);
  std.err.puts(`  ${undefinedSet.size} imported symbols across ${objPaths.length} object files\n`);

  std.err.puts(`scanning public API headers: ${opts.publicHeaders}\n`);
  const headerMap = scanPublicApiHeaders(opts.publicHeaders);
  std.err.puts(`  ${headerMap.size} distinct identifier tokens\n`);

  const report = {
    generatedAt: new Date().toISOString(),
    objects: objPaths,
    libSources: [...opts.libs, ...opts.libDirs.map(d => `${d}/${opts.libPattern}`)],
    publicApiFilter: opts.publicOnly ? opts.publicHeaders : null,
    libraries: {},
  };

  let sfn = 0,
    tfn = 0,
    sd = 0,
    td = 0;
  for(const libPath of libPaths) {
    const name = basename(libPath);
    std.err.puts(`  ${name} ...\n`);
    const libReport = buildLibraryReport(libPath, undefinedSet, headerMap, opts.publicOnly);
    report.libraries[name] = libReport;
    sfn += libReport.functions.implemented;
    tfn += libReport.functions.total;
    sd += libReport.data.implemented;
    td += libReport.data.total;
  }

  report.summary = {
    functions: { total: tfn, implemented: sfn, percentage: pct(sfn, tfn) },
    data: { total: td, implemented: sd, percentage: pct(sd, td) },
    overall: { total: tfn + td, implemented: sfn + sd, percentage: pct(sfn + sd, tfn + td) },
  };

  const jsonOut = std.open(opts.json, 'w');
  jsonOut.puts(JSON.stringify(report, null, 2));
  jsonOut.close();
  std.err.puts(`wrote ${opts.json}\n`);

  const color = !opts.out;
  const text = renderText(report, opts.verbose, color);
  if(opts.out) {
    const f = std.open(opts.out, 'w');
    f.puts(text);
    f.close();
    std.err.puts(`wrote ${opts.out}\n`);
  } else {
    std.out.puts(text);
  }
}

main();
