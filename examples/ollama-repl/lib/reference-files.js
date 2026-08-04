/**
 * Reference material outside the project tree that the model can reach by
 * name, without it being part of the project tree `extractFileRefs()`
 * (file-refs.js) otherwise scans: the QuickJS interpreter's own source
 * (`root`'s parent directory - every "qjs-*" native-module project, this
 * one included, is checked out inside it), the installed pure-JS
 * qjs-modules built-ins (`/usr/local/lib/quickjs/*.js` - importable bare,
 * e.g. `import * as fs from 'fs'`), and the installed native qjs-modules
 * extensions (`/usr/local/lib/x86_64-linux-gnu/quickjs/*.so` - compiled,
 * not directly readable, but their C source lives in one of the "qjs-*"
 * project directories - see `nativeModules()`). Typing "quickjs.h",
 * "cutils.h", or "fetch.js" anywhere in a prompt attaches the real file,
 * same as referencing a project file does.
 *
 * The sibling "qjs-*" projects themselves (qjs-modules, qjs-ffi, qjs-net,
 * ...) aren't flattened into individual named files here - there are too
 * many, and their layouts differ - instead `qjsProjectDirs()` is used by
 * `tool-requests.js` to let LIST:/READ: reach into them by project name
 * (e.g. "LIST: qjs-modules", "READ: qjs-modules/quickjs-archive.c"), the
 * same way those requests already reach into the project itself.
 *
 * Read-only in effect even though nothing here enforces that: a "File:
 * quickjs.h" block in a reply gets resolved against `--root` by
 * saveFileBlocks() (file-blocks.js), same as any other write-back, so it
 * would land at `<root>/quickjs.h` - never at the real source location.
 */
import { readdir, S_IFREG } from 'os';
import { fileMode } from './match.js';

const JS_LIBDIR = '/usr/local/lib/quickjs';
const NATIVE_LIBDIR = '/usr/local/lib/x86_64-linux-gnu/quickjs';

/** The QuickJS interpreter source tree - `root`'s parent directory. */
function quickjsDir(root) {
  return root === '.' ? '..' : `${root}/..`;
}

/** Every "qjs-*" project directory next to `root` (this repo included)
    and one level further up (e.g. qjs-modules, qjs-ffi, ../../qjs-opencv),
    keyed by directory name. */
export function qjsProjectDirs(root = '.') {
  const dirs = new Map();

  for(const parent of [quickjsDir(root), `${quickjsDir(root)}/..`]) {
    const [names] = readdir(parent);
    for(const name of names ?? []) if(name.startsWith('qjs-') && !dirs.has(name)) dirs.set(name, `${parent}/${name}`);
  }

  return dirs;
}

/** Best-effort guess at which "qjs-*" project directory a compiled native
    module's C source lives in: its own "qjs-<name>" project if there is
    one (ffi -> qjs-ffi, lws -> qjs-lws, ...), otherwise the qjs-modules
    grab-bag repo, where most single-file native modules (archive, blob,
    json, sockets, ...) actually live. Not guaranteed accurate for every
    module - LIST: the guessed directory to confirm rather than assume. */
function guessNativeModuleProject(name, projects) {
  return projects.get(`qjs-${name}`) ?? projects.get(`qjs-${name.replace(/_/g, '-')}`) ?? projects.get('qjs-modules') ?? null;
}

/** name -> { so, project } for every installed native qjs-modules
    extension (`NATIVE_LIBDIR/*.so`) - `so` is the compiled (unreadable as
    text) module, `project` is `guessNativeModuleProject()`'s best guess at
    which "qjs-*" project directory holds its actual C source. */
export function nativeModules(root = '.') {
  const projects = qjsProjectDirs(root);
  const modules = {};

  const [names] = readdir(NATIVE_LIBDIR);
  for(const name of names ?? []) {
    if(!name.endsWith('.so')) continue;
    const mod = name.slice(0, -3);
    modules[mod] = { so: `${NATIVE_LIBDIR}/${name}`, project: guessNativeModuleProject(mod, projects) };
  }

  return modules;
}

/** name -> path for every reference file directly attachable by name:
    every header the QuickJS interpreter ships (quickjs.h, cutils.h,
    list.h, ...) plus every installed pure-JS qjs-modules built-in
    (JS_LIBDIR/*.js, top-level only - fs.js, console.js, dom.js, ...). */
export function referenceFiles(root = '.') {
  const files = {};

  const [jsNames] = readdir(JS_LIBDIR);
  for(const name of jsNames ?? []) if(name.endsWith('.js') && fileMode(`${JS_LIBDIR}/${name}`) === S_IFREG) files[name] = `${JS_LIBDIR}/${name}`;

  const dir = quickjsDir(root);
  const [hNames] = readdir(dir);
  for(const name of hNames ?? []) if(name.endsWith('.h') && fileMode(`${dir}/${name}`) === S_IFREG) files[name] = `${dir}/${name}`;

  return files;
}
