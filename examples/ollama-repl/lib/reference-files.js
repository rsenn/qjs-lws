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
export const REFERENCE_FILES = {
  'quickjs.h': '/usr/local/include/quickjs/quickjs.h',
  'fs.js': '/usr/local/lib/quickjs/fs.js',
  'console.js': '/usr/local/lib/quickjs/console.js',
  'process.js': '/usr/local/lib/quickjs/process.js',
  'util.js': '/usr/local/lib/quickjs/util.js',
};
