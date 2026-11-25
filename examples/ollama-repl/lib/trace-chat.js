/**
 * trace-chat: lets the REPL watch the chat() calls of a client it does not
 * drive itself (the local model behind /brief), to show their traffic in
 * the verbose panels.
 *
 * ```js
 * traceChat(client, ev => console.log(ev));
 * // { dir: 'out', model, messages }
 * // { dir: 'in', model, content, ms, error? }
 * ```
 */
export function traceChat(client, onTrace) {
  const orig = client.chat.bind(client);

  client.chat = async (messages, ...rest) => {
    const t0 = Date.now();
    onTrace({ dir: 'out', model: client.model, messages });

    try {
      const r = await orig(messages, ...rest);
      onTrace({ dir: 'in', model: client.model, content: String(r?.content ?? ''), ms: Date.now() - t0 });
      return r;
    } catch(e) {
      onTrace({ dir: 'in', model: client.model, content: '', ms: Date.now() - t0, error: String(e.message ?? e).split('\n')[0] });
      throw e;
    }
  };

  return client;
}
