/**
 * Tracks output files this session has written - both explicitly named
 * ("File: path") and auto-named ("<model>-output-N.ext" for an unlabeled
 * fenced code block, see extractAnonymousBlocks() in file-blocks.js) -
 * so the auto-numbering never collides with a previous run's output
 * files still sitting in the project tree.
 */
import { readdir } from 'os';

export class SentFiles {
  #model;
  #root;
  #next;
  #sent = [];

  constructor(model, root = '.') {
    this.#model = model;
    this.#root = root;
    this.#next = this.#scanNext();
  }

  #scanNext() {
    const prefix = `${this.#model}-output-`;
    const [names] = readdir(this.#root);
    let max = 0;

    for(const name of names ?? []) {
      if(!name.startsWith(prefix)) continue;

      const n = parseInt(name.slice(prefix.length), 10);
      if(Number.isFinite(n) && n > max) max = n;
    }

    return max + 1;
  }

  /** Reserves and returns the next "<model>-output-N.ext" path. */
  nextOutputPath(ext) {
    return `${this.#model}-output-${this.#next++}.${ext}`;
  }

  add(path) {
    if(!this.#sent.includes(path)) this.#sent.push(path);
  }

  has(path) {
    return this.#sent.includes(path);
  }

  get all() {
    return [...this.#sent];
  }
}
