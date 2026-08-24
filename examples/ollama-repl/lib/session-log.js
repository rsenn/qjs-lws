/**
 * Appends a plain-text, timestamped transcript of a REPL session -
 * prompts (with what was attached), replies, and files written - to
 * `<model>.log` in the current directory, independent of anything shown
 * on screen (the terminal only shows the current session; this
 * accumulates across runs since it's opened in append mode).
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

  reply(text) {
    this.#line('QWEN', text);
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
