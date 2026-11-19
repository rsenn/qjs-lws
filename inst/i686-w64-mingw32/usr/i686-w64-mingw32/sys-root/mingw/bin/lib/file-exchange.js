/**
 * Tracks every file exchanged with the model in both directions this
 * session - attached (project -> model) and written (model -> project,
 * see saveAllBlocks() in file-blocks.js) - and, for a written file that
 * already existed, saves a unified diff against what was there before so
 * the change can be reviewed or undone (`patch -R < <model>-diffs/NNN-*.diff`).
 */
import { loadFile, open as fopen } from 'std';
import { getpid, mkdir, remove, stat } from 'os';
import { runCommand } from './run-command.js';

export class FileExchange {
  #model;
  #root;
  #diffDir;
  #diffDirReady = false;
  #nextDiff = 1;
  #sent = [];
  #received = [];

  constructor(model, root = '.') {
    this.#model = model;
    this.#root = root;
    this.#diffDir = `${model}-diffs`;
  }

  /** Record a file attached to an outgoing prompt (project -> model). */
  recordSent(paths) {
    const now = new Date().toISOString();

    for(const path of paths) this.#sent.push({ path, timestamp: now });
  }

  /**
   * Record a file the model wrote (model -> project), called right
   * before it's actually written to disk. If `path` already existed with
   * different content, diffs old vs. new and saves the diff.
   *
   * @returns {Promise<string|null>} the diff text, or null (new file, or
   *   content unchanged).
   */
  async recordReceived(path, newContent) {
    const full = this.#root === '.' ? path : `${this.#root}/${path}`;
    const [st] = stat(full);
    const existed = !!st;
    let diffPath = null;

    if(existed) {
      const oldContent = loadFile(full);

      if(oldContent != null && oldContent !== newContent) {
        const diffText = await this.#diff(path, oldContent, newContent);
        if(diffText) diffPath = this.#saveDiff(path, diffText);
      }
    }

    this.#received.push({ path, timestamp: new Date().toISOString(), existed, diffPath });

    return diffPath;
  }

  async #diff(path, oldContent, newContent) {
    const pid = getpid();
    const oldPath = `/tmp/ollama-repl-${pid}-old`;
    const newPath = `/tmp/ollama-repl-${pid}-new`;

    for(const [p, content] of [
      [oldPath, oldContent],
      [newPath, newContent],
    ]) {
      const f = fopen(p, 'w');
      f.puts(content);
      f.close();
    }

    const { output } = await runCommand(`diff -u ${oldPath} ${newPath}`);

    remove(oldPath);
    remove(newPath);

    if(!output.trim()) return null;

    return output.replaceAll(oldPath, `a/${path}`).replaceAll(newPath, `b/${path}`);
  }

  #saveDiff(path, diffText) {
    const diffDirFull = this.#root === '.' ? this.#diffDir : `${this.#root}/${this.#diffDir}`;

    if(!this.#diffDirReady) {
      mkdir(diffDirFull); // ignores the error if it already exists
      this.#diffDirReady = true;
    }

    const base = path.replace(/\//g, '_');
    const diffPath = `${this.#diffDir}/${String(this.#nextDiff++).padStart(3, '0')}-${base}.diff`; // reported/returned relative to root, like every other path here
    const full = this.#root === '.' ? diffPath : `${this.#root}/${diffPath}`;

    const f = fopen(full, 'w');
    f.puts(diffText);
    f.close();

    return diffPath;
  }

  /** Formats the full exchange history for the /files directive. */
  dump() {
    const lines = [];

    lines.push(`Sent (project -> model): ${this.#sent.length}`);
    for(const { path, timestamp } of this.#sent) lines.push(`  ${timestamp}  ${path}`);

    lines.push(`Received (model -> project): ${this.#received.length}`);
    for(const { path, timestamp, existed, diffPath } of this.#received) {
      const note = diffPath ? `modified, diff: ${diffPath}` : existed ? 'modified, no diff (identical or unreadable original)' : 'new file';
      lines.push(`  ${timestamp}  ${path}  (${note})`);
    }

    return lines.join('\n');
  }
}
