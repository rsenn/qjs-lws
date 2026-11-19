/**
 * Persists the conversation (`messages`, plus the `/reset` baseline
 * `baseMessageCount`) to `<model>.json` after every completed turn, so a
 * killed or restarted REPL can pick a session back up via load() instead
 * of starting cold - same model name a session's other per-model files
 * (`<model>.log`, `<model>-diffs/`) already key off.
 */
import { loadFile, open as fopen } from 'std';

export class SessionStore {
  #path;

  constructor(model) {
    this.#path = `${model}.json`;
  }

  get path() {
    return this.#path;
  }

  /** @returns {{ messages: object[], baseMessageCount: number }|null} null if there's nothing (valid) to resume. */
  load() {
    const text = loadFile(this.#path);
    if(text == null) return null;

    let data;
    try {
      data = JSON.parse(text);
    } catch(e) {
      return null;
    }

    if(!Array.isArray(data?.messages)) return null;

    return { messages: data.messages, baseMessageCount: Number.isInteger(data.baseMessageCount) ? data.baseMessageCount : 0 };
  }

  save(messages, baseMessageCount) {
    const f = fopen(this.#path, 'w');
    f.puts(JSON.stringify({ messages, baseMessageCount }, null, 2));
    f.close();
  }
}
