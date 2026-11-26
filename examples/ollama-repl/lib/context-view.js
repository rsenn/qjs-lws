/**
 * context-view: the pure parts of /context and /log (message text, selections, the summary view and the
 * argument parsing of `/context [show|save|copy] SELECTION [FILE]`), kept out of repl.js so they have tests
 *
 * ```js
 * messageText(m, i);                       // one message in full, nothing cut
 * messageSelection('1-3,5', n);            // [1, 2, 3, 5] | null
 * summarizeMessages(messages);             // one line per message
 * parseContextArgs('/context save 1-3 out.txt');
 * // { verb: 'save', sel: '1-3', rest: ['out.txt'] }   verb null: not a /context subcommand
 * ```
 */

/** one message in full: index, role, char count, then the content and its tool calls, nothing cut */
export function messageText(m, i) {
  const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
  const calls = (m.toolCalls ?? []).map(tc => `[called ${tc.name} ${JSON.stringify(tc.args ?? {})}]`);
  return `[${i}] ${m.role}${m.name ? ` ${m.name}` : ''} (${content.length} chars)\n${content}${calls.length ? `\n${calls.join('\n')}` : ''}`;
}

/** message numbers from "3", "#3", "1-4", "1,3,5" or "all" (whole list `n` long); null when one is not a message */
export function messageSelection(text, n) {
  if(/^all$/i.test(text)) return Array.from({ length: n }, (_, i) => i);

  const out = [];

  for(const part of text.split(/[\s,]+/).filter(Boolean)) {
    const m = /^#?(\d+)(?:-#?(\d+))?$/.exec(part);
    if(!m) return null;

    const [a, b] = [+m[1], m[2] === undefined ? +m[1] : +m[2]];
    if(a > b || b >= n) return null;
    for(let i = a; i <= b; i++) if(!out.includes(i)) out.push(i);
  }

  return out.length ? out : null;
}

/** One line per message: index, role, char count, and a truncated preview (the non-debug view of /context and /log) */
export function summarizeMessages(msgs) {
  return msgs
    .map((m, i) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      const preview = content.replaceAll('\n', ' ').slice(0, 80);
      return `[${i}] ${m.role} (${content.length} chars): ${preview}${content.length > 80 ? '...' : ''}`;
    })
    .join('\n');
}

/**
 * the words after `/context`: the verb (show, save, copy; a bare selection means show), the selection text
 * (null when none was given and the verb is show) and the remaining words (the FILE of save)
 */
export function parseContextArgs(prompt) {
  const [first, ...rest] = prompt.slice('/context'.length).trim().split(/\s+/);
  const verb = /^(show|save|copy)$/i.test(first) ? first.toLowerCase() : /^(#?\d|all$)/i.test(first) ? 'show' : null;
  const args = verb === 'show' && first.toLowerCase() !== 'show' ? [first, ...rest] : rest;

  if(!verb) return { verb: null, sel: null, rest: [] };

  const sel = args.length && /^(#?\d+([-,]#?\d+)*|all)$/i.test(args[0]) ? args.shift() : verb === 'show' ? null : 'all';
  return { verb, sel, rest: args };
}
