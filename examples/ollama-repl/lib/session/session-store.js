/**
 * Persists the conversation (`messages`, plus the `/reset` baseline
 * `baseMessageCount`) to `session.json` of the session's cache directory
 * (lib/session/session-cache.js) after every completed turn, so a
 * killed or restarted REPL can pick a session back up via load() instead
 * of starting cold; `session.log` and `diffs/` sit beside it.
 *
 * The file is `{ version: 1, updatedAt, messages, baseMessageCount, queue }`,
 * written to `session.json.tmp` and renamed, so a crash leaves the old file
 * whole. A file that cannot be read is renamed to `session.json.corrupt`
 * (load() returns null and `corrupt` says where it went).
 */
import { loadFile, open as fopen } from 'std';
import { rename } from 'os';

export const SESSION_VERSION = 1;

export class SessionStore {
  #path;

  /** where an unreadable file was put by the last load(), else null */
  corrupt = null;

  /** @param {string} path  the session file */
  constructor(path) {
    this.#path = path;
  }

  get path() {
    return this.#path;
  }

  /** @returns {{ messages: object[], baseMessageCount: number, queue: string[], updatedAt?: string }|null} null if there's nothing (valid) to resume. */
  load() {
    this.corrupt = null;
    const text = loadFile(this.#path);
    if(text == null) return null;

    let data;
    try {
      data = JSON.parse(text);
    } catch(e) {
      return this.#setAside();
    }

    if(!Array.isArray(data?.messages)) return this.#setAside();

    return {
      messages: data.messages,
      baseMessageCount: Number.isInteger(data.baseMessageCount) ? data.baseMessageCount : 0,
      queue: Array.isArray(data.queue) ? data.queue.filter(q => typeof q === 'string') : [],
      updatedAt: data.updatedAt,
    };
  }

  #setAside() {
    const to = `${this.#path}.corrupt`;
    if(rename(this.#path, to) === 0) this.corrupt = to;
    return null;
  }

  /** @returns {boolean} whether the file was written */
  save(messages, baseMessageCount, queue = []) {
    const tmp = `${this.#path}.tmp`;
    const f = fopen(tmp, 'w');
    if(!f) return false;

    f.puts(JSON.stringify({ version: SESSION_VERSION, updatedAt: new Date().toISOString(), messages, baseMessageCount, queue }, null, 2));
    f.close();
    return rename(tmp, this.#path) === 0;
  }
}
