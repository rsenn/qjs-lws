/**
 * skills: instructions the user keeps in files, loaded into the
 * conversation on demand (`/skill NAME`).
 *
 * A skill is a directory with a SKILL.md (the Claude Code layout) or, in
 * the first directory only, a plain NAME.md:
 *
 *   ~/.config/ollama-repl/skills/   ollama-repl's own, wins on a name clash
 *   ~/.claude/skills/               the Claude Code skills (directories or symlinks to them)
 *
 * ```js
 * listSkills();                    // [{ name, description, path, dir, source }]
 * const s = findSkill('comment');  // exact name, else the one name starting with it
 * s.body;                          // SKILL.md without its front matter
 * ```
 *
 * The front matter is the `---` block at the top: `name:` and
 * `description:` (one line, or folded over indented lines) are read, other
 * keys are ignored.
 */
import { getenv, loadFile } from 'std';
import { readdir } from 'os';
import { configDir } from '../config.js';

/** bigger bodies are cut: they would use up a small model's window; the files stay readable with read_file */
export const MAX_SKILL_CHARS = 30000;

export const skillDirs = () => [
  { path: `${configDir()}/skills`, source: 'config', plainFiles: true },
  { path: `${getenv('HOME')}/.claude/skills`, source: 'claude', plainFiles: false },
];

/** splits a SKILL.md into its front matter fields and the rest */
export function parseSkill(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text ?? '');
  if(!m) return { meta: {}, body: String(text ?? '') };

  const meta = {};
  let key = null;

  for(const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);

    if(kv) {
      key = kv[1];
      meta[key] = kv[2].replace(/^(>|\|)[-+]?$/, '').replace(/^(["'])(.*)\1$/, '$2');
    } else if(key && /^\s+\S/.test(line)) meta[key] = `${meta[key]} ${line.trim()}`.trim();
  }

  return { meta, body: m[2] };
}

const oneLine = s =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Every skill found, sorted by name; a name in an earlier directory hides
 * the same name in a later one.
 *
 * @returns {{name: string, description: string, path: string, dir: string, source: string}[]}
 */
export function listSkills() {
  const found = new Map();

  for(const { path: root, source, plainFiles } of skillDirs()) {
    const [names] = readdir(root);

    for(const entry of (names ?? []).filter(n => !n.startsWith('.')).sort()) {
      const candidates = [[entry, `${root}/${entry}/SKILL.md`, `${root}/${entry}`]];
      if(plainFiles && entry.endsWith('.md')) candidates.push([entry.slice(0, -3), `${root}/${entry}`, root]);

      for(const [name, path, dir] of candidates) {
        if(found.has(name)) continue;

        const text = loadFile(path);
        if(text == null) continue;

        const { meta } = parseSkill(text);
        found.set(name, { name, description: oneLine(meta.description), path, dir, source });
      }
    }
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The skill called `name`: the exact name, else the only one whose name
 * starts with it.
 *
 * @returns {{name: string, description: string, path: string, dir: string, source: string, body: string, cut: boolean}|{ambiguous: string[]}|null}
 */
export function findSkill(name) {
  const all = listSkills();
  const hit = all.find(s => s.name === name) ?? (all.filter(s => s.name.startsWith(name)).length === 1 ? all.find(s => s.name.startsWith(name)) : null);

  if(!hit) {
    const many = all.filter(s => s.name.startsWith(name));
    return many.length > 1 ? { ambiguous: many.map(s => s.name) } : null;
  }

  const { body } = parseSkill(loadFile(hit.path));
  const cut = body.length > MAX_SKILL_CHARS;

  return { ...hit, body: cut ? body.slice(0, MAX_SKILL_CHARS) : body, cut };
}

/** the user message that puts a skill into the conversation */
export const skillMessage = skill =>
  `(skill "${skill.name}" loaded from ${skill.path}: follow these instructions for the rest of this task; files the skill mentions are relative to ${skill.dir})\n\n${skill.body.trim()}${skill.cut ? `\n\n[... the skill is longer than ${MAX_SKILL_CHARS} characters, the rest: read_file ${skill.path}]` : ''}`;

/** the marker every loaded skill message starts with, to find (and unload) it again */
export const skillMarker = name => `(skill "${name}" loaded from `;
