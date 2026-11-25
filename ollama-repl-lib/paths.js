/**
 * paths: shell-style home expansion for paths the user types (/cd, Tab
 * completion).
 *
 *   expandHome('~/Sources')        -> '/home/roman/Sources'
 *   expandHome('~rsenn/x')         -> '/home/rsenn/x'   (from /etc/passwd)
 *   expandHome('src')              -> 'src'
 *   unquote('"My Dir"'), unquote('My\\ Dir')  -> 'My Dir'
 */
import { getenv, loadFile } from 'std';

/** home directory of `user` from /etc/passwd, undefined if unknown */
export function homeOf(user) {
  for(const line of (loadFile('/etc/passwd') ?? '').split('\n')) {
    const f = line.split(':');
    if(f[0] === user && f[5]) return f[5];
  }
}

/** path with a leading ~ or ~user replaced by that home directory, else unchanged */
export function expandHome(path) {
  const m = /^~([^/]*)(\/.*)?$/.exec(path);
  if(!m) return path;

  const home = m[1] ? homeOf(m[1]) : (getenv('HOME') ?? homeOf(getenv('USER') ?? ''));
  return home ? home.replace(/\/$/, '') + (m[2] ?? '') : path;
}

/** surrounding quotes and backslash escapes removed */
export function unquote(s) {
  s = s.trim();
  if(s.length > 1 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) return s.slice(1, -1);
  return s.replace(/\\(.)/g, '$1');
}
