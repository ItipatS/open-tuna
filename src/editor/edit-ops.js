// Bulk editing on the selection — mixed into Editor (editor.js), so `this` is the editor.
//   clipboard   copy / cut / paste several items at once, keeping their timing relative to each other; whole tracks,
//               lanes and groups too. Pasting between projects copies the media files along. The clipboard is also
//               put on the system clipboard as JSON (paste into another studio tab or computer).
//   paste special   at the original times · into the selected track · values onto the selection (keeps their times)
//   duplicate · Alt-drag copies (cloneSelection) · delete · nudge (Alt+← →) · split at the playhead (S)
//   stretch timing · align to the playhead · distribute evenly · close gaps · select all / after playhead / in range
//   In / Out range (I / O) + loop playback · insert time / delete the In–Out range from the whole story (ripple)
//   track colours
import { h } from './dom.js';
import { dialog } from './menu.js';
import { BAR } from './timeline-view.js';
import { evalKeys, hermite, fmtTime } from '../timeline.js';
import { uid } from './doc.js';
import { PROJECT, editorAPI } from '../project.js';

const CLIP_KEY = 'openTuna.clipboard.v2';
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const clone = (o) => structuredClone(o);
export const TRACK_COLORS = { Red: '#ff6b6b', Orange: '#ff9f43', Yellow: '#ffd166', Green: '#5fd4a0', Teal: '#4ecdc4', Blue: '#4fb8ff', Purple: '#b49cff', Pink: '#f78fb3', Grey: '#9aa4b2' };

// a copy without identity: no id, no lock
function fresh(o) {
  const c = clone(o);
  delete c.id; delete c.locked;
  return c;
}

// start time of a clipboard entry
const startOf = (o) => (typeof o.t === 'number' ? o.t : typeof o.a === 'number' ? o.a : o.keys?.length ? Math.min(...o.keys.map((k) => k.t)) : o.clips?.length ? Math.min(...o.clips.map((c) => c.a)) : Infinity);

// old single-item clipboards (v2) -> v3
function normalize(c) {
  if (!c) return null;
  if (c.v === 3) return c;
  if (c.kind && c.item) return { app: 'open-tuna', v: 3, t0: c.item.t ?? c.item.a ?? 0, items: [{ kind: c.kind, track: c.type ? { id: c.layer, type: c.type, bind: c.bind, space: c.space } : null, item: c.item }], tracks: [] };
  return null;
}

function shiftTrack(t, off) {
  if (typeof t.a === 'number') t.a = r4(t.a + off);
  if (typeof t.b === 'number') t.b = r4(t.b + off);
  for (const k of t.keys ?? []) k.t = r4(k.t + off);
  for (const c of t.clips ?? []) { c.a = r4(c.a + off); c.b = r4(c.b + off); }
  return t;
}

export const editOps = {
  // ------------------------------------------------------------------ what the selection covers in time
  // [{ s, obj, pt (a point: .t) | span (.a .b), keys (a layer / path clip's keys move with it) }]
  timedSelection(sels = this.sels) {
    const out = [];
    const bars = new Set(sels.filter((s) => s.kind === 'track' && BAR.has(s.track.type)).map((s) => s.track));
    for (const s of sels) {
      if (s.kind === 'key') { if (!bars.has(s.track)) out.push({ s, obj: s.item, pt: true }); } else if (s.kind === 'chapter' || s.kind === 'note') out.push({ s, obj: s.item, pt: true });
      else if (s.kind === 'clip') out.push({ s, obj: s.item });
      else if (s.kind === 'track' && typeof s.track.a === 'number' && typeof s.track.b === 'number') out.push({ s, obj: s.track, keys: BAR.has(s.track.type) ? s.track.keys : null });
    }
    return out;
  },

  selSpan(items = this.timedSelection()) {
    let a = Infinity, b = -Infinity;
    for (const it of items) { a = Math.min(a, it.pt ? it.obj.t : it.obj.a); b = Math.max(b, it.pt ? it.obj.t : it.obj.b); }
    return items.length ? { a, b } : null;
  },

  // ------------------------------------------------------------------ copies in place (Alt-drag)
  copyTrack(t, label) {
    const c = fresh(t);
    c.id = `${t.type}-${uid()}`;
    c.label = label ?? `${t.label || t.type} copy`;
    for (const k of c.keys ?? []) { delete k.id; delete k.locked; }
    for (const k of c.clips ?? []) { delete k.id; delete k.locked; }
    return c;
  },

  // copies of the selected items right on top of the originals -> [[original sel, copy sel]] (not committed)
  cloneSelection() {
    const d = this.tl.data, pairs = [];
    for (const s of this.sels) {
      if (s.kind === 'key') { const c = fresh(s.item); s.track.keys.push(c); pairs.push([s, { kind: 'key', track: s.track, item: c }]); } else if (s.kind === 'clip') { const c = fresh(s.item); s.track.clips.push(c); pairs.push([s, { kind: 'clip', track: s.track, item: c }]); } else if (s.kind === 'chapter' || s.kind === 'note') {
        const c = fresh(s.item);
        d[s.kind === 'chapter' ? 'chapters' : 'notes'].push(c);
        pairs.push([s, { kind: s.kind, item: c }]);
      } else if (s.kind === 'track' && (BAR.has(s.track.type) || s.track.type === 'stretch')) {
        const c = this.copyTrack(s.track);
        d.tracks.splice(d.tracks.indexOf(s.track) + 1, 0, c);
        pairs.push([s, { kind: 'track', track: c }]);
      }
    }
    if (!pairs.length) this.toast('Nothing here can be copied by dragging (a clip track drives one thing — copy its keys instead)', true);
    this.changed();
    return pairs;
  },

  uncloneSelection(pairs) {
    const d = this.tl.data;
    const drop = (arr, x) => { const i = arr?.indexOf(x) ?? -1; if (i >= 0) arr.splice(i, 1); };
    for (const [, c] of pairs) {
      if (c.kind === 'key') drop(c.track.keys, c.item);
      else if (c.kind === 'clip') drop(c.track.clips, c.item);
      else if (c.kind === 'chapter') drop(d.chapters, c.item);
      else if (c.kind === 'note') drop(d.notes, c.item);
      else if (c.kind === 'track') drop(d.tracks, c.track);
    }
    this.changed();
    this.selectMany(pairs.map((p) => p[0]));
  },

  // ------------------------------------------------------------------ delete
  deleteSelection() {
    const s = this.sel, d = this.tl.data;
    if (!s || s.kind === 'object' || !this.guard()) return;
    const list = this.multi ? this.sels.filter((q) => q.kind !== 'object') : [s];
    if (list.length === 1 && s.kind === 'track' && (s.track.type === 'group' || s.track.type === 'lane')) return this.removeContainer(s.track, s.track.type === 'lane');
    const gone = new Set();
    for (const q of list) {
      if (q.kind === 'track') {
        const set = q.track.type === 'lane' ? this.timeline.contents(q.track) : [q.track];
        for (const t of set) if (t.keys?.some((k) => k.locked) || t.clips?.some((c) => c.locked)) return this.toast(`“${t.label || t.id}” has locked items — unlock them first`, true);
      }
    }
    const drop = (arr, it) => { const i = arr.indexOf(it); if (i >= 0) arr.splice(i, 1); };
    let n = 0;
    for (const q of list) {
      if (q.kind === 'key') drop(q.track.keys, q.item);
      else if (q.kind === 'clip') drop(q.track.clips, q.item);
      else if (q.kind === 'chapter') drop(d.chapters, q.item);
      else if (q.kind === 'note') drop(d.notes, q.item);
      else if (q.kind === 'track') {
        if (q.track.type === 'group') { for (const t of d.tracks) if (t.parent === q.track.id) delete t.parent; gone.add(q.track); } else for (const t of q.track.type === 'lane' ? this.timeline.contents(q.track) : [q.track]) gone.add(t);
      }
      n++;
    }
    if (gone.size) d.tracks = d.tracks.filter((t) => !gone.has(t));
    const back = !this.multi && (s.kind === 'key' || s.kind === 'clip') ? { kind: 'track', track: s.track } : null;
    this.tl.changed();
    this.commit(n > 1 ? `Deleted ${n} items` : undefined);
    this.select(back);
    this.toast(`Deleted${n > 1 ? ` ${n} items` : ''} — ${this.mod}Z to undo`);
  },

  // ------------------------------------------------------------------ clipboard
  copyable(s) { return !!s && s.kind !== 'object'; },

  // the selection as a clipboard (v3): items keep their times relative to the earliest one
  clipboardOf(list) {
    const items = [], tracks = [];
    const ref = (t) => ({ id: t.id, type: t.type, bind: t.bind, space: t.space, label: t.label });
    const whole = new Set();
    for (const s of list) {
      if (s.kind !== 'track') continue;
      const set = s.track.type === 'group' || s.track.type === 'lane' ? [s.track, ...this.timeline.contents(s.track)] : [s.track];
      for (const t of set) if (!whole.has(t)) { whole.add(t); tracks.push({ ...fresh(t), id: t.id }); }
    }
    for (const t of tracks) { for (const k of t.keys ?? []) { delete k.locked; } for (const k of t.clips ?? []) { delete k.locked; } }
    for (const s of list) {
      if (s.kind === 'track' || s.kind === 'object' || (s.track && whole.has(s.track))) continue;
      items.push({ kind: s.kind, track: s.track ? ref(s.track) : null, item: fresh(s.item) });
    }
    const starts = [...items.map((i) => startOf(i.item)), ...tracks.map(startOf)].filter(Number.isFinite);
    return { app: 'open-tuna', v: 3, project: PROJECT, t0: starts.length ? Math.min(...starts) : 0, items, tracks };
  },

  setClipboard(c) {
    this.clipboard = c;
    try { localStorage.setItem(CLIP_KEY, JSON.stringify(c)); } catch { /* storage unavailable */ }
  },

  copy(e) {
    const list = (this.multi ? this.sels : [this.sel]).filter((s) => this.copyable(s));
    if (!list.length) return false;
    const c = this.clipboardOf(list);
    this.setClipboard(c);
    const text = JSON.stringify(c);
    if (e?.clipboardData) e.clipboardData.setData('text/plain', text);
    else navigator.clipboard?.writeText(text).catch(() => {});
    const n = c.items.length + c.tracks.length;
    this.toast(`Copied ${n === 1 ? this.describe(list[0]) : `${n} items`}`);
    return true;
  },

  cut(e) {
    if (!this.copyable(this.sel) || !this.guard()) return;
    if (this.copy(e)) this.deleteSelection();
  },

  // the clipboard -> the story, starting at the playhead (`at`), or at the original times. `into`: the track keys go to
  async paste(into, { at, original = false, clip = this.clipboard, label } = {}) {
    const c = normalize(clip);
    if (!c) return this.toast('Nothing to paste — copy something first', true);
    const d = this.tl.data, tracks = d.tracks;
    const off = original ? 0 : r4((at ?? this.time) - c.t0);
    const made = [];
    let skipped = 0;
    // media from another project comes along
    let srcMap = null;
    if (c.project !== undefined && c.project !== PROJECT) srcMap = await this.importAssets(c);
    const fix = (o) => (srcMap?.size ? JSON.parse(JSON.stringify(o).replace(/assets\/[^"'\s)<>]+/g, (m) => srcMap.get(m) ?? m)) : o);
    // whole tracks: new ids (lanes / groups keep their members), or merged into the one track of their kind
    const idMap = new Map();
    for (const t of c.tracks) if (!['camera', 'captions'].includes(t.type) && !((t.type === 'curve' || t.type === 'clip') && this.tl.bound.get(t.bind))) idMap.set(t.id, `${t.type}-${uid()}`);
    for (const src of c.tracks) {
      const T = fix(shiftTrack(clone(src), off));
      for (const k of T.keys ?? []) delete k.id;
      for (const k of T.clips ?? []) delete k.id;
      const merge = src.type === 'camera' ? tracks.find((q) => q.type === 'camera')
        : src.type === 'captions' ? this.captionsTrack()
          : src.type === 'curve' || src.type === 'clip' ? this.tl.bound.get(src.bind) : null;
      if (merge) {
        if (this.tl.lockedTrack(merge)) { skipped++; continue; }
        if (T.keys) { merge.keys = merge.keys.filter((k) => k.locked || !T.keys.some((q) => Math.abs(q.t - k.t) < 1e-3)); merge.keys.push(...T.keys); }
        if (T.clips) merge.clips.push(...T.clips);
        if (src.type === 'clip') { merge.a = T.a; merge.b = T.b; }
        made.push({ kind: 'track', track: merge });
        continue;
      }
      T.id = idMap.get(src.id);
      if (T.parent) T.parent = idMap.get(T.parent) ?? (this.tl.byId.get(T.parent) ? T.parent : undefined);
      if (T.lane) T.lane = idMap.get(T.lane) ?? (this.tl.byId.get(T.lane)?.type === 'lane' ? T.lane : undefined);
      if (!T.parent) delete T.parent;
      if (!T.lane) delete T.lane;
      if (tracks.some((q) => q.label === T.label)) T.label = `${T.label} copy`;
      const after = tracks.findIndex((q) => q.id === src.id);
      tracks.splice(after >= 0 ? after + 1 : tracks.length, 0, T);
      made.push({ kind: 'track', track: T });
    }
    // single items: keys to a matching track (the given one, the same one, the selected one, any that fits)
    const fits = (ref) => (t) => t && t.type === ref.type && (!['curve', 'path'].includes(ref.type) || t.bind === ref.bind) && (ref.type !== 'layer' || (t.space ?? 'screen') === (ref.space ?? 'screen'));
    for (const it of c.items) {
      const o = fix(clone(it.item));
      delete o.id;
      if (it.kind === 'key') {
        const f = fits(it.track);
        const t = [into, tracks.find((q) => q.id === it.track.id), this.sel?.track].find(f) ?? tracks.find(f);
        if (!t || this.tl.lockedTrack(t)) { skipped++; continue; }
        o.t = r4(o.t + off);
        t.keys = t.keys.filter((k) => Math.abs(k.t - o.t) > 1e-3 || k.locked);
        t.keys.push(o);
        made.push({ kind: 'key', track: t, item: o });
      } else if (it.kind === 'clip') {
        const t = this.captionsTrack();
        if (this.tl.lockedTrack(t)) { skipped++; continue; }
        o.a = r4(o.a + off); o.b = r4(o.b + off);
        t.clips.push(o);
        made.push({ kind: 'clip', track: t, item: o });
      } else if (it.kind === 'chapter' || it.kind === 'note') {
        o.t = r4(o.t + off);
        d[it.kind === 'chapter' ? 'chapters' : 'notes'].push(o);
        made.push({ kind: it.kind, item: o });
      }
    }
    if (!made.length) return this.toast(skipped ? 'Nothing pasted — the tracks it goes to are locked (or there is no matching track)' : 'Nothing to paste', true);
    // past the end: the story gets longer
    let end = 0;
    for (const m of made) { const o = m.item ?? m.track; end = Math.max(end, o.b ?? o.t ?? 0, ...(o.keys ?? []).map((k) => k.t)); }
    if (end > this.duration) this.tl.meta.duration = Math.ceil(end + 1);
    this.tl.changed();
    this.commit(label ?? `Pasted ${made.length > 1 ? `${made.length} items` : this.describe(made[0])}`);
    this.selectMany(made);
    this.afterData();
    this.toast(`Pasted ${made.length} item${made.length === 1 ? '' : 's'}${original ? ' at their original times' : ` at ${fmtTime(at ?? this.time)}`}${skipped ? ` · ${skipped} skipped (locked / no matching track)` : ''}`);
  },

  // files under assets/ that a clipboard / import from another project uses -> copied here: Map(old path -> new path)
  async importAssets(c, from = c.project) {
    const refs = new Set(JSON.stringify(c).match(/assets\/[^"'\s)<>]+/g) ?? []);
    const map = new Map();
    if (!refs.size || from === undefined || !this.saves.server) return map;
    let failed = 0;
    for (const f of refs) {
      try {
        const r = await fetch(editorAPI(`asset-import?from=${encodeURIComponent(from)}&file=${encodeURIComponent(f)}`), { method: 'POST', headers: { 'Content-Length': '0' } });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error);
        if (j.file && j.file !== f) map.set(f, j.file);
      } catch { failed++; }
    }
    if (failed) this.toast(`${failed} media file${failed === 1 ? '' : 's'} couldn’t be copied from the other project — check the Assets tab`, true, 7000);
    this.assets?.refresh();
    return map;
  },

  // Paste special: the copied values onto the selected items (each keeps its own time)
  pasteValues() {
    const c = normalize(this.clipboard);
    if (!c || !c.items.length) return this.toast('Copy a key or caption first', true);
    if (!this.guard()) return;
    const SKIP = new Set(['t', 'a', 'b', 'id', 'locked']);
    let n = 0;
    for (const s of this.sels) {
      if (s.kind !== 'key' && s.kind !== 'clip') continue;
      const src = c.items.find((i) => i.kind === s.kind && (!i.track || i.track.type === s.track.type)) ?? null;
      if (!src) continue;
      for (const [k, v] of Object.entries(src.item)) if (!SKIP.has(k)) s.item[k] = clone(v);
      n++;
    }
    if (!n) return this.toast('Nothing matching selected — select keys of the same kind of track (or captions)', true);
    this.commit(`Pasted values onto ${n} item${n === 1 ? '' : 's'}`);
    this.toast(`Pasted values onto ${n} item${n === 1 ? '' : 's'} (their times stay)`);
  },

  pasteSpecialItems() {
    const c = normalize(this.clipboard);
    return [
      { label: `Paste at the original times${c ? ` (${fmtTime(c.t0)})` : ''}`, disabled: !c, onClick: () => this.paste(null, { original: true }) },
      { label: 'Paste keys into the selected track', disabled: !c?.items.some((i) => i.kind === 'key') || !this.sel?.track, onClick: () => this.paste(this.sel.track) },
      { label: 'Paste values onto the selection (keeps their times)', disabled: !c?.items.length || !this.sel, onClick: () => this.pasteValues() },
    ];
  },

  // Ctrl+D: a copy of the selection starting at the playhead (the clipboard stays as it was)
  duplicate() {
    if (!this.multi && this.sel?.kind === 'track' && this.sel.track.type === 'layer') return this.lt.duplicate(this.sel.track);
    const list = (this.multi ? this.sels : [this.sel]).filter((s) => this.copyable(s));
    if (!list.length) return;
    const c = this.clipboardOf(list);
    const at = Math.abs(c.t0 - this.time) < 1e-3 ? c.t0 + Math.max(0.5, (this.selSpan()?.b ?? c.t0) - c.t0) : this.time;
    this.paste(this.sel?.track, { clip: c, at });
  },

  // ------------------------------------------------------------------ timing
  nudge(dt) {
    const items = this.timedSelection();
    if (!items.length || !this.guard()) return;
    const sp = this.selSpan(items);
    dt = Math.max(-sp.a, Math.min(this.duration - sp.b, dt));
    if (Math.abs(dt) < 1e-6) return;
    for (const it of items) {
      if (it.pt) it.obj.t = r4(it.obj.t + dt);
      else { it.obj.a = r4(it.obj.a + dt); it.obj.b = r4(it.obj.b + dt); }
      for (const k of it.keys ?? []) k.t = r4(k.t + dt);
    }
    this.commit(`Nudged ${items.length > 1 ? `${items.length} items` : this.describe(items[0].s)} ${dt > 0 ? '+' : ''}${+dt.toFixed(3)} s`);
  },

  // times of the selection: q -> anchor + (q − anchor) · f
  scaleTiming(f, anchor) {
    const items = this.timedSelection();
    if (items.length < 1 || !this.guard()) return;
    const D = this.duration, S = (q) => r4(Math.min(D, Math.max(0, anchor + (q - anchor) * f)));
    for (const it of items) {
      if (it.pt) it.obj.t = S(it.obj.t);
      else { it.obj.a = S(it.obj.a); it.obj.b = Math.max(S(it.obj.b), it.obj.a + 0.05); }
      for (const k of it.keys ?? []) k.t = S(k.t);
    }
    this.commit(`Stretched the timing of ${items.length} item${items.length === 1 ? '' : 's'} to ${Math.round(f * 100)}%`);
  },

  scaleDialog() {
    const items = this.timedSelection();
    if (!items.length) return this.toast('Select some keys, captions or clips first', true);
    const sp = this.selSpan(items);
    const pct = h('input', { type: 'number', value: '100', min: '1', max: '1000', step: '5' });
    const len = h('input', { type: 'text', value: fmtTime(sp.b - sp.a, 2) });
    const anchor = h('select', {}, h('option', { value: 'a' }, `its start (${fmtTime(sp.a)})`), h('option', { value: 'p' }, `the playhead (${fmtTime(this.time)})`), h('option', { value: 'b' }, `its end (${fmtTime(sp.b)})`));
    pct.addEventListener('input', () => { len.value = fmtTime(((sp.b - sp.a) * +pct.value) / 100, 2); });
    len.addEventListener('change', () => { const v = parseT(len.value); if (v && sp.b > sp.a) pct.value = String(Math.round((v / (sp.b - sp.a)) * 1000) / 10); });
    dialog({
      title: `Stretch timing of ${items.length} item${items.length === 1 ? '' : 's'}`,
      body: [h('label', { class: 'lbl' }, 'New length (%)', pct), h('label', { class: 'lbl' }, 'or new length (m:ss)', len), h('label', { class: 'lbl' }, 'Keep in place', anchor),
        h('p', { class: 'muted' }, 'Keys, captions and clips move proportionally — a slower or faster version of the same timing. You can also drag the ends of the white bracket on the ruler.')],
      buttons: [{ label: 'Cancel' }, { label: 'Stretch', primary: true, onClick: () => { const f = +pct.value / 100; if (!(f > 0)) return false; this.scaleTiming(f, anchor.value === 'a' ? sp.a : anchor.value === 'b' ? sp.b : this.time); return true; } }],
    });
  },

  // every selected item starts at the playhead
  alignToPlayhead() {
    const items = this.timedSelection();
    if (!items.length || !this.guard()) return;
    const x = r4(this.time);
    for (const it of items) {
      if (it.pt) it.obj.t = x;
      else { const dt = x - it.obj.a; it.obj.a = x; it.obj.b = r4(Math.min(this.duration, it.obj.b + dt)); for (const k of it.keys ?? []) k.t = r4(k.t + dt); }
    }
    this.commit(`Aligned ${items.length} items to ${fmtTime(x)}`);
  },

  // starts spread evenly between the first and the last (or, with `gaps`, each one right after the previous one ends)
  distribute(gaps = false) {
    const items = this.timedSelection().sort((p, q) => (p.pt ? p.obj.t : p.obj.a) - (q.pt ? q.obj.t : q.obj.a));
    if (items.length < 2 || !this.guard()) return this.toast('Select at least two things to distribute', true);
    const st = (it) => (it.pt ? it.obj.t : it.obj.a);
    const move = (it, x) => {
      const dt = x - st(it);
      if (it.pt) it.obj.t = r4(x);
      else { it.obj.a = r4(x); it.obj.b = r4(it.obj.b + dt); }
      for (const k of it.keys ?? []) k.t = r4(k.t + dt);
    };
    if (gaps) {
      let at = st(items[0]);
      for (const it of items) { move(it, at); at = it.pt ? it.obj.t : it.obj.b; }
    } else {
      const a = st(items[0]), b = st(items.at(-1));
      items.forEach((it, i) => move(it, a + ((b - a) * i) / (items.length - 1)));
    }
    this.commit(gaps ? `Closed the gaps between ${items.length} items` : `Spread ${items.length} items evenly`);
  },

  // split the selected captions / layer / path clips at the playhead (the two halves join without a fade)
  splitAtPlayhead() {
    if (!this.guard()) return;
    const x = r4(this.time), made = [];
    for (const s of this.multi ? this.sels : [this.sel]) {
      if (!s) continue;
      if (s.kind === 'clip' && s.track.type === 'captions' && x > s.item.a && x < s.item.b) {
        const right = { ...fresh(s.item), a: x };
        s.item.b = x;
        if (s.item.fadeOut === undefined) s.item.fadeOut = 0;
        right.fadeIn = 0;
        s.track.clips.push(right);
        made.push({ kind: 'clip', track: s.track, item: right });
      } else if (s.kind === 'track' && BAR.has(s.track.type) && x > s.track.a && x < s.track.b) made.push(this.splitBar(s.track, x));
    }
    if (!made.length) return this.toast('Put the playhead inside a selected caption, layer or path to split it (S)', true);
    this.commit(`Split ${made.length > 1 ? `${made.length} clips` : this.describe(made[0])} at ${fmtTime(x)}`);
    this.selectMany(made);
  },

  splitBar(t, x) {
    const right = this.copyTrack(t, t.label);
    const isPath = t.type === 'path';
    // a key exactly at the cut on both halves, so each keeps the motion it had there
    const at = (keys) => {
      const k = { t: x };
      if (isPath) { const p = [0, 0, 0]; hermite(keys, x, 'pos', p); k.pos = p.map((v) => +v.toFixed(3)); } else Object.assign(k, evalKeys(keys, x, {}));
      const prev = [...keys].reverse().find((q) => q.t <= x);
      if (prev?.ease) k.ease = prev.ease;
      return k;
    };
    const cut = t.keys.length ? at(t.keys) : null;
    const leftKeys = t.keys.filter((k) => k.t < x - 1e-4), rightKeys = right.keys.filter((k) => k.t > x + 1e-4);
    if (cut) { leftKeys.push({ ...cut }); rightKeys.unshift({ ...cut }); }
    t.keys = leftKeys;
    right.keys = rightKeys;
    t.b = x; right.a = x;
    if (isPath) { t.blendOut = 0; right.blendIn = 0; } else { t.fadeOut = 0; right.fadeIn = 0; }
    const tracks = this.tl.data.tracks;
    tracks.splice(tracks.indexOf(t) + 1, 0, right);
    return { kind: 'track', track: right };
  },

  // ------------------------------------------------------------------ selecting
  everything(filter = () => true) {
    const out = [];
    for (const r of this.timeline.rows ?? []) {
      if (r.perf) continue;
      const t = r.t;
      if (t.type === 'lane') { for (const m of r.pack.members) out.push({ kind: 'track', track: m }); continue; }
      if (t.type === 'group') continue;
      if (t.type === 'camera' || t.type === 'curve') for (const k of t.keys) out.push({ kind: 'key', track: t, item: k });
      else if (t.type === 'captions') for (const c of t.clips) out.push({ kind: 'clip', track: t, item: c });
      else if (typeof t.a === 'number') out.push({ kind: 'track', track: t });
    }
    return out.filter((s) => {
      const o = s.item ?? s.track;
      return filter(o.t ?? o.a, o.t ?? o.b);
    });
  },

  selectAll() { this.selectMany(this.everything()); this.toast(`${this.sels.length} selected`); },
  selectAfter() { const x = this.time; this.selectMany(this.everything((a) => a >= x - 1e-6)); this.toast(`${this.sels.length} selected after ${fmtTime(x)}`); },
  selectInRange() {
    if (!this.range) return this.toast('Set In (I) and Out (O) first', true);
    const { a, b } = this.range;
    this.selectMany(this.everything((p, q) => q >= a && p <= b));
    this.toast(`${this.sels.length} selected between ${fmtTime(a)} and ${fmtTime(b)}`);
  },
  selectTrack(t) {
    const list = t.keys?.map((k) => ({ kind: 'key', track: t, item: k })) ?? t.clips?.map((c) => ({ kind: 'clip', track: t, item: c })) ?? [];
    if (t.type === 'lane' || t.type === 'group') list.push(...this.timeline.contents(t).filter((m) => typeof m.a === 'number').map((m) => ({ kind: 'track', track: m })));
    if (list.length) this.selectMany(list);
  },

  // ------------------------------------------------------------------ In / Out range
  setIn() { const x = r4(this.time); this.range = { a: x, b: Math.max(this.range?.b ?? 0, Math.min(this.duration, x + 5)) }; if (this.range.b <= x) this.range.b = Math.min(this.duration, x + 5); this.timeline.draw(); this.toast(`In: ${fmtTime(x)}`); },
  setOut() { const x = r4(this.time); this.range = { a: Math.min(this.range?.a ?? Math.max(0, x - 5), x - 0.1), b: x }; this.timeline.draw(); this.toast(`Out: ${fmtTime(x)}`); },
  clearRange() { this.range = null; this.timeline.draw(); },
  toggleLoop() { this.loop = !this.loop; this.timeline.draw(); this.toast(this.loop ? (this.range ? 'Loop: playback repeats the In–Out range' : 'Loop on — set In (I) and Out (O)') : 'Loop off'); },

  // ------------------------------------------------------------------ ripple: insert / delete time in the whole story
  // every unlocked thing in the story; returns the locked ones it would have to move
  rippleBlockers(from) {
    const bad = [];
    for (const t of this.tl.tracks) {
      const lockedT = this.tl.lockedTrack(t);
      if (typeof t.a === 'number' && t.b > from && lockedT) bad.push(t.label || t.id);
      for (const k of t.keys ?? []) if (k.t > from && (lockedT || k.locked)) { bad.push(t.label || t.id); break; }
      for (const c of t.clips ?? []) if (c.b > from && (lockedT || c.locked)) { bad.push(t.label || t.id); break; }
    }
    for (const c of [...this.tl.data.chapters, ...this.tl.data.notes]) if (c.t > from && c.locked) bad.push(c.name || 'a note');
    return [...new Set(bad)];
  },

  insertTime(at, w, { commit = true } = {}) {
    if (!(w > 0) || !this.guard(null)) return;
    const bad = this.rippleBlockers(at);
    if (bad.length) return this.toast(`Can’t push things later — locked: ${bad.slice(0, 4).join(', ')}${bad.length > 4 ? '…' : ''}`, true, 6000);
    const sh = (v) => (v >= at - 1e-6 ? r4(v + w) : v);
    const d = this.tl.data;
    d.meta.duration = r4(this.duration + w);
    for (const t of d.tracks) {
      if (typeof t.a === 'number') { if (t.a >= at - 1e-6) t.a = sh(t.a); if (t.b > at) t.b = r4(t.b + w); }
      for (const k of t.keys ?? []) k.t = sh(k.t);
      for (const c of t.clips ?? []) { if (c.a >= at - 1e-6) c.a = sh(c.a); if (c.b > at) c.b = r4(c.b + w); }
    }
    for (const c of [...d.chapters, ...d.notes]) c.t = sh(c.t);
    if (!commit) return;
    this.commit(`Inserted ${fmtTime(w)} at ${fmtTime(at)}`);
    this.timeline.fit();
    this.toast(`Inserted ${fmtTime(w)} at ${fmtTime(at)} — everything after it moved later`);
  },

  // remove [a, b] from the story: what's inside goes, clips across it get shorter, everything after moves earlier
  deleteTime(a, b) {
    const w = b - a;
    if (!(w > 0) || !this.guard(null)) return;
    const bad = this.rippleBlockers(a);
    if (bad.length) return this.toast(`Can’t remove that time — locked: ${bad.slice(0, 4).join(', ')}${bad.length > 4 ? '…' : ''}`, true, 6000);
    const d = this.tl.data;
    const pt = (v) => (v >= b ? r4(v - w) : v);
    const inside = (v) => v > a + 1e-6 && v < b - 1e-6;
    const span = (o) => { // -> false when nothing is left
      const na = o.a >= b ? o.a - w : o.a > a ? a : o.a;
      const nb = o.b >= b ? o.b - w : o.b > a ? a : o.b;
      o.a = r4(na); o.b = r4(nb);
      return o.b - o.a > 0.05;
    };
    const gone = new Set();
    for (const t of d.tracks) {
      if (t.keys) t.keys = t.keys.filter((k) => !inside(k.t)).map((k) => { k.t = pt(k.t); return k; });
      if (t.clips) t.clips = t.clips.filter((c) => span(c));
      if (typeof t.a === 'number' && typeof t.b === 'number' && !span(t) && t.type !== 'clip') gone.add(t);
    }
    d.tracks = d.tracks.filter((t) => !gone.has(t));
    d.chapters = d.chapters.filter((c) => !inside(c.t) || c.t === 0).map((c) => { c.t = pt(c.t); return c; });
    d.notes = d.notes.filter((c) => !inside(c.t)).map((c) => { c.t = pt(c.t); return c; });
    d.meta.duration = r4(Math.max(1, this.duration - w));
    this.range = null;
    this.tl.changed();
    this.commit(`Removed ${fmtTime(w)} (${fmtTime(a)}–${fmtTime(b)}) from the story`);
    this.validateSelection();
    this.setTime(Math.min(this.time, this.duration));
    this.timeline.fit();
    this.toast(`Removed ${fmtTime(a)}–${fmtTime(b)}: everything after moved ${fmtTime(w)} earlier — ${this.mod}Z to undo`);
  },

  insertTimeDialog() {
    const input = h('input', { type: 'text', value: '5' });
    const go = () => { const v = parseT(input.value); if (!(v > 0)) return false; this.insertTime(r4(this.time), v); return true; };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && go()) dd.close(); });
    const dd = dialog({
      title: `Insert time at ${fmtTime(this.time)}`,
      body: [h('label', { class: 'lbl' }, 'How much (seconds or m:ss)', input), h('p', { class: 'muted' }, 'Everything after the playhead moves later and the story gets longer by that much. Clips that cross the playhead get longer.')],
      buttons: [{ label: 'Cancel' }, { label: 'Insert', primary: true, onClick: go }],
    });
  },

  async rippleDelete() {
    if (!this.range) return this.toast('Mark the time to remove with In (I) and Out (O) first', true);
    const { a, b } = this.range;
    if (await this.confirm('Delete time from the story?', `Removes ${fmtTime(a)}–${fmtTime(b)} (${fmtTime(b - a)}) from the whole story: keys inside it are deleted, clips across it get shorter, and everything after it moves ${fmtTime(b - a)} earlier.`, 'Delete time', true)) this.deleteTime(a, b);
  },

  // ------------------------------------------------------------------ media
  // every reference to asset `from` (layer src / poster / inside HTML …) points to `to` instead
  replaceAsset(from, to, { commit = true } = {}) {
    if (!from || !to || from === to) return 0;
    const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`${esc}(?![A-Za-z0-9_./-])`, 'g');
    let n = 0;
    const walk = (o) => {
      for (const k in o) {
        const v = o[k];
        if (typeof v === 'string' && v.includes(from)) { const w = v.replace(re, to); if (w !== v) { o[k] = w; n++; } } else if (v && typeof v === 'object') walk(v);
      }
    };
    walk(this.tl.data.tracks);
    if (n && commit) {
      this.commit(`Replaced ${from.replace(/^assets\//, '')} with ${to.replace(/^assets\//, '')}`);
      this.toast(`Replaced in ${n} place${n === 1 ? '' : 's'}`);
      this.assets?.render();
    }
    return n;
  },

  // ------------------------------------------------------------------ track colours
  colorItems(tracks) {
    const set = (c) => { for (const t of tracks) { if (c) t.color = c; else delete t.color; } this.commit(c ? 'Coloured tracks' : 'Removed track colours'); };
    return [
      ...Object.entries(TRACK_COLORS).map(([name, c]) => ({ label: name, checked: tracks.every((t) => t.color === c), onClick: () => set(c) })),
      '-',
      { label: 'Default', checked: tracks.every((t) => !t.color), onClick: () => set(null) },
    ];
  },

  // ------------------------------------------------------------------ right-click on a multi-selection
  multiItems(t) {
    const n = this.sels.length, mod = this.mod, L = this.sels.some((s) => this.isLocked(s));
    const keys = this.sels.filter((s) => s.kind === 'key' && ['curve', 'layer'].includes(s.track.type));
    const tracks = this.sels.filter((s) => s.kind === 'track').map((s) => s.track);
    const EASES = ['linear', 'smooth', 'in', 'out', 'hold'];
    return [
      { label: `${n} selected`, disabled: true },
      '-',
      { label: `Copy ${n} items`, shortcut: `${mod}C`, onClick: () => this.copy() },
      { label: `Cut ${n} items`, shortcut: `${mod}X`, disabled: L, onClick: () => this.cut() },
      { label: 'Duplicate at playhead', shortcut: `${mod}D`, onClick: () => this.duplicate() },
      { label: 'Paste special', items: this.pasteSpecialItems() },
      '-',
      { label: `Move here (${fmtTime(t)})`, disabled: L, onClick: () => { const sp = this.selSpan(); if (sp) this.nudge(t - sp.a); } },
      { label: 'Align starts to the playhead', disabled: L, onClick: () => this.alignToPlayhead() },
      { label: 'Spread evenly', disabled: L || n < 2, onClick: () => this.distribute(false) },
      { label: 'Close the gaps (one after another)', disabled: L || n < 2, onClick: () => this.distribute(true) },
      { label: 'Stretch timing…', disabled: L, onClick: () => this.scaleDialog() },
      { label: 'Split at playhead', shortcut: 'S', disabled: L, onClick: () => this.splitAtPlayhead() },
      keys.length ? { label: 'Ease', disabled: L, items: EASES.map((e) => ({ label: e, checked: keys.every((s) => (s.item.ease || 'smooth') === e), onClick: () => { for (const s of keys) s.item.ease = e; this.commit(`Set ease to ${e} on ${keys.length} keys`); } })) } : null,
      tracks.length ? { label: 'Colour', items: this.colorItems(tracks) } : null,
      '-',
      { label: L ? 'Unlock all' : 'Lock all', shortcut: 'L', onClick: () => this.toggleLock() },
      { label: `Delete ${n} items`, shortcut: 'Del', danger: true, disabled: L, onClick: () => this.deleteSelection() },
    ];
  },
};

// "1:05", "65", "1:02:03.5" -> seconds
function parseT(s) {
  const parts = String(s).trim().split(':');
  if (parts.some((x) => x.trim() === '' || !Number.isFinite(+x))) return null;
  return parts.reduce((acc, x) => acc * 60 + +x, 0);
}
