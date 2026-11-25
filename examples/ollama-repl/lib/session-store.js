/**
 * Persists the conversation (`messages`, plus the `/reset` baseline
 * `baseMessageCount`) to `session.json` of the session's cache directory
 * (lib/session-cache.js) after every completed turn, so a
 * killed or restarted REPL can pick a session back up via load() instead
 * of starting cold; `session.log` and `diffs/` sit beside it.
 */
import { loadFile, open as fopen } from 'std';

export class SessionStore {
  #path;

  /** @param {string} path  the session file */
  constructor(path) {
    this.#path = path;
  }

  get path() {
    return this.#path;
  }

  /** @returns {{ messages: object[], baseMessageCount: number, queue: string[] }|null} null if there's nothing (valid) to resume. */
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

    return {
      messages: data.messages,
      baseMessageCount: Number.isInteger(data.baseMessageCount) ? data.baseMessageCount : 0,
      queue: Array.isArray(data.queue) ? data.queue.filter(q => typeof q === 'string') : [],
    };
  }

  save(messages, baseMessageCount, queue = []) {
    const f = fopen(this.#path, 'w');
    f.puts(JSON.stringify({ messages, baseMessageCount, queue }, null, 2));
    f.close();
  }
}
