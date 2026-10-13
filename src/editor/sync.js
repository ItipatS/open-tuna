// Live team editing (client). With the studio server (tools/serve.py + tools/collab.py) every editor tab of a project
// shares ONE story: each committed edit is sent as changes (src/editor/doc.js) and everybody else's edits stream in
// through a long-poll, in the server's order (last writer wins per field). The server writes story.json and keeps
// the edit log (rewind, History tab). Presence: who else is here, their playhead and selection.
// Without a live server (serve.ps1, a static host) `live` stays false and the editor saves files as before.
import { uid } from './doc.js';
import { editorAPI } from '../project.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COLORS = ['#ff8a65', '#4fc3f7', '#aed581', '#ba68c8', '#ffd54f', '#4db6ac', '#f06292', '#9575cd', '#81c784', '#64b5f6'];
const USER_KEY = 'openTuna.user';

export function colorFor(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
export const initials = (name) => String(name || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';

export function loadUser() {
  try { const u = JSON.parse(localStorage.getItem(USER_KEY) || 'null'); if (u?.name) return { name: u.name, color: u.color || colorFor(u.name) }; } catch { /* storage unavailable */ }
  return null;
}
export function saveUser(u) { try { localStorage.setItem(USER_KEY, JSON.stringify(u)); } catch { /* storage unavailable */ } }

// field marks: a remote edit must not overwrite what my own pending / later edit sets
const marksOf = (changes) => {
  const out = [];
  for (const c of changes) {
    if (c.set) for (const f in c.set) out.push(`${c.e}|${f}`);
    else out.push(`${c.e}|`);
  }
  return out;
};

async function call(path, opts = {}) {
  const r = await fetch(editorAPI(path), { cache: 'no-store', ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
  return j;
}
const post = (path, body) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export class Sync {
  constructor(ed) {
    this.ed = ed;
    this.live = false;
    this.client = uid(10);
    this.seq = 0;
    this.epoch = '';
    this.pv = -1;
    this.queue = []; // committed edits not sent yet
    this.inflight = null;
    this.marks = new Map(); // "e|field" -> { n: pending count, seq: server seq of my latest edit of it }
    this.others = []; // presence of the other tabs
    this.online = true;
    this.lastSent = '';
    this.lastSentAt = 0;
    this.activity = null; // { user, color, label, at } the last remote edit (top bar ticker)
  }

  get pending() { return this.queue.length + (this.inflight ? 1 : 0); }

  async start() {
    const st = await call('sync/state');
    this.seq = st.seq;
    this.epoch = st.epoch;
    this.live = true;
    this.ed.adoptServer(st.text);
    this.loop();
    setInterval(() => this.hello(), 1000);
    addEventListener('pagehide', () => {
      try { navigator.sendBeacon(editorAPI('sync/presence'), new Blob([JSON.stringify({ client: this.client, bye: true })], { type: 'application/json' })); } catch { /* closing anyway */ }
    });
  }

  // one committed edit (or undo / redo) -> the server
  push(changes, label) {
    if (!this.live || !changes.length) return;
    for (const m of marksOf(changes)) { const k = this.marks.get(m) ?? { n: 0, seq: 0 }; k.n++; this.marks.set(m, k); }
    this.queue.push({ id: uid(8), changes, label });
    this.flush();
  }

  async flush() {
    if (this.inflight || !this.queue.length || this.resetting) return;
    const op = this.inflight = this.queue.shift();
    const u = this.ed.user;
    try {
      const r = await post('sync/push', { client: this.client, user: u.name, color: u.color, id: op.id, label: op.label, changes: op.changes });
      this.online = true;
      for (const m of marksOf(op.changes)) { const k = this.marks.get(m); if (k) { k.n = Math.max(0, k.n - 1); k.seq = Math.max(k.seq, r.seq); } }
      this.inflight = null;
    } catch (e) {
      this.inflight = null;
      if (e.status >= 400 && e.status < 500) { // refused: retrying won't help
        for (const m of marksOf(op.changes)) { const k = this.marks.get(m); if (k) k.n = Math.max(0, k.n - 1); }
        this.ed.toast(`The server refused an edit (${e.message}) — reloading the shared story`, true, 8000);
        this.resync();
        return;
      }
      this.online = false;
      this.queue.unshift(op);
      await sleep(2000);
    }
    this.ed.syncButtons();
    this.flush();
  }

  // a field / entity my own edits will (or did, later than `seq`) overwrite
  shadowed(mark, seq) {
    const k = this.marks.get(mark);
    return !!k && (k.n > 0 || k.seq > seq);
  }

  receive(op) {
    if (op.seq <= this.seq) return;
    this.seq = op.seq;
    if (op.client === this.client) return; // my own edit, already applied here
    const keep = [];
    for (const c of op.changes) {
      if (c.set) {
        const set = {};
        let any = false;
        for (const f in c.set) if (!this.shadowed(`${c.e}|${f}`, op.seq)) { set[f] = c.set[f]; any = true; }
        if (any) keep.push({ e: c.e, set });
      } else if (!this.shadowed(`${c.e}|`, op.seq)) keep.push(c);
    }
    if (keep.length) this.ed.applyRemote(keep, op);
    if (op.client !== 'disk') this.activity = { user: op.user, color: op.color, label: op.label, at: performance.now() };
    else this.activity = { user: 'Story file', color: '#9aa4b2', label: op.label, at: performance.now() };
  }

  async loop() {
    while (this.live) {
      try {
        const r = await call(`sync/poll?since=${this.seq}&epoch=${encodeURIComponent(this.epoch)}&pv=${this.pv}`);
        this.online = true;
        if (r.reset) { await this.resync(); continue; }
        for (const op of r.ops) this.receive(op);
        if (!r.ops.length) this.seq = Math.max(this.seq, r.seq);
        if (r.presence) { this.pv = r.pv; this.others = r.presence.filter((p) => p.client !== this.client); this.ed.renderPresence(); }
        // forget marks the stream has passed
        for (const [m, k] of this.marks) if (!k.n && k.seq <= this.seq) this.marks.delete(m);
      } catch {
        this.online = false;
        this.ed.syncButtons();
        await sleep(2500);
      }
    }
  }

  // the server restarted or its log changed under us: take its story, then re-apply what we hadn't sent
  async resync() {
    if (this.resetting) return;
    this.resetting = true;
    try {
      const st = await call('sync/state');
      const mine = [...(this.inflight ? [this.inflight] : []), ...this.queue];
      this.queue = [];
      this.inflight = null;
      this.marks.clear();
      this.seq = st.seq;
      this.epoch = st.epoch;
      this.pv = -1;
      this.ed.adoptServer(st.text, mine.flatMap((o) => o.changes));
    } catch { await sleep(2000); } finally { this.resetting = false; }
    this.flush();
  }

  // presence: sent when it changes (at most once a second) and every 5 s as a heartbeat
  hello() {
    if (!this.live) return;
    const ed = this.ed;
    const p = { client: this.client, user: ed.user.name, color: ed.user.color, t: Math.round(ed.time * 10) / 10, sel: ed.selectionKeys().slice(0, 40), view: ed.view, playing: ed.playing, preview: ed.preview ? ed.preview.label : '' };
    const s = JSON.stringify(p), now = performance.now();
    if (s === this.lastSent && now - this.lastSentAt < 5000) return;
    this.lastSent = s;
    this.lastSentAt = now;
    post('sync/presence', p).catch(() => {});
  }

  // ---- history (rewind)
  history(before) { return call(`sync/history?limit=200${before ? `&before=${before}` : ''}`); }
  at(seq) { return call(`sync/at?seq=${seq}`); }
  op(seq) { return call(`sync/op?seq=${seq}`); }
  restore(seq) { return post(`sync/restore?seq=${seq}`, { user: this.ed.user.name, color: this.ed.user.color }); }
  revert(seq) { return post(`sync/revert?seq=${seq}`, { user: this.ed.user.name, color: this.ed.user.color }); }
}
