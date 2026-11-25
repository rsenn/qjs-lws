/**
 * events: what happens in the background, as short typed events - the exploration, the gateway inspection, the
 * failover. They go into a ring buffer (`/events`) and to a sink (the verbose view shows them as one line each).
 *
 * ```js
 * emit('gateway', 'kilo-auto: limited by a daily window, back in 4h', 'warn');
 * setSink(ev => console.log(eventLine(ev)));
 * eventsText({ filter: 'explore', n: 20 });      // the last 20 exploration events
 * ```
 *
 * kinds:  explore   exploration batches and the verdict per model
 *         gateway   what the inspection of the gateway sees change: limited / back, quota thresholds, reachability
 *         quota     monthly token budget crossing 80%, 95%, 100%
 *         key       a provider key that went unhealthy or healthy again
 *         failover  skips, switches to the standby or the best rated model, retries, provider fallback
 *         standby   the standby slot filled, probed, lost, used
 *         takeover  a discovered model proposed, accepted, declined
 *         rating    a model whose requests fail (counts against its rating)
 *         proxy     the socks proxy switched, the exit address changed, keyless keys moved
 * levels: good (green), info (dim), warn (amber), bad (red)
 */

const MAX = 1000;
const buf = [];
let sink = null;

/** where new events go (the verbose view), null for none */
export const setSink = fn => (sink = fn);

export function emit(kind, text, level = 'info', data) {
  const ev = { at: Date.now(), kind, level, text: String(text).replace(/\s+/g, ' ').trim(), data };
  buf.push(ev);
  if(buf.length > MAX) buf.splice(0, buf.length - MAX);
  try {
    sink?.(ev);
  } catch(e) {}
  return ev;
}

const COLOR = { good: '74;222;128', info: '156;163;175', warn: '251;191;36', bad: '248;113;113' };
const ICON = { explore: '⌕', gateway: '⛁', quota: '◔', key: '⚿', failover: '⇄', standby: '◇', takeover: '⇧', rating: '★', proxy: '⛓' };

const clock = at => new Date(at).toTimeString().slice(0, 8);

/**
 * the exploration's lines with emoji and colour per part: the model id bold, the verdict, tools, context, the diagnosis
 * cause; `base` re-enters the line's own colour after each part
 */
let namer = () => null;

/** where a model id gets its colour from (its strength, like /model list): fn(id) -> '#rrggbb' or null */
export const setNamer = fn => (namer = fn);

function decorateExplore(text, base) {
  const hi = (code, t) => `\x1b[${code}m${t}\x1b[0m${base}`;
  const name = id => {
    const hex = namer(id);
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '');
    return m ? hi(`1;38;2;${parseInt(m[1], 16)};${parseInt(m[2], 16)};${parseInt(m[3], 16)}`, id) : hi('1;97', id);
  };
  const cause = { 'rate-limited': ['⏳', '1;33'], rate_limited: ['⏳', '1;33'], upstream: ['🔥', '1;31'], timeout: ['⌛', '1;33'], 'model-gone': ['👻', '1;31'], 'no-key': ['🔑', '1;31'], auth: ['🚫', '1;31'], limited: ['⏸️', '1;33'], flaky: ['🍃', '1;32'], unknown: ['❓', '1;35'] };

  return text
    .replace(/^worker (\d+) asks (\S+)/, (m, n, id) => `🔎 worker ${hi('1;36', n)} asks ${name(id)}`)
    .replace(/^(\S+) is usable/, (m, id) => `✅ ${name(id)} ${hi('32', 'is usable')}`)
    .replace(/^(\S+) failed/, (m, id) => `❌ ${name(id)} ${hi('31', 'failed')}`)
    .replace(/, calls tools/, `, ${hi('92', '✔ calls tools')}`)
    .replace(/, no tool calls/, `, ${hi('91', '✘ no tool calls')}`)
    .replace(/, (\d+k) context ok/, (m, k) => `, ${hi('96', `🧬 ${k} context holds`)}`)
    .replace(/, (\d+k) context failed/, (m, k) => `, ${hi('95', `💥 ${k} context lost`)}`)
    .replace(/diagnosed: ([\w-]+)/, (m, c) => `🩺 diagnosed: ${hi((cause[c] ?? ['❓', '1;35'])[1], `${(cause[c] ?? ['❓'])[0]} ${c}`)}`)
    .replace(/(\S+) is (rate_limited|\w+), resumes in (\S+ ?\S*?)(;|$)/g, (m, who, st, when, end) => `${name(who)} is ${hi('33', st)}, resumes in ${hi('1;33', `⏱ ${when}`)}${end}`)
    .replace(/^startup exploration finished: (\d+) of (\d+)/, (m, a, b) => `🏁 startup exploration finished: ${hi('1;92', a)} of ${hi('1;97', b)}`)
    .replace(/^(\d+) (likely routes|ready models) /, (m, n, w) => `🧭 ${hi('1;96', n)} ${w} `);
}

/** one event as a coloured line */
export function eventLine(ev) {
  const c = COLOR[ev.level] ?? COLOR.info;
  const base = `\x1b[38;2;${c}m`;
  const text = ev.kind === 'explore' ? decorateExplore(ev.text, base) : ev.text;
  return `\x1b[2m${clock(ev.at)}\x1b[0m ${base}${ICON[ev.kind] ?? '·'} ${ev.kind}\x1b[0m ${base}${text}\x1b[0m`;
}

/** the recent events, newest last; filter: a kind or a word of the text */
export function recent({ n = 40, filter = '' } = {}) {
  const f = filter.toLowerCase();
  return buf.filter(e => !f || e.kind === f || e.text.toLowerCase().includes(f)).slice(-n);
}

/** the /events text: the events, then how many there are per kind */
export function eventsText({ n = 40, filter = '' } = {}) {
  const evs = recent({ n, filter });
  if(!evs.length) return filter ? `(no event matches "${filter}")` : '(no event yet - the exploration, the gateway inspection and the failover report here)';

  const counts = new Map();
  for(const e of buf) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  return [...evs.map(eventLine), '', `\x1b[2m${[...counts].map(([k, v]) => `${k} ${v}`).join(' · ')} - /events [KIND|WORD] [N]\x1b[0m`].join('\n');
}

export const eventCount = () => buf.length;
