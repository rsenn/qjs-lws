/**
 * net-activity: the HTTP requests this process has in flight or just
 * finished, for the network pane (lib/tui/net-pane.js). OpenAI clients report
 * their phases (client.onPhase); other clients (a local Ollama, Gemini) are
 * wrapped, their chat()/chatStream() calls become requests too.
 *
 * ```js
 * const net = new NetActivity();
 * client.onPhase = (name, meta) => net.phase('main', name, meta);
 * net.wrap(ollamaClient, 'local');
 * net.records   // [{ label, meta, phase, t0, done, endedAt }, ...] oldest first
 * ```
 */
const KEEP = 24;

/**
 * what a request is about, for the network pane: the file or document a condensing call is given ("file README.md"),
 * else the first line of the last user message
 */
export function subjectOf(messages) {
  const u = [...(messages ?? [])].reverse().find(m => m.role === 'user');
  const t = typeof u?.content === 'string' ? u.content : '';
  const c = /^Condense this (.+?) to at most/s.exec(t);
  return (c ? c[1] : (t.split('\n').find(l => l.trim()) ?? '').trim()).replace(/\s+/g, ' ').slice(0, 120);
}

export class NetActivity {
  records = [];

  /** a client's phase change; `meta` is the request's metadata object, the same one through all its phases */
  phase(label, name, meta) {
    let r = this.records.find(r => r.meta === meta);

    if(!r) {
      r = { label, meta, t0: meta.t0 ?? Date.now(), done: false };
      this.records.push(r);
      if(this.records.length > KEEP) this.records.splice(0, this.records.length - KEEP);
    }

    r.phase = name;
    if(name === 'idle') {
      r.done = true;
      r.endedAt = Date.now();
    }
  }

  /** requests still running */
  get active() {
    return this.records.filter(r => !r.done);
  }

  /** makes a client without onPhase report: its chat() and chatStream() calls are tracked as requests */
  wrap(client, label) {
    const url = client.baseUrl ?? `http://${client.host}:${client.port}`;
    const text = m => (typeof m?.content === 'string' ? m.content : '');

    for(const method of ['chat', 'chatStream']) {
      const orig = client[method]?.bind(client);
      if(!orig) continue;

      client[method] = async (messages, options, onToken) => {
        const meta = { requested: client.model, t0: Date.now(), url, subject: subjectOf(messages), request: text([...(messages ?? [])].reverse().find(m => m.role === 'user')).slice(-200), bytesIn: 0, bytesOut: 0, chunks: 0, stream: method === 'chatStream', tail: '' };
        meta.bytesOut = JSON.stringify(messages ?? []).length;
        this.phase(label, 'waiting', meta);

        const tap = onToken && (t => {
          if(meta.chunks === 0) this.phase(label, 'streaming', meta);
          meta.chunks++;
          meta.bytesIn += String(t).length;
          meta.tail = (meta.tail + t).slice(-160);
          return onToken(t);
        });

        try {
          const r = await (method === 'chatStream' ? orig(messages, options, tap) : orig(messages, options));
          if(method === 'chat') {
            meta.bytesIn = String(r?.content ?? '').length;
            meta.tail = String(r?.content ?? '').slice(-160);
          }
          return r;
        } catch(e) {
          meta.error = String(e.message ?? e).split('\n')[0].slice(0, 120);
          throw e;
        } finally {
          meta.ms = Date.now() - meta.t0;
          this.phase(label, 'idle', meta);
        }
      };
    }
  }
}
