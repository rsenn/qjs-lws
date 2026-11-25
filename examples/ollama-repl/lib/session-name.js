/**
 * session-name: funny, nerdy session names - an adjective and a noun joined
 * by a hyphen, like `idempotent-quokka` or `segfaulting-axolotl`.
 *
 * ```js
 * funnyName();                              // 'lazy-evaluating-pangolin'
 * funnyName(new Set(['a-b']));              // never one of the taken names
 * ```
 *
 * 40 x 40 combinations; a clash with a live session gets a number
 * (`idempotent-quokka-2`).
 */
const ADJECTIVES = [
  'idempotent', 'segfaulting', 'lazy-evaluating', 'tail-recursive', 'undefined-behaving', 'halting', 'deadlocked', 'memoized',
  'bit-shifted', 'null-terminated', 'overclocked', 'zero-indexed', 'asynchronous', 'monadic', 'cache-friendly', 'garbage-collected',
  'turing-complete', 'regex-matching', 'byte-ordered', 'self-hosting', 'polymorphic', 'stack-smashing', 'heisenbuggy', 'quantum-entangled',
  'unix-philosophical', 'hand-optimized', 'dangling', 'endian', 'recursive', 'orthogonal', 'hot-swappable', 'cron-scheduled',
  'bikeshedding', 'off-by-one', 'sudo-enabled', 'fork-bombing', 'forty-two-ish', 'vim-trapped', 'rubber-ducked', 'mutex-guarded',
];

const NOUNS = [
  'quokka', 'axolotl', 'pangolin', 'narwhal', 'capybara', 'tardigrade', 'platypus', 'wombat',
  'okapi', 'lemur', 'mantis', 'ocelot', 'kraken', 'gopher', 'penguin', 'camel',
  'daemon', 'compiler', 'semaphore', 'pointer', 'kernel', 'bytecode', 'linker', 'mutex',
  'heap', 'segment', 'thunk', 'closure', 'lambda', 'monad', 'opcode', 'register',
  'bitmask', 'tarball', 'regexp', 'pipeline', 'syscall', 'fuse', 'ferret', 'badger',
];

const pick = list => list[Math.floor(Math.random() * list.length)];

/** @param {Set<string>|string[]} [taken]  names not to return */
export function funnyName(taken = []) {
  const used = new Set(taken);
  const base = `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
  let name = base;

  for(let n = 2; used.has(name); n++) name = `${base}-${n}`;
  return name;
}
