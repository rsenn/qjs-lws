/**
 * Auto-attached context for a "write a native QuickJS binding" prompt -
 * examples/fib.c (plain function export) and examples/point.c (class
 * binding) from the QuickJS source tree, plus this project's own curated
 * cheat sheet (reference/quickjs-binding-api.md) - see DEMO.md 3/4 for
 * why these three and not the full quickjs.h.
 */
import { loadFile } from 'std';
import { quickjsDir } from './reference-files.js';
import { formatFileBlocks } from './file-refs.js';

const CHEAT_SHEET_REL = 'examples/ollama-repl/reference/quickjs-binding-api.md';

/* Keyword sniff, same style as file-refs.js's own path detection - a
   false positive just means slightly more context attached, not a wrong
   answer, so this errs permissive rather than strict. */
const BINDING_RE = /\b(binding|bindings|native module|quickjs module)\b/i;

export function looksLikeBindingPrompt(text) {
  return BINDING_RE.test(text);
}

/** `{ text, attached }` for the auto-attached binding reference material -
    `fib.c`/`point.c` (sibling QuickJS source tree) and the curated cheat
    sheet (this project). `text` is `''`/`attached` is `[]` if none of the
    three could be read (e.g. no sibling QuickJS checkout at this path). */
export function bindingContext(root) {
  const dir = quickjsDir(root);
  const prefix = root === '.' ? '' : `${root}/`;

  const paths = [`${dir}/examples/fib.c`, `${dir}/examples/point.c`, `${prefix}${CHEAT_SHEET_REL}`];

  const files = paths.map(path => ({ path, content: loadFile(path) })).filter(f => f.content != null);

  if(!files.length) return { text: '', attached: [] };

  return { text: formatFileBlocks(files), attached: files.map(f => f.path) };
}
