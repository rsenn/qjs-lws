/* turn-repair.js: what a conversation looks like after a turn died half way (an error in a later round of the
   tool loop). Dropping the whole turn is right when nothing happened; once files were written or commands ran,
   the model must still know it, so the finished rounds stay and only a round with unanswered tool calls goes. */

/**
 * @param {object[]} messages  the conversation, edited in place
 * @param {object} turnMsg     the user message that began the turn
 * @param {{sideEffects: boolean, reason: string}} o
 * @returns {'gone'|'dropped'|'kept'} gone: the turn was already folded away, dropped: whole turn removed,
 *   kept: finished rounds stay (an unanswered one trimmed) and an assistant note closes the turn
 */
export function repairTurn(messages, turnMsg, { sideEffects, reason }) {
  const start = messages.indexOf(turnMsg);
  if(start < 0) return 'gone';

  /* the first assistant round whose tool calls are not all answered by the tool messages right after it */
  let cut = messages.length;
  for(let i = start + 1; i < messages.length; i++) {
    const m = messages[i];
    if(m.role !== 'assistant' || !m.toolCalls?.length) continue;
    let answered = 0;
    while(messages[i + 1 + answered]?.role === 'tool') answered++;
    if(answered < m.toolCalls.length) {
      cut = i;
      break;
    }
  }
  messages.length = cut;

  const kept = messages.slice(start + 1).some(m => m.role === 'tool');
  if(!sideEffects || !kept) {
    messages.length = start;
    return 'dropped';
  }

  messages.push({ role: 'assistant', content: `(the turn was interrupted: ${String(reason).split('\n')[0].slice(0, 200)}. The tool calls above did run and their changes stand.)` });
  return 'kept';
}
