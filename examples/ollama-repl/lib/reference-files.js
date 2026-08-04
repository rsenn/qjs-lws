/**
 * Reference docs the model can pull in by name - the QuickJS C API header
 * and the qjs-modules JS built-ins - without them being part of the
 * project tree `extractFileRefs()` (file-refs.js) otherwise scans. Typing
 * "quickjs.h" or "fs.js" anywhere in a prompt attaches the real file from
 * its installed location, same as referencing a project file does.
 *
 * Read-only in effect even though nothing here enforces that: a "File:
 * quickjs.h" block in a reply gets resolved against `--root` by
 * saveFileBlocks() (file-blocks.js), same as any other write-back, so it
 * would land at `<root>/quickjs.h` - never at the real system path.
 */
const LOCAL_PREFIX = '/usr/local';
const LOCAL_INCLUDEDIR = LOCAL_PREFIX + '/include';
const LOCAL_LIBDIR = LOCAL_PREFIX + '/lib';

export const REFERENCE_FILES = {
  'quickjs.h': `${LOCAL_INCLUDEDIR}/quickjs/quickjs.h`,
  'fs.js': `${LOCAL_LIBDIR}/quickjs/fs.js`,
  'console.js': `${LOCAL_LIBDIR}/quickjs/console.js`,
  'process.js': `${LOCAL_LIBDIR}/quickjs/process.js`,
  'util.js': `${LOCAL_LIBDIR}/quickjs/util.js`,
};
