/**
 * Appends a plain-text, timestamped transcript of a REPL session -
 * prompts (with what was attached), replies, tool results and files
 * written - to `session.log` of the session's cache directory
 * (lib/session/session-cache.js), independent of anything shown on screen (the
 * terminal only shows the current session; this accumulates across runs
 * since it's opened in append mode). A reply is tagged with the model that
 * wrote it: `[time] MODEL gpt-oss-120b: ...`.
 */
import { open as fopen } from 'std';

export class SessionLog {
  #file;

  constructor(path) {
    this.#file = fopen(this.path = path, 'a');
  }

  #line(tag, text) {
    if(!this.#file) return;

    this.#file.puts(`[${new Date().toISOString()}] ${tag}: ${text.replaceAll(/\n/g, '\n  ')}\n`);
    this.#file.flush();
  }

  prompt(text, attachedPaths = []) {
    this.#line('YOU', attachedPaths.length ? `${text}\n  (attached: ${attachedPaths.join(', ')})` : text);
  }

  /** @param {string} [model] the model that answered, in the tag */
  reply(text, model) {
    this.#line(model ? `MODEL ${model}` : 'MODEL', text);
  }

  /** a /cd: the working directory changed */
  cd(from, to) {
    this.#line('CD', `${from} -> ${to}`);
  }

  toolResults(text) {
    this.#line('TOOL', text);
  }

  modified(paths = []) {
    if(paths.length) this.#line('MODIFIED', paths.join(', '));
  }

  close() {
    this.#file?.close();
    this.#file = null;
  }
}
