/**
 * session-browser: the saved sessions full-screen - a list that scrolls, the highlighted row on a background, and
 * the details of that session below it. Enter or l loads the session, i inspects it (the whole conversation in the
 * pager), q goes back. Decided in doc/ARCHITECTURE.md, "Session browser".
 *
 * ```js
 * const b = new SessionBrowser({ sessions: listSavedSessions(), live, ownKey, out: std.out, readSession, onLoad: key => ..., onClose });
 * b.open();
 * b.key('\x1b[B');   // keys from the line editor, until onClose
 * ```
 *
 * The layout, the row and detail texts are plain functions (splitHeights, scrollOffset, rowText, detailLines,
 * transcriptText) so they are tested without a terminal.
 */
import { pad, stringWidth, truncate, ttyWrite, windowSize } from 'terminal';
import * as terminal from 'terminal';
import { Pager } from './pager.js';

const syncWrite = terminal.syncOutput ?? ttyWrite;
const CSI = '\x1b[';
const goto = row => `${CSI}${row};1H`;
const CUR = `${CSI}48;2;30;64;60m`;

/** "5s", "3m", "2h", "12d" */
export const ageText = ms => (ms < 90e3 ? `${Math.round(ms / 1e3)}s` : ms < 90 * 60e3 ? `${Math.round(ms / 60e3)}m` : ms < 36 * 3600e3 ? `${Math.round(ms / 3600e3)}h` : `${Math.round(ms / 86400e3)}d`);

const plain = s => String(s ?? '').replace(/\x1b\[[0-9;]*m/g, '');
const oneLine = s => String(s ?? '').replace(/\s+/g, ' ').trim();

/** rows of the screen -> { list, detail }: header, rule and key line take 3, the list gets about 45% (3 at least), the details at least 6 */
export function splitHeights(rows) {
  const avail = Math.max(2, rows - 3);
  let list = Math.max(3, Math.floor(avail * 0.45));
  if(avail - list < 6) list = Math.max(3, avail - 6);
  return { list, detail: Math.max(0, avail - list) };
}

/** the first row of a window of `height` rows that keeps `cursor` in it, from the current `offset` over `n` rows */
export function scrollOffset(cursor, offset, height, n) {
  let o = offset;
  if(cursor < o) o = cursor;
  if(cursor >= o + height) o = cursor - height + 1;
  return Math.max(0, Math.min(o, Math.max(0, n - height)));
}

/** column widths for `cols` terminal columns: the project and the model go first when the title would get too little */
export function columnWidths(cols, sessions) {
  const w = { key: Math.min(26, Math.max(4, ...sessions.map(s => s.key.length + 0))), age: 4, msgs: 5, model: 22, project: 30 };
  const fixed = () => 2 + w.key + 1 + w.age + 1 + w.msgs + 1 + (w.model ? w.model + 1 : 0) + (w.project ? w.project + 1 : 0);
  if(cols - fixed() < 14) w.project = 0;
  if(cols - fixed() < 14) w.model = 0;
  if(cols - fixed() < 8) w.key = Math.max(8, w.key - (8 - (cols - fixed())));
  w.title = Math.max(0, cols - 1 - fixed());
  return w;
}

const cut = (s, n) => (n <= 0 ? '' : pad(truncate(plain(s), n), n));

/**
 * the plain text of a list row: marker, key, age, messages, model, project, title
 * @param {object} s     a listSavedSessions() entry
 * @param {{key:number,age:number,msgs:number,model:number,project:number,title:number}} w
 * @param {{marker?: string, now?: number, home?: string}} [o]
 */
export function rowText(s, w, { marker = ' ', now = Date.now(), home = '' } = {}) {
  const project = (s.root ?? '').replace(home && s.root?.startsWith(home) ? home : '\0', '~');
  return [
    marker,
    cut(s.key, w.key),
    cut(ageText(now - s.at), w.age),
    cut(s.messages ?? '-', w.msgs),
    w.model ? cut(s.model ?? '-', w.model) : null,
    w.project ? cut(project || '-', w.project) : null,
    cut(s.title ?? '', w.title),
  ]
    .filter(x => x !== null)
    .join(' ');
}

const SETTING_ORDER = ['mode', 'stream', 'think', 'temperature', 'numCtx', 'maxRounds', 'scan', 'verbose', 'fallbackModel'];

/** the two first lines of a message's text, one line each */
const peek = (m, n = 2) =>
  oneLine(typeof m?.content === 'string' ? m.content : '')
    ? String(m.content)
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .slice(0, n)
    : [];

/**
 * the lines of the details pane for one session (without colour, cut to `cols` by the caller)
 * @param {{key:string,at:number,messages?:number,model?:string,root?:string,title?:string,name?:string}} s
 * @param {{state?:object,size?:number,updatedAt?:number,big?:boolean,messages?:object[]|null}} info  readSession()
 * @param {{ownKey?:string, live?:{pid:number,name?:string}|null, now?:number, home?:string}} [ctx]
 */
export function detailLines(s, info, { ownKey, live, now = Date.now(), home = '' } = {}) {
  const st = info?.state ?? {};
  const row = (k, v) => (v === undefined || v === null || v === '' ? null : `${k.padEnd(9)} ${v}`);
  const short = d => (home && d.startsWith(home) ? `~${d.slice(home.length)}` : d);
  const state = s.key === ownKey ? 'this session' : live ? `running in pid ${live.pid}${live.name ? ` (${live.name})` : ''}` : 'saved';
  const root = (st.root ?? s.root ?? '').replace(home && (st.root ?? s.root ?? '').startsWith(home) ? home : '\0', '~');
  const msgs = info?.messages;
  const lastUser = msgs ? [...msgs].reverse().find(m => m.role === 'user' && typeof m.content === 'string' && !m.content.startsWith('(automatic project scan')) : null;
  const lastReply = msgs ? [...msgs].reverse().find(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) : null;
  const settings = SETTING_ORDER.filter(k => st.settings?.[k] !== undefined).map(k => `${k}=${st.settings[k]}`);
  const when = info?.updatedAt ?? s.at;
  const size = info?.size ? `${info.size >= 1048576 ? `${(info.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(info.size / 1024))} KB`}` : '';

  const lines = [
    row('session', `${s.key}${st.name && st.name !== s.key ? `  (name ${st.name})` : ''}  -  ${state}`),
    row('project', root),
    st.startRoot && st.startRoot !== (st.root ?? s.root) ? row('started', short(st.startRoot)) : null,
    (st.roots?.length ?? 0) > 1 ? row('moves', `${st.roots.length - 1} directory change${st.roots.length > 2 ? 's' : ''}: ${st.roots.slice(-4).map(r => short(r.root)).join(' > ')}`) : null,
    row('model', [st.provider, st.model ?? s.model].filter(Boolean).join('/')),
    row('messages', `${st.messages ?? s.messages ?? '-'}${size ? `  (session.json ${size}${info.big ? ', too big to read here' : ''})` : ''}`),
    row('updated', `${new Date(when).toISOString().replace('T', ' ').slice(0, 16)}  (${ageText(now - when)} ago)`),
    row('settings', settings.join('  ')),
    row('title', oneLine(st.title ?? s.title)),
  ];
  if(msgs && !msgs.length) lines.push(row('history', '(empty conversation)'));
  if(lastUser) peek(lastUser).forEach((l, i) => lines.push(`${i ? ' '.repeat(10) : 'last you  '} ${l}`));
  if(lastReply) peek(lastReply).forEach((l, i) => lines.push(`${i ? ' '.repeat(10) : 'last model'} ${l}`));
  if(!msgs && info && !info.big && info.size) lines.push(row('history', '(session.json cannot be read)'));
  return lines.filter(l => l !== null);
}

const CUT = 2000;

/** the whole conversation as text for the pager: a header per message, long ones cut, tool calls on one line */
export function transcriptText(messages) {
  if(!messages?.length) return '(no conversation saved)';

  return messages
    .map((m, i) => {
      const text = typeof m.content === 'string' ? m.content : m.content === undefined ? '' : JSON.stringify(m.content);
      const body = text.length > CUT ? `${text.slice(0, CUT)}\n[... ${text.length - CUT} more characters]` : text;
      const calls = Array.isArray(m.toolCalls) && m.toolCalls.length ? `\n(calls: ${m.toolCalls.map(c => `${c.name}(${JSON.stringify(c.args ?? {}).slice(0, 80)})`).join(', ')})` : '';
      return `${CSI}1m#${i + 1} ${m.role}${m.name ? ` ${m.name}` : ''}${CSI}0m\n${body}${calls}`;
    })
    .join('\n\n');
}

export class SessionBrowser {
  #out;
  #inner = null;
  #open = false;
  #cache = new Map();
  cols = 80;
  rows = 24;
  cursor = 0;
  offset = 0;
  note = '';

  /**
   * @param {object} o
   * @param {object[]} o.sessions            listSavedSessions()
   * @param {(key: string) => {pid:number,name?:string}|null} [o.live]  the process running a session, if one does
   * @param {string} [o.ownKey]              the session of this process
   * @param {FILE} o.out
   * @param {(key: string) => object} o.readSession
   * @param {(key: string) => void} o.onLoad called after the browser closed
   * @param {() => void} [o.onClose]
   * @param {(cols: number, label: string) => string} [o.header]
   * @param {boolean} [o.sync]
   * @param {string} [o.home]
   */
  constructor({ sessions, live = () => null, ownKey, out, readSession, onLoad, onClose, header, sync = false, home = '' }) {
    this.sessions = sessions;
    this.live = live;
    this.ownKey = ownKey;
    this.#out = out;
    this.readSession = readSession;
    this.onLoad = onLoad;
    this.onClose = onClose;
    this.sync = sync;
    this.home = home;
    this.header = header ?? ((cols, label) => `${CSI}7m${pad(` ${label}`, cols)}${CSI}0m`);
  }

  get isOpen() {
    return this.#open;
  }

  get current() {
    return this.sessions[this.cursor] ?? null;
  }

  open() {
    this.#open = true;
    ttyWrite(this.#out, `${CSI}?1049h${CSI}?1007h${CSI}?25l`);
    this.resize();
    return this;
  }

  resize() {
    [this.cols, this.rows] = windowSize(this.#out);
    this.#inner?.resize();
    if(!this.#inner) this.draw();
  }

  #info(s) {
    if(!this.#cache.has(s.key)) this.#cache.set(s.key, this.readSession(s.key));
    return this.#cache.get(s.key);
  }

  #move(to) {
    this.cursor = Math.max(0, Math.min(this.sessions.length - 1, to));
    this.note = '';
  }

  draw() {
    const { list, detail } = splitHeights(this.rows);
    const n = this.sessions.length;
    const w = columnWidths(this.cols, this.sessions);
    this.offset = scrollOffset(this.cursor, this.offset, list, n);
    const now = Date.now();
    let out = goto(1) + `${CSI}2K${this.header(this.cols, truncate(`sessions - ${n} saved`, this.cols - 4))}`;

    for(let k = 0; k < list; k++) {
      const i = this.offset + k;
      const s = this.sessions[i];
      let line = '';

      if(s) {
        const live = this.live(s.key);
        const marker = s.key === this.ownKey ? '*' : live ? '●' : ' ';
        const text = rowText(s, w, { marker, now, home: this.home });
        const colored = marker === '*' ? `${CSI}1;32m${text[0]}${CSI}0m${text.slice(1)}` : marker === '●' ? `${CSI}33m${text[0]}${CSI}0m${text.slice(1)}` : text;
        line = i === this.cursor ? `${CUR}${colored.replace(/\x1b\[0m/g, `${CSI}0m${CUR}`)}${' '.repeat(Math.max(0, this.cols - 1 - stringWidth(text)))}${CSI}0m` : colored;
      }

      out += `${goto(2 + k)}${CSI}2K${line}`;
    }

    out += `${goto(2 + list)}${CSI}2K${CSI}2m${'─'.repeat(Math.max(0, this.cols - 1))}${CSI}0m`;

    const cur = this.current;
    const lines = cur ? detailLines(cur, this.#info(cur), { ownKey: this.ownKey, live: this.live(cur.key), now, home: this.home }) : ['(no saved sessions)'];

    for(let k = 0; k < detail; k++) {
      const l = lines[k];
      const shown = l === undefined ? '' : `${CSI}2m${l.slice(0, 10)}${CSI}0m${l.slice(10)}`;
      out += `${goto(3 + list + k)}${CSI}2K ${truncate(shown, this.cols - 2)}`;
    }

    const keys = this.note ? `${CSI}33m${this.note}${CSI}0m` : `${CSI}2m ↑↓ PgUp PgDn Home End · Enter/l load · i inspect · q back${CSI}0m`;
    out += `${goto(this.rows)}${CSI}2K${truncate(keys, this.cols)}`;
    (this.sync ? syncWrite : ttyWrite)(this.#out, out);
  }

  #load() {
    const s = this.current;
    if(!s) return;

    if(s.key === this.ownKey) return void (this.note = ' this is the session that is open now');

    const live = this.live(s.key);
    if(live) return void (this.note = ` running in pid ${live.pid}${live.name ? ` (${live.name})` : ''}: talk to it with ollama-repl-ctl -s ${live.name ?? s.key}`);

    this.close();
    this.onLoad?.(s.key);
  }

  #inspect() {
    const s = this.current;
    if(!s) return;

    const info = this.#info(s);
    this.#inner = new Pager({
      title: `session ${s.key} - ${info.messages?.length ?? 0} messages`,
      text: transcriptText(info.messages),
      out: this.#out,
      sync: this.sync,
      header: this.header,
      onClose: () => {
        this.#inner = null;
        if(!this.#open) return;
        /* the pager left the alternate screen: back in, and draw the browser again */
        ttyWrite(this.#out, `${CSI}?1049h${CSI}?1007h${CSI}?25l`);
        this.resize();
      },
    }).open();
  }

  /** one key from the line editor; returns false once the browser closed */
  key(keys) {
    if(this.#inner) {
      this.#inner.key(keys);
      return true;
    }

    const page = Math.max(1, splitHeights(this.rows).list - 1);

    if(keys === '\x03' || keys === 'q' || keys === 'Q' || keys === '\x1b\x1b') return this.close(), false;

    if(keys === '\x1b[A' || keys === 'k') this.#move(this.cursor - 1);
    else if(keys === '\x1b[B' || keys === 'j') this.#move(this.cursor + 1);
    else if(keys === '\x1b[5~' || keys === 'b') this.#move(this.cursor - page);
    else if(keys === '\x1b[6~' || keys === ' ') this.#move(this.cursor + page);
    else if(keys === '\x1b[H' || keys === '\x1b[1~' || keys === 'g') this.#move(0);
    else if(keys === '\x1b[F' || keys === '\x1b[4~' || keys === 'G') this.#move(this.sessions.length - 1);
    else if(keys === '\r' || keys === 'l') this.#load();
    else if(keys === 'i') this.#inspect();
    else return true;

    if(this.#open && !this.#inner) this.draw();
    return this.#open;
  }

  close() {
    if(!this.#open) return;

    this.#open = false;
    this.#inner?.close();
    this.#inner = null;
    ttyWrite(this.#out, `${CSI}?1007l${CSI}?25h${CSI}?1049l`);
    this.onClose?.();
  }
}
