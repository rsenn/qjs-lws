/**
 * Handoff for a model failover (see lib/failover/failover.js): the model that takes
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
import { OllamaClient } from '../clients/ollama-client.js';

export const HANDOFF_MODEL = 'qwen3:4b-instruct';

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n... (${s.length - n} more characters cut)` : s);

/** older turns / the last `keepTurns` user turns (a turn = a user message and everything up to the next) */
export function splitTurns(rest, keepTurns) {
  const users = [];
  rest.forEach((m, i) => m.role === 'user' && users.push(i));
  if(keepTurns <= 0) return { head: rest, tail: [] };
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

/* characters of transcript one summarizer call gets (its context is 8192 tokens), and how many
   chunks of a long transcript are summarized (the newest ones; older turns are then only named) */
const CHUNK_CHARS = 12000;
const MAX_CHUNKS = 10;

const SUMMARY_PROMPT = (text, focus) =>
  `${focus ? `The user wants this kept above all, copied exactly and listed first under FACTS or GOAL: ${focus}\n` : ''}Summarize this transcript for a successor in at most 200 words of plain text, under exactly these headings:\nFACTS: everything the user told us that must be remembered - names, code words, preferences, paths, decisions - copied exactly, even if it is not a task.\nGOAL: what the user wants overall.\nDONE: only changes that a tool result in the transcript shows were actually made (file and what changed).\nREAD ONLY: files that were only read.\nNOT DONE YET: everything the user asked for that no tool result shows as done, and any open question.\nNever say something was done unless a tool result confirms it; an intention or a plan is NOT DONE YET. Keep exact file names, function names and error messages.\n\n${text}`;

/**
 * @returns {Promise<string|null>} the summary, or null if the local model could not write it
 *
 * A transcript longer than one call takes is summarized in chunks, and the
 * chunk summaries are summarized together (up to three passes), so the
 * start of a long session is not lost the way cutting the transcript to its
 * last characters lost it.
 */
export async function summarize(head, { model = HANDOFF_MODEL, host = 'localhost', port = 11434, focus } = {}) {
  const client = new OllamaClient({ host, port, model, think: false, numCtx: 8192, temperature: 0.2, timeoutSecs: 180 });

  const once = async text => {
    const { content } = await client.chat([
      { role: 'system', content: 'You compress coding-session transcripts for a successor assistant that has not seen them. Reply with the summary only.' },
      { role: 'user', content: SUMMARY_PROMPT(text, focus) },
    ]);
    return content?.trim() || null;
  };

  try {
    let text = renderTranscript(head);

    for(let pass = 0; text.length > CHUNK_CHARS && pass < 3; pass++) {
      const parts = [];
      for(let i = 0; i < text.length; i += CHUNK_CHARS) parts.push(text.slice(i, i + CHUNK_CHARS));

      const cut = Math.max(0, parts.length - MAX_CHUNKS);
      const sums = [];
      for(const part of parts.slice(cut)) {
        const sum = await once(part);
        if(!sum) return null;
        sums.push(sum);
      }

      text = (cut ? `(${cut} older chunks of the transcript are not summarized)\n\n` : '') + sums.map((x, i) => `PART ${i + 1}:\n${x}`).join('\n\n');
    }

    return await once(text);
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
 * @param {'failover'|'compact'|'handoff'} [o.reason]  what the note tells the model about why older turns are gone
 * @param {string} [o.focus]  what the user wants kept in the summary (/handoff TEXT)
 * @param {string} [o.instructions]  the user's words for the next model, appended to the note verbatim (/handoff TEXT)
 * @param {boolean} [o.clipAlone=true]  when no older turn exists to summarize, still clip the kept turns' tool results; false returns null then
 * @returns {Promise<{messages: object[], cut: number, kept: number, by: string}|null>} null if there is nothing to compact
 */
export async function buildHandoff(messages, base, { keepTurns = 3, toolChars = 600, model = HANDOFF_MODEL, host, port, reason = 'failover', focus, instructions, clipAlone = true } = {}) {
  const rest = messages.slice(base);
  const { head, tail } = splitTurns(rest, keepTurns);
  if(!head.length && !clipAlone) return null;

  const clipped = clipToolResults(tail, toolChars);

  if(!head.length && clipped.every((m, i) => m === tail[i])) return null;

  let note = [];
  let by = 'none';

  if(head.length) {
    const summary = await summarize(head, { model, host, port, focus });
    by = summary ? model : 'digest';
    note = [
      {
        role: 'user',
        content: `${reason === 'compact' ? '[compacted] The conversation outgrew the context window, so older turns were replaced by this summary of them' : reason === 'handoff' ? '[handoff] The user ended the conversation so far to continue with a fresh context, and you take over. Everything before was replaced by this summary of it' : '[handoff] The model that was answering reached its limit, so you take over. Older turns were cut; this is the summary of them'} (${summary ? 'written by a local model' : 'a plain digest'}):\n\n${summary ?? digest(head)}${instructions ? `\n\nInstructions from the user for you, the next model:\n${instructions}` : ''}`,
      },
      { role: 'assistant', content: 'Understood - I will continue from that summary.' },
    ];
  }

  return { messages: [...messages.slice(0, base), ...note, ...clipped], cut: head.length, kept: tail.length, by };
}

/* ------------------------------------------------------------------------------------------------
   Knowledge handoff (/handoff): a document for an assistant that has seen neither the conversation
   nor the files, e.g. a web chat. buildHandoff() above keeps a conversation going inside a small
   window and so writes a short *history* (what was asked, which files were read); this one keeps
   what was *learned*: the previous model's own analysis verbatim, and notes extracted from every
   file or command result that was read, guided by what the user wants kept.
   ------------------------------------------------------------------------------------------------ */

const EXTRACT_CHUNK = 9000;
const EXTRACT_MAX_CHUNKS = 7;

const hardCut = (text, chars) => {
  if(text.length <= chars) return text;
  const at = text.lastIndexOf('\n', chars);
  return `${text.slice(0, at > chars * 0.6 ? at : chars).trimEnd()}\n...`;
};

/** one local-model call that must not fail the whole handoff: null when it does */
async function ask(client, system, user) {
  try {
    return (await client.chat([{ role: 'system', content: system }, { role: 'user', content: user }]))?.content?.trim() || null;
  } catch(e) {
    return null;
  }
}

const EXTRACT_SYSTEM = 'You extract facts from source material for a successor assistant that cannot see it. Reply with plain bullet notes only, no preface, no prose. Reply exactly NONE if nothing in the text matters for the stated need.';

/** the notes of one tool result: every chunk is mined for what `focus` asks, the notes are then cut to `chars` */
async function extractNotes(client, label, text, focus, chars, signal) {
  const chunks = [];
  for(let i = 0; i < text.length && chunks.length < EXTRACT_MAX_CHUNKS; i += EXTRACT_CHUNK) chunks.push(text.slice(i, i + EXTRACT_CHUNK));

  const each = Math.max(400, Math.round((chars * 1.4) / chunks.length));
  const notes = [];

  for(const [i, chunk] of chunks.entries()) {
    if(signal.stopped) return null;

    const n = await ask(client, EXTRACT_SYSTEM, `Need: ${focus || 'what a successor must know to continue this work'}\n\nFrom this part (${i + 1}/${chunks.length}) of ${label}, list in at most ${each} characters every fact that serves the need: names of algorithms, classes, functions and files; signal flow; parameters, constants and formulas; how they combine. Keep exact names.\n\n${chunk}`);
    if(n && !/^NONE\b/i.test(n)) notes.push(n);
  }

  let out = notes.join('\n');
  if(out.length > chars * 1.3 && !signal.stopped) out = (await ask(client, EXTRACT_SYSTEM, `Need: ${focus || 'what a successor must know'}\n\nShorten these notes to at most ${chars} characters, keeping every name, number and formula and dropping duplicates:\n\n${out}`)) ?? out;

  return hardCut(out, Math.round(chars * 1.3));
}

/**
 * The document: the task, the instructions, what the previous model concluded (verbatim, newest kept
 * first when it is too long) and notes from every file or command result read in the conversation.
 *
 * @param {object[]} messages
 * @param {number} base  leading base messages (system prompt, project scan) that are left out
 * @param {object} o
 * @param {string} [o.focus]         what to keep, the user's words
 * @param {string} [o.instructions]  for the next model, verbatim
 * @param {number} [o.size=24000]    characters of document, about
 * @param {string} [o.model]         the local extractor
 * @param {(line: string) => void} [o.onProgress]
 * @param {(stop: () => void) => void} [o.register]  gets a function that stops the work
 * @returns {Promise<{doc: string, sources: number, noted: number, cancelled: boolean}|null>} null if there is nothing in the conversation
 */
export async function buildKnowledge(messages, base, { focus, instructions, size = 24000, model = HANDOFF_MODEL, host, port, onProgress = () => {}, register = () => {} } = {}) {
  const rest = messages.slice(base);
  if(!rest.length) return null;

  const signal = { stopped: false };
  const client = new OllamaClient({ host, port, model, think: false, numCtx: 8192, temperature: 0.2, timeoutSecs: 240 });
  register(() => {
    signal.stopped = true;
    client.abort();
  });

  try {
    const calls = new Map();
    for(const m of rest) for(const tc of m.toolCalls ?? []) calls.set(tc.id, tc);

    const asked = rest.filter(m => m.role === 'user' && !/^\((automatic project scan|project brief)|^\[(handoff|compacted)\]/.test(m.content ?? '')).map(m => `- ${hardCut(String(m.content ?? '').replace(/\s+/g, ' '), 500)}`);

    /* the previous model's own analysis: the longest replies carry the findings, the last one the conclusion */
    const replies = rest.filter(m => m.role === 'assistant' && String(m.content ?? '').trim().length > 300).map(m => m.content.trim());
    let findingsBudget = Math.round(size * 0.45);
    const kept = [];
    for(const r of replies.reverse()) {
      if(findingsBudget <= 300) break;
      const t = hardCut(r, findingsBudget);
      kept.unshift(t);
      findingsBudget -= t.length;
    }

    /* every result worth reading, in conversation order */
    const results = rest.filter(m => m.role === 'tool' && typeof m.content === 'string' && m.content.trim().length > 0 && !/^(error\b|grep: .*No such file)/i.test(m.content) && m.toolCallId !== '!-user');
    const big = results.filter(m => m.content.length > 500);
    const per = Math.max(500, Math.min(4000, Math.round((size * 0.45) / Math.max(1, big.length))));
    const sections = [];
    let noted = 0;

    for(const [i, m] of results.entries()) {
      const tc = calls.get(m.toolCallId);
      const label = tc ? `${tc.name} ${tc.args?.path ?? tc.args?.command ?? tc.args?.pattern ?? ''}`.trim() : m.name ?? 'result';

      if(m.content.length <= 500) {
        sections.push(`### ${label}\n${m.content.trim()}`);
        continue;
      }

      onProgress(`handoff: notes from ${label} (${i + 1}/${results.length}, ${m.content.length} chars)`);
      const n = await extractNotes(client, label, m.content, focus, per, signal);
      if(signal.stopped) return { doc: '', sources: results.length, noted, cancelled: true };
      if(n) {
        sections.push(`### ${label} (${m.content.length} chars read)\n${n}`);
        noted++;
      }
    }

    const doc = [
      '# Handoff',
      'This is a handoff from a coding-assistant session. You have not seen the conversation or the files; everything you need is below. The analysis is by the previous model, the notes were extracted from the files it read.',
      instructions ? `## Instructions\n${instructions}` : '',
      asked.length ? `## What the user asked, in order\n${asked.join('\n')}` : '',
      kept.length ? `## Findings of the previous model (verbatim)\n${kept.join('\n\n---\n\n')}` : '',
      sections.length ? `## Notes from the files and commands${focus ? ` (focus: ${hardCut(focus.replace(/\s+/g, ' '), 200)})` : ''}\n\n${sections.join('\n\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    return { doc, sources: results.length, noted, cancelled: false };
  } finally {
    client.destroy();
  }
}
