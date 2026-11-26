/**
 * gateway-report: which providers of a freellmapi gateway answer and still
 * have models that are not exhausted - the probe printed at startup and by
 * `/gateway status`.
 *
 * ```js
 * const r = await gatewayReport(gateway, availability);
 * console.log(reportText(r, tui.width));
 * ```
 */
import { stripAnsi } from 'terminal';
import { piped } from '../ansi.js';
import { untilText } from './availability.js';

/** glyph and colour per provider state */
const STATE = { ok: ['●', '38;2;74;222;128'], limited: ['◐', '38;2;251;191;36'], spent: ['⊘', '38;2;251;146;60'], invalid: ['✗', '31'], unknown: ['○', '90'] };

/**
 * Asks the gateway for its providers (health, keys) and, with availability
 * data, counts per provider the model rows that can serve a request now.
 *
 * @param {object} gateway  a Gateway (lib/gateway/freellm.js)
 * @param {object|null} availability  loadAvailability() result, null without a dashboard session
 * @returns {Promise<{counts: object, rows: object[], detailed: boolean}>}
 */
export async function gatewayReport(gateway, availability = null) {
  const { providers = [], counts = {} } = await gateway.providers();
  const ready = new Map();
  const total = new Map();
  const now = Date.now();

  /* byRow is keyed "platform/modelId"; a row with no block can serve */
  for(const [k, blocks] of availability?.byRow ?? []) {
    const p = k.slice(0, k.indexOf('/'));
    total.set(p, (total.get(p) ?? 0) + 1);
    if(!blocks.length) ready.set(p, (ready.get(p) ?? 0) + 1);
  }

  const rows = providers
    .filter(p => p.keys > 0 || p.status !== 'unknown')
    .map(p => {
      const t = total.get(p.platform) ?? 0;
      const r = ready.get(p.platform) ?? 0;
      const state = p.status === 'healthy' ? (availability && t === 0 ? 'unknown' : availability && r === 0 ? 'spent' : 'ok') : p.status === 'rate_limited' ? 'limited' : p.status === 'invalid' ? 'invalid' : 'unknown';
      const resume = p.resume_at ? untilText(Date.parse(p.resume_at), now) : '';
      return { platform: p.platform, name: p.platform, status: p.status, state, keys: p.keys, ready: r, total: t, resume, error: p.last_error ?? '' };
    });

  return { counts, rows, detailed: !!availability };
}

/** words wrapped to `cols` visible columns, joined by two spaces */
function flow(words, cols, indent) {
  const lines = [];
  let line = '';
  for(const w of words) {
    const wl = stripAnsi(w).length;
    if(line && stripAnsi(line).length + 2 + wl > cols - indent) lines.push(line), (line = w);
    else line = line ? `${line}  ${w}` : w;
  }
  if(line) lines.push(line);
  return lines.join(`\n${' '.repeat(indent)}`);
}

/**
 * the report as text: a headline with the counts, then one coloured entry per
 * provider (● healthy, ◐ rate limited, ⊘ healthy but every model exhausted,
 * ✗ invalid key, ○ unknown), with ready/total model rows when known.
 *
 * @param {{counts: object, rows: object[], detailed: boolean}} report
 * @param {number} [cols]  width to wrap at, 0 for none
 */
export function reportText(report, cols = 100) {
  const { counts, rows, detailed } = report;
  const paint = (state, s) => (piped ? s : `\x1b[${STATE[state][1]}m${s}\x1b[39m`);
  const glyph = state => paint(state, STATE[state][0]);

  const ok = rows.filter(r => r.state === 'ok');
  const usable = ok.reduce((n, r) => n + r.ready, 0);
  const head = [
    paint('ok', `${counts.healthy ?? ok.length} healthy`),
    counts.rate_limited ? paint('limited', `${counts.rate_limited} rate limited`) : '',
    counts.invalid ? paint('invalid', `${counts.invalid} invalid`) : '',
    detailed && rows.some(r => r.state === 'spent') ? paint('spent', `${rows.filter(r => r.state === 'spent').length} exhausted`) : '',
  ].filter(Boolean);

  const entry = r => {
    const n = detailed && r.total ? ` ${r.ready}/${r.total}` : '';
    const extra = r.state === 'limited' && r.resume ? ` ${r.resume}` : r.state === 'invalid' ? ' bad key' : '';
    return `${glyph(r.state)} ${r.state === 'unknown' ? paint('unknown', r.name) : r.name}${paint(r.state === 'ok' ? 'unknown' : r.state, n + extra)}`;
  };

  const order = ['ok', 'spent', 'limited', 'invalid', 'unknown'];
  const sorted = [...rows].sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state) || b.ready - a.ready || a.name.localeCompare(b.name));
  const title = piped ? 'gateway providers' : `\x1b[1;38;2;45;212;191m⛁ gateway providers\x1b[0m`;
  const tail = detailed ? `${usable} model rows can serve now` : 'no dashboard session (/gateway login): model rows are not counted, only the monthly totals are known (/gateway usage); without the per-model limits and daily windows a failing provider is skipped from the error\'s attempt trail alone';

  return [`${title}  ${head.join(' · ')}`, `  ${flow(sorted.map(entry), cols || 100, 2)}`, piped ? `  ${tail}` : `  \x1b[2m${tail}\x1b[0m`].join('\n');
}
