/* test-empty-reply.js: the note for a reply with no text and no tool call */
import { emptyReplyNote } from '../lib/session/usage-stats.js';

const check = (what, ok) => {
  if(!ok) throw new Error(`test-empty-reply: ${what}`);
};

const meta = (finish, usage, extra = {}) => ({ finish, usage, ...extra });

check('text: no note', emptyReplyNote({ content: 'hi', meta: meta('stop', {}) }) === null);
check('tool call: no note', emptyReplyNote({ content: '', toolCalls: [{ name: 'a' }], meta: meta('tool_calls', {}) }) === null);
check('error: no note', emptyReplyNote({ content: '', meta: meta(undefined, undefined, { error: 'x' }) }) === null);
check('nothing at all: no note', emptyReplyNote(null) === null);

const stop = emptyReplyNote({ content: '  \n', reasoning: 'thinking...', meta: meta('stop', { completion: 1224, reasoning: 1160 }) });
check('stop with reasoning', stop.includes('no text') && stop.includes('finish=stop') && stop.includes('1.2k completion tokens') && stop.includes('1.2k reasoning') && stop.includes('may be in its reasoning'));

const length = emptyReplyNote({ content: '', meta: meta('length', { completion: 4096, reasoning: 4096 }) });
check('length', length.includes('finish=length') && length.includes('token limit'));

const bare = emptyReplyNote({ content: '', meta: {} });
check('no meta', bare === 'the model returned no text (finish=?)');
check('no reasoning, no hint', !emptyReplyNote({ content: '', meta: meta('stop', { completion: 0 }) }).includes('reasoning'));

console.log('test-empty-reply: ok');
