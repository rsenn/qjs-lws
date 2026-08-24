/**
 * Generic HTTP request/response logger, for any of this project's HTTP
 * client code (see examples/ollama-repl/lib/*-client.js for its current
 * users) - not a chat/conversation transcript (see
 * examples/ollama-repl/lib/session-log.js for that kind of log). Appends,
 * to a dedicated file:
 *
 *  - the request/status line plus headers, one per line, plain text
 *  - the body, passed straight to Console/inspect() as a still-live JS
 *    value rather than pre-serialized text - so a JSON body logs as a
 *    real (reparseable) object literal instead of an escaped string, and
 *    a streamed response can be logged chunk-by-chunk as each one
 *    arrives, before the stream itself has finished.
 *
 * A dedicated Console instance (not the global `console`) so this is
 * unaffected by whatever the global one is doing and always goes to the
 * file, never the terminal.
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

    this.#file = fopen(this.path = path, 'a');
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

  /** `headers` accepts a WHATWG-style `Headers` (forEach(value, name)) or a plain object. */
  #headerLines(headers) {
    const lines = [];

    if(headers && typeof headers.forEach === 'function') headers.forEach((v, k) => lines.push(`${k}: ${v}`));
    else if(headers) for(const k in headers) lines.push(`${k}: ${headers[k]}`);

    return lines;
  }

  #printHead(startLine, headers) {
    if(!this.#console) return;

    this.#console.log([`[${new Date().toISOString()}] ${startLine}`, ...this.#headerLines(headers)].join('\n'));
  }

  /** Logs an outgoing request's method/url line and headers, one per line. */
  request(method, url, headers) {
    this.#printHead(`${method} ${url}`, headers);
  }

  /** Logs a response's status line and headers, one per line. */
  response(status, statusText, headers) {
    this.#printHead(`${status}${statusText ? ' ' + statusText : ''}`, headers);
  }

  /**
   * Logs a body value - the full request/response body, or one chunk of a
   * streamed body - as-is, not yet serialized/joined. Passed straight to
   * `Console#debug`, so a plain string prints verbatim and any other value
   * (a parsed JSON object, for instance) gets a full-depth, reparseable
   * `inspect()` dump instead of `JSON.stringify()`'s single-line text.
   */
  body(value) {
    this.#console?.debug(value);
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
