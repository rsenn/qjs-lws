/* test-file-refs.js: small files are attached, big, generated and over-budget ones only named, binary ones skipped */
import { open } from 'std';
import * as os from 'os';
import { extractFileRefs, formatFileRefs, ATTACH_MAX_BYTES } from '../lib/project/file-refs.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-file-refs: ${what}`);
};

const root = `/tmp/ollama-repl-test-file-refs-${os.getpid?.() ?? 0}`;
os.mkdir(root, 0o755);
os.mkdir(`${root}/build`, 0o755);

const put = (name, text) => {
  const f = open(`${root}/${name}`, 'w');
  f.puts(text);
  f.close();
};

put('small.js', 'export const x = 1;\n');
put('big.c', 'int x;\n'.repeat(Math.ceil((ATTACH_MAX_BYTES + 100) / 7)));
put('build/out.js', 'x\n');
put('blob.dat', 'a\0b');
put('blob.png', 'png');

const { files, skipped, large } = extractFileRefs('see small.js big.c build/out.js blob.dat blob.png', root);
check('small file attached', files.length === 1 && files[0].path === 'small.js');
check('big file named with lines and size', large.some(f => f.path === 'big.c' && f.why === 'too large' && f.lines > 1000));
check('generated file named, not attached', large.some(f => f.path === 'build/out.js' && f.why === 'generated'));
check('binary by content and by extension skipped', skipped.includes('blob.dat') && skipped.includes('blob.png'));
const text = formatFileRefs(large);
check('reference block names the path in backticks and read_file', text.includes('`big.c`') && /read_file/.test(text));
check('nothing to name gives nothing', formatFileRefs([]) === '');

console.log('test-file-refs: ok');
