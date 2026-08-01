/**
 * Minimal glob support: just enough to resolve `*.js`/`src/**\/*.ts`-style
 * patterns typed into a chat prompt against the local project tree. Not a
 * general-purpose glob implementation - no brace expansion, no character
 * classes beyond what the regex conversion below gives for free.
 */
import * as os from 'os';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn', 'build']);

/** True if `pattern` contains any glob metacharacter. */
export function isGlobPattern(pattern) {
  return /[*?[\]{}]/.test(pattern);
}

/**
 * Converts a glob pattern to a RegExp. `**` matches any number of path
 * segments (including none); a single `*` stays within one segment; `?`
 * matches exactly one non-separator character.
 */
function globToRegExp(pattern) {
  let re = '';

  for(let i = 0; i < pattern.length; i++) {
    const c = pattern[i];

    if(c === '*') {
      if(pattern[i + 1] === '*') {
        const skipSlash = pattern[i + 2] === '/';
        re += '.*';
        i += skipSlash ? 2 : 1;
      } else {
        re += '[^/]*';
      }
    } else if(c === '?') {
      re += '[^/]';
    } else if('.+^$()|{}[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }

  return new RegExp('^' + re + '$');
}

/** Recursively lists every regular file under `dir`, as paths relative to `root`. */
export function* walk(dir, root) {
  const [names, err] = os.readdir(dir);

  if(err) return;

  for(const name of names) {
    if(name === '.' || name === '..' || SKIP_DIRS.has(name)) continue;

    const full = dir === '.' ? name : `${dir}/${name}`;
    /* lstat, not stat: a symlinked directory (e.g. this repo's own
       build/.../modules/lib -> ../../../lib) resolves right back into an
       ancestor under stat's follow-the-link semantics, recursing forever -
       confirmed via a real stack overflow. Skip symlinks outright instead
       of trying to detect the cycle. */
    const [st] = os.lstat(full);

    if(!st) continue;

    if((st.mode & os.S_IFMT) === os.S_IFDIR) yield* walk(full, root);
    else if((st.mode & os.S_IFMT) === os.S_IFREG) yield full;
  }
}

/** Every regular file under `root` matching glob `pattern`, relative to `root`. */
export function globMatch(pattern, root = '.') {
  const re = globToRegExp(pattern.replace(/^\.\//, ''));
  const out = [];

  for(const path of walk(root, root)) {
    const rel = root === '.' ? path : path.slice(root.length + 1);
    if(re.test(rel)) out.push(rel);
  }

  return out.sort();
}
