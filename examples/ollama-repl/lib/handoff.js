/**
 * Handoff for a model failover (see lib/failover.js): the model that takes
 * over has no chat state, and replaying the whole conversation to it would
 * burn the (free) quota of the next site just as fast. So the conversation
 * is compacted first:
 *
 *   - the base messages (system prompt, project scan) stay as they are
 *   - the last `keepTurns` user turns are kept as they were, except that big
 *     tool results are clipped
 *   - everything older is replaced by one summary, written by a small local
 *     ollama model - never by the site that just ran out of quota
 *
 * If that model cannot be reached, a plain digest (what the user asked, which
 * files were read or changed) stands in for the summary: nothing is silently
 * dropped.
 */
import { OllamaClient } from './ollama-client.js';

export const HANDOFF_MODEL = 'qwen3:4b-instruct';

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n... (${s.length - n} more characters cut)` : s);

/** older turns / the last `keepTurns` user turns (a turn = a user message and everything up to the next) */
export function splitTurns(rest, keepTurns) {
  const users = [];
  rest.forEach((m, i) => m.role === 'user' && users.push(i));
  if(users.length <= keepTurns) return { head: [], tail: rest };

  const at = users[users.length - keepTurns];
  return { head: rest.slice(0, at), tail: rest.slice(at) };
}

/** a copy of the messages with tool results clipped to `toolChars` */
export function clipToolResults(msgs, toolChars) {
  return msgs.map(m => (m.role === 'tool' && typeof m.content === 'string' && m.content.length > toolChars ? { ...m, content: clip(m.content, toolChars) } : m));
}

/** the transcript as plain text, for the summarizer */
export function renderTranscript(msgs, toolChars = 400) {
  return msgs
    .map(m => {
      if(m.role === 'tool') return `TOOL ${m.name ?? ''} RESULT: ${clip(String(m.content ?? ''), toolChars)}`;
      const calls = (m.toolCalls ?? []).map(tc => `\n  [called ${tc.name} ${clip(JSON.stringify(tc.args ?? {}), 200)}]`).join('');
      return `${m.role.toUpperCase()}: ${clip(String(m.content ?? ''), 1500)}${calls}`;
    })
    .join('\n');
}

/** no model needed: what was asked and which files were touched */
export function digest(msgs) {
  const asked = msgs.filter(m => m.role === 'user').map(m => `- ${clip(String(m.content ?? '').replace(/\s+/g, ' '), 200)}`);
  const files = new Set();
  for(const m of msgs) for(const tc of m.toolCalls ?? []) if(tc.args?.path) files.add(`${tc.name} ${tc.args.path}`);

  return `The user asked, in order:\n${asked.join('\n')}${files.size ? `\nFiles touched: ${[...files].join(', ')}` : ''}`;
}

/** @returns {Promise<string|null>} the summary, or null if the local model could not write it */
export async function summarize(head, { model = HANDOFF_MODEL, host = 'localhost', port = 11434 } = {}) {
  const client = new OllamaClient({ host, port, model, think: false, numCtx: 8192, temperature: 0.2, timeoutSecs: 180 });

  try {
    const transcript = renderTranscript(head).slice(-14000);
    const { content } = await client.chat([
      { role: 'system', content: 'You compress coding-session transcripts for a successor assistant that has not seen them. Reply with the summary only.' },
      { role: 'user', content: `Summarize this transcript for a successor in at most 200 words of plain text, under exactly these headings:\nFACTS: everything the user told us that must be remembered - names, code words, preferences, paths, decisions - copied exactly, even if it is not a task.\nGOAL: what the user wants overall.\nDONE: only changes that a tool result in the transcript shows were actually made (file and what changed).\nREAD ONLY: files that were only read.\nNOT DONE YET: everything the user asked for that no tool result shows as done, and any open question.\nNever say something was done unless a tool result confirms it; an intention or a plan is NOT DONE YET. Keep exact file names, function names and error messages.\n\n${transcript}` },
    ]);
    return content?.trim() || null;
  } catch(e) {
    return null;
  } finally {
    client.destroy();
  }
}

/**
 * @param {object[]} messages  the whole conversation
 * @param {number} base        how many leading messages are base (system prompt, project scan) and stay untouched
 * @param {object} o
 * @param {number} [o.keepTurns=3]
 * @param {number} [o.toolChars=600]
 * @param {string} [o.model]    summarizer
 * @param {string} [o.host]
 * @param {number} [o.port]
 * @returns {Promise<{messages: object[], cut: number, kept: number, by: string}|null>} null if there is nothing to compact
 */
export async function buildHandoff(messages, base, { keepTurns = 3, toolChars = 600, model = HANDOFF_MODEL, host, port } = {}) {
  const rest = messages.slice(base);
  const { head, tail } = splitTurns(rest, keepTurns);
  const clipped = clipToolResults(tail, toolChars);

  if(!head.length && clipped.every((m, i) => m === tail[i])) return null;

  let note = [];
  let by = 'none';

  if(head.length) {
    const summary = await summarize(head, { model, host, port });
    by = summary ? model : 'digest';
    note = [
      { role: 'user', content: `[handoff] The model that was answering reached its limit, so you take over. Older turns were cut; this is the summary of them (${summary ? 'written by a local model' : 'a plain digest'}):\n\n${summary ?? digest(head)}` },
      { role: 'assistant', content: 'Understood - I will continue from that summary.' },
    ];
  }

  return { messages: [...messages.slice(0, base), ...note, ...clipped], cut: head.length, kept: tail.length, by };
}
