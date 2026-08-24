/**
 * Beautiful request/response logger shared by the *-client.js API clients
 * (OllamaClient, GeminiClient, OpenAIClient) - every request payload, full
 * response, and stream chunk gets appended to its own dedicated log file,
 * formatted via Console/inspect() the same way console.debug() would (full
 * depth, no truncation, one value per line rather than JSON.stringify's
 * single-line dump) so a logged payload is both readable and, per
 * `reparseable: true`, valid JS to paste back into a REPL.
 *
 * A dedicated Console instance per client (not the global `console`) so
 * this is unaffected by whatever the global one is doing and always goes
 * to the file, never the terminal - which is already busy with the
 * "Thinking..." spinner/reply.
 */
import { Console } from 'console';
import { open as fopen, getenv } from 'std';

export class RequestLogger {
  #console;
  #file;
  #destroyed = false;

  /**
   * @param {string} path  log file path (opened in append mode)
   * @param {boolean} [enabled] turns logging on; also enabled by the
   *   `DEBUG` env var regardless of this flag
   */
  constructor(path, enabled = false) {
    if(!enabled && !getenv('DEBUG')) return;

    this.#file = fopen(path, 'a');
    this.#console = new Console(this.#file, {
      inspectOptions: {
        colors: false,
        compact: -1,
        reparseable: true,
        maxStringLength: Infinity,
        maxArrayLength: Infinity,
      },
    });
  }

  #line(tag, value) {
    this.#console?.debug(`[${new Date().toISOString()}] ${tag}`, value);
  }

  request(payload) {
    this.#line('request', payload);
  }

  response(data) {
    this.#line('response', data);
  }

  chunk(data) {
    this.#line('chunk', data);
  }

  /* Idempotent - see BUGS: repl-controlc-double-invokes-cleanup-handlers.
     A double Ctrl-C in the REPL (lib/chat-repl.js's base class) runs every
     registered cleanup handler, including each client's destroy(), twice;
     without this guard the second call's this.#file.close() would throw
     "invalid file handle" on the already-closed handle, and since that
     throw happens inside the REPL's own exit()'s cleanup loop - which runs
     *before* exit()'s std.exit() call - it would silently stop the process
     from ever actually exiting. */
  close() {
    if(this.#destroyed) return;
    this.#destroyed = true;

    this.#file?.close();
  }
}

export default RequestLogger;
