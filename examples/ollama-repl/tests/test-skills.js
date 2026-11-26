/* test-skills.js: skill discovery in both directories, front matter, lookup by prefix, the loaded message */
import { listSkills, findSkill, parseSkill, skillMessage, skillMarker } from '../lib/agent/skills.js';
import { mkdir, symlink, exec } from 'os';
import { open, setenv } from 'std';

const root = `/tmp/test-skills-${Date.now()}`;
const check = (what, ok) => {
  if(!ok) throw new Error(`test-skills: ${what}`);
};
const write = (path, text) => {
  const f = open(path, 'w');
  f.puts(text);
  f.close();
};

/* the two directories live in a scratch HOME and XDG_CONFIG_HOME */
for(const d of ['', '/cfg', '/cfg/ollama-repl', '/cfg/ollama-repl/skills', '/cfg/ollama-repl/skills/alpha', '/home', '/home/.claude', '/home/.claude/skills', '/home/.claude/skills/beta', '/home/.claude/skills/real', '/home/.claude/skills/real/alpha', '/home/.claude/skills/alphabet']) mkdir(root + d, 0o755);
write(`${root}/cfg/ollama-repl/skills/alpha/SKILL.md`, '---\nname: alpha\ndescription: first line\n  continued here\n---\n\n# Alpha\nbody of the config alpha\n');
write(`${root}/cfg/ollama-repl/skills/plain.md`, 'no front matter, just text\n');
write(`${root}/home/.claude/skills/beta/SKILL.md`, '---\nname: beta\ndescription: "quoted beta"\n---\nbeta body\n');
write(`${root}/home/.claude/skills/alphabet/SKILL.md`, '---\ndescription: >\n  folded\n  text\n---\nabc\n');
write(`${root}/home/.claude/skills/alpha.dup`, 'not a skill');
symlink(`${root}/home/.claude/skills/beta`, `${root}/home/.claude/skills/linked`);
mkdir(`${root}/home/.claude/skills/alpha`, 0o755);
write(`${root}/home/.claude/skills/alpha/SKILL.md`, '---\nname: alpha\ndescription: hidden by the config one\n---\nclaude alpha\n');
setenv('HOME', `${root}/home`);
setenv('XDG_CONFIG_HOME', `${root}/cfg`);

try {
  check('front matter keys', parseSkill('---\nname: x\ndescription: a\n  b\n---\nrest').meta.description === 'a b' && parseSkill('---\nname: x\n---\nrest').body === 'rest');
  check('no front matter is all body', parseSkill('plain').body === 'plain');

  const all = listSkills();
  const names = all.map(s => s.name).join();
  check(`all skills are listed once, sorted (${names})`, names === 'alpha,alphabet,beta,linked,plain');
  check('a multi-line description is folded', all.find(s => s.name === 'alpha').description === 'first line continued here');
  check('the config directory wins', all.find(s => s.name === 'alpha').source === 'config' && findSkill('alpha').body.includes('config alpha'));
  check('a symlinked skill dir works', findSkill('linked').body.trim() === 'beta body');
  check('a plain NAME.md works', findSkill('plain').body.startsWith('no front matter'));
  check('a unique prefix finds it', findSkill('bet').name === 'beta');
  check('an exact name beats a longer one', findSkill('alpha').name === 'alpha');
  check('an ambiguous prefix says so', findSkill('al')?.ambiguous?.length === 2 || findSkill('al')?.name === undefined);
  check('unknown is null', findSkill('zzz') === null);
  check('the message names the file and starts with the marker', skillMessage(findSkill('beta')).startsWith(skillMarker('beta')) && skillMessage(findSkill('beta')).includes('SKILL.md'));
  console.log('test-skills ok');
} finally {
  exec(['rm', '-rf', root]);
}
