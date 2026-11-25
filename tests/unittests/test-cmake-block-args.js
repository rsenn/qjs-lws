/**
 * cmake/BuildLibwebsockets.cmake: the argument of an else(), elseif-less
 * endif(), endforeach() or endfunction() must be the one of its opening
 * command, or empty.  CMake 4.5 warns "A logical block opening on the line
 * ... closes on the line ... with mis-matching arguments" on every
 * configure otherwise.
 */
import { loadFile } from 'std';
import { tests, assert } from './tinytest.js';

const root = import.meta.url.replace(/^file:\/\//, '').replace(/tests\/unittests\/[^\/]*$/, '');
const norm = a => a.replace(/\s+/g, ' ').trim();

tests({
  'block closers repeat the opening arguments or none'() {
    const text = loadFile(`${root}cmake/BuildLibwebsockets.cmake`).replace(/#\[\[[\s\S]*?\]\]/g, m => m.replace(/[^\n]/g, ' '));
    const stack = [];
    const bad = [];

    text.split('\n').forEach((raw, n) => {
      const line = raw.replace(/#.*$/, '').trim();
      const m = /^(if|foreach|while|function|macro|else|endif|endforeach|endwhile|endfunction|endmacro)\s*\((.*)\)$/i.exec(line);

      if(!m) return;

      const [, cmd, arg] = [m[0], m[1].toLowerCase(), norm(m[2])];

      if(/^(if|foreach|while|function|macro)$/.test(cmd)) stack.push({ cmd, arg, line: n + 1 });
      else {
        const open = stack[stack.length - 1];

        if(cmd != 'else' && stack.length) stack.pop();
        /* only if() takes the whole condition back: the others compare the first word (foreach(v ...), function(f ...)) */
        const first = a => (open && open.cmd == 'if' ? a : a.split(' ')[0]);

        if(arg && open && first(arg) != first(open.arg)) bad.push(`line ${n + 1}: ${cmd}(${arg}) closes ${open.cmd}(${open.arg}) of line ${open.line}`);
      }
    });

    assert(bad.length == 0, bad.join('; '));
  },
});
