// Inspector: properties of the current selection (project, track, key, caption, chapter, note, object).
// Fields write straight into the timeline data: `input` applies live, `change` / drag-end commits an
// undo step. Times are in seconds (shown as m:ss next to the field). Locked items are read-only.
import { h, btn } from './dom.js';
import { PARAMS, DRIVERS } from '../story.js';
import { EASES, fmtTime } from '../timeline.js';

export class Inspector {
  constructor(ed, root) {
    this.ed = ed;
    this.root = root;
    this.binds = [];
    this.fields = new Map(); // label -> input (for focus())
    this.ro = false; // current panel is read-only (locked)
  }

  // keep visible inputs in sync with data changed elsewhere (timeline drags, gizmo, undo)
  refresh() {
    for (const b of this.binds) b();
  }

  focus(label) {
    const el = this.fields.get(label);
    if (el) { el.focus(); el.select?.(); }
  }

  show() {
    const { ed } = this, s = ed.sel;
    this.binds = [];
    this.fields = new Map();
    this.ro = ed.isLocked(s);
    const el = h('div', { class: 'ins' });
    if (this.ro) {
      const own = s.kind === 'track' ? s.track : s.item;
      el.append(h('div', { class: 'locked' }, h('span', {}, own?.locked ? '🔒 Locked' : '🔒 Its track is locked'),
        btn('Unlock', () => (own?.locked ? ed.toggleLock() : ed.select({ kind: 'track', track: s.track })), { title: own?.locked ? 'L' : 'Select the track to unlock it' })));
    }
    if (!s) this.project(el);
    else if (s.kind === 'track') this.track(el, s.track);
    else if (s.kind === 'key') s.track.type === 'camera' ? this.cameraKey(el, s.track, s.item) : this.curveKey(el, s.track, s.item);
    else if (s.kind === 'clip') this.caption(el, s.track, s.item);
    else if (s.kind === 'chapter') this.chapter(el, s.item);
    else if (s.kind === 'note') this.note(el, s.item);
    else if (s.kind === 'object') this.object(el, s.item);
    if (this.ro) el.querySelectorAll('input, textarea, select').forEach((i) => { if (!i.dataset.free) i.disabled = true; });
    this.root.replaceChildren(h('div', { class: 'ed-h' }, 'Inspector'), el);
  }

  // ------------------------------------------------------------------ widgets
  row(label, input, { drag, after } = {}) {
    const l = h('label', { class: drag && !this.ro ? 'drag' : '', title: drag && !this.ro ? 'Drag to change (Shift = fine)' : '' }, label);
    if (drag && !this.ro) {
      l.addEventListener('pointerdown', (e) => {
        l.setPointerCapture(e.pointerId);
        const x0 = e.clientX, v0 = drag.get();
        const move = (ev) => drag.set(v0 + (ev.clientX - x0) * drag.step * (ev.shiftKey ? 0.1 : 1));
        const up = () => { l.removeEventListener('pointermove', move); l.removeEventListener('pointerup', up); this.ed.commit(); };
        l.addEventListener('pointermove', move);
        l.addEventListener('pointerup', up);
      });
    }
    this.fields.set(label, input.matches?.('input, textarea, select') ? input : input.querySelector?.('input'));
    return h('div', { class: 'row' }, l, after ? h('div', { class: 'with' }, input, after) : input);
  }

  num(label, get, set, { step = 0.01, min = -Infinity, max = Infinity, dec = 3, live = true, time = false } = {}) {
    const clamp = (v) => Math.min(max, Math.max(min, v));
    const input = h('input', { type: 'number', step: String(step) });
    const apply = (v) => { if (!Number.isFinite(v)) return; set(clamp(v)); this.ed.changed(); };
    input.addEventListener('input', () => { if (live) apply(parseFloat(input.value)); });
    input.addEventListener('change', () => { apply(parseFloat(input.value)); this.ed.commit(); });
    const tip = time ? h('span', { class: 'tm' }) : null;
    const sync = () => {
      if (document.activeElement !== input) input.value = +get().toFixed(dec);
      if (tip) tip.textContent = fmtTime(get());
    };
    sync();
    this.binds.push(sync);
    return this.row(label, input, { drag: { get, set: (v) => { apply(+v.toFixed(dec)); sync(); }, step }, after: tip });
  }

  // a time (s) with a m:ss readout
  time(label, get, set, opt = {}) {
    return this.num(label, get, set, { step: 0.1, min: 0, max: this.ed.duration, dec: 2, time: true, ...opt });
  }

  vec(label, arr, { step = 0.05, dec = 2 } = {}) {
    const box = h('div', { class: 'vec' });
    for (let c = 0; c < 3; c++) {
      const input = h('input', { type: 'number', step: String(step), title: 'xyz'[c] });
      input.addEventListener('input', () => { const v = parseFloat(input.value); if (Number.isFinite(v)) { arr()[c] = v; this.ed.changed(); } });
      input.addEventListener('change', () => this.ed.commit());
      const sync = () => { if (document.activeElement !== input) input.value = +arr()[c].toFixed(dec); };
      sync();
      this.binds.push(sync);
      box.append(input);
    }
    return this.row(label, box);
  }

  text(label, get, set, { area = false, placeholder = '' } = {}) {
    const input = h(area ? 'textarea' : 'input', { type: 'text', placeholder });
    input.value = get() ?? '';
    input.addEventListener('input', () => { set(input.value); this.ed.changed(); });
    input.addEventListener('change', () => this.ed.commit());
    return this.row(label, input);
  }

  select(label, options, get, set) {
    const sel = h('select', {}, Object.entries(options).map(([v, t]) => h('option', { value: v }, t)));
    sel.value = get();
    sel.addEventListener('change', () => { set(sel.value); this.ed.changed(); this.ed.commit(); });
    return this.row(label, sel);
  }

  check(label, get, set, { free = false } = {}) {
    const c = h('input', { type: 'checkbox' });
    if (free) c.dataset.free = '1';
    c.checked = !!get();
    c.addEventListener('change', () => { set(c.checked); this.ed.changed(); this.ed.commit(); });
    return this.row(label, h('div', {}, c));
  }

  readout(label, fn) {
    const span = h('span', { style: 'font-variant-numeric: tabular-nums' });
    const sync = () => { span.textContent = fn(); };
    sync();
    this.binds.push(sync);
    return this.row(label, span);
  }

  header(el, title, kind) { el.append(h('h3', {}, title), h('div', { class: 'kind' }, kind)); }
  sec(el, title) { el.append(h('div', { class: 'sec' }, title)); }
  buttons(el, ...b) {
    if (this.ro) b.forEach((x) => { if (x && !x.dataset.free) x.disabled = true; });
    el.append(h('div', { class: 'btns' }, b));
  }
  free(b) { b.dataset.free = '1'; return b; } // a button that stays usable on locked items

  // a clickable list of keys / clips
  list(el, items, label, onPick) {
    el.append(h('div', { class: 'list' }, items.map((it, i) => h('div', { class: `li ${it.locked ? 'lk' : ''}`, onclick: () => onPick(it) },
      h('span', {}, label(it, i)[0]), h('span', {}, label(it, i)[1])))));
  }

  // ------------------------------------------------------------------ panels
  project(el) {
    const { ed } = this, d = ed.tl.data;
    this.header(el, 'Project', 'story.json — nothing selected');
    el.append(this.text('Title', () => d.meta.title, (v) => { d.meta.title = v; }));
    el.append(this.row('Story length', h('div', { class: 'with' }, h('span', { class: 'tm big' }, fmtTime(ed.duration, 0)), btn('Change…', () => ed.lengthDialog()))));
    el.append(this.num('Scroll vh / s', () => d.meta.scrollPerSecond, (v) => { d.meta.scrollPerSecond = v; }, { step: 1, min: 2, max: 200, dec: 1 }));
    el.append(this.num('Tuna', () => d.settings.tunaCount ?? 2000, (v) => { d.settings.tunaCount = Math.round(v); ed.app.setTunaCount(Math.round(v)); }, { step: 10, min: 200, max: 4096, dec: 0, live: false }));
    el.append(h('div', { class: 'hint' }, 'Story length can be anything (an hour is fine) — drag the end marker on the ruler, or right-click the ruler. Scroll vh / s = how much page a visitor scrolls per second of story.'));

    this.sec(el, 'Scene parameters');
    for (const [id, P] of Object.entries(PARAMS)) {
      const t = ed.tl.bound.get(id);
      if (t && t.type === 'curve' && !t.mute && t.keys.length) {
        el.append(this.row(P.label, h('span', { class: 'anim', onclick: () => ed.select({ kind: 'track', track: t }) }, `animated by “${t.label}” ▸`)));
      } else {
        el.append(this.num(P.label, () => d.settings.params[id] ?? P.def, (v) => { d.settings.params[id] = v; }, { step: P.step, min: P.min, max: P.max, dec: 3 }));
      }
    }
    el.append(h('div', { class: 'hint' }, 'To animate a parameter over the story: timeline ▸ “+ Track…” and pick it.'));
    this.sec(el, 'Help');
    this.buttons(el, btn('Keyboard shortcuts', () => ed.shortcutsDialog()), btn('Editor guide ↗', () => window.open('./EDITOR.md', '_blank')));
  }

  track(el, t) {
    const { ed } = this;
    this.header(el, t.label || t.id, `${t.type} track${t.bind ? ` · ${t.bind}` : ''}`);
    el.append(this.text('Name', () => t.label, (v) => { t.label = v; }));
    el.append(this.check('Mute', () => t.mute, (v) => { if (v) t.mute = true; else delete t.mute; }));
    el.append(this.check('Lock', () => t.locked, (v) => { if (v) t.locked = true; else delete t.locked; }, { free: true }));

    if (t.type === 'clip') {
      el.append(this.select('Drives', DRIVERS, () => t.bind, (v) => { t.bind = v; }));
      el.append(this.time('Start', () => t.a, (v) => { t.a = Math.min(v, t.b - 0.05); }));
      el.append(this.time('End', () => t.b, (v) => { t.b = Math.max(v, t.a + 0.05); }));
      el.append(this.select('Ease', { ...Object.fromEntries(Object.keys(EASES).filter((k) => k !== 'hold').map((k) => [k, k])), gate: 'gate (on/off)' }, () => t.ease || 'linear', (v) => { t.ease = v; }));
      el.append(this.readout('Value now', () => ed.tl.clip(t.bind, ed.time).toFixed(3)));
      el.append(h('div', { class: 'hint' }, 'Drag the bar in the timeline to move it; drag its ends to change start / end.'));
    }
    if (t.type === 'curve') {
      const P = PARAMS[t.bind] || {};
      el.append(this.select('Parameter', Object.fromEntries(Object.entries(PARAMS).map(([k, v]) => [k, v.label])), () => t.bind, (v) => { t.bind = v; }));
      el.append(this.readout('Value now', () => (ed.tl.param(t.bind, ed.time, P.def ?? 0)).toFixed(3)));
      this.sec(el, `Keys (${t.keys.length})`);
      this.list(el, t.keys, (k) => [`${k.locked ? '🔒 ' : ''}${fmtTime(k.t)}`, `${+k.v.toFixed(3)} · ${k.ease || 'smooth'}`], (k) => { ed.select({ kind: 'key', track: t, item: k }); ed.setTime(k.t); });
      this.buttons(el, btn('Key at playhead', () => ed.addKey(t), { ico: 'plus', title: 'K' }));
    }
    if (t.type === 'camera') {
      el.append(this.num('Hand-held drift', () => t.drift ?? 1, (v) => { t.drift = v; }, { step: 0.05, min: 0, max: 4, dec: 2 }));
      this.sec(el, `Camera keys (${t.keys.length})`);
      this.list(el, t.keys, (k, i) => [`${k.locked ? '🔒 ' : ''}#${i + 1}  ${fmtTime(k.t)}`, `fov ${k.fov ?? 50}${k.follow ? ` · follow ${+k.follow.toFixed(2)}` : ''}`], (k) => { ed.select({ kind: 'key', track: t, item: k }); ed.setTime(k.t); });
      this.buttons(el, btn('Key at playhead', () => ed.addKey(t), { ico: 'plus', title: 'K — in the Scene view the key is taken from your view' }));
      el.append(h('div', { class: 'hint' }, 'Tip: switch to the Scene view (1), fly to a framing you like (drag / WASD), then press K to add a camera key from that view.'));
    }
    if (t.type === 'captions') {
      this.sec(el, `Captions (${t.clips.length})`);
      this.list(el, t.clips, (c) => [`${c.locked ? '🔒 ' : ''}${fmtTime(c.a, 0)}–${fmtTime(c.b, 0)}`, (c.title || '').replace(/\n/g, ' ')], (c) => { ed.select({ kind: 'clip', track: t, item: c }); ed.setTime((c.a + c.b) / 2); });
      this.buttons(el, btn('Caption at playhead', () => ed.addCaption(), { ico: 'plus' }));
    }
    this.sec(el, 'Track');
    this.buttons(el, btn('Move up', () => ed.moveTrack(t, -1)), btn('Move down', () => ed.moveTrack(t, 1)), btn('Delete track', () => ed.deleteSelection(), { cls: 'danger' }));
  }

  curveKey(el, t, k) {
    const { ed } = this, P = PARAMS[t.bind] || { min: -1e9, max: 1e9, step: 0.01 };
    this.header(el, `${t.label} — key`, `curve key · ${t.bind} · ${fmtTime(k.t)}`);
    el.append(this.time('Time (s)', () => k.t, (v) => { k.t = v; }));
    el.append(this.num('Value', () => k.v, (v) => { k.v = v; }, { step: P.step, min: P.min, max: P.max }));
    el.append(this.select('Ease to next', Object.fromEntries(Object.keys(EASES).map((e) => [e, e])), () => k.ease || 'smooth', (v) => { k.ease = v; }));
    this.buttons(el, this.free(btn('Go to', () => ed.setTime(k.t))), this.free(btn('Track', () => ed.select({ kind: 'track', track: t }))), btn('Delete', () => ed.deleteSelection(), { cls: 'danger' }));
  }

  cameraKey(el, t, k) {
    const { ed } = this, i = t.keys.indexOf(k);
    this.header(el, `Camera key #${i + 1}`, `camera key · ${fmtTime(k.t)}`);
    el.append(this.time('Time (s)', () => k.t, (v) => { k.t = v; }));
    el.append(this.vec('Camera xyz', () => k.pos));
    el.append(this.vec('Look at xyz', () => k.look));
    el.append(this.num('Follow school', () => k.follow ?? 0, (v) => { k.follow = v; }, { step: 0.01, min: 0, max: 1, dec: 2 }));
    el.append(this.num('FOV (°)', () => k.fov ?? 50, (v) => { k.fov = v; }, { step: 0.5, min: 10, max: 110, dec: 1 }));
    el.append(h('div', { class: 'hint' }, 'Follow school 1 = look at the tuna school instead of “Look at”. In the Scene view the key shows as a blue ball (camera) and an orange one (look target); drag the gizmo arrows to move it.'));
    this.buttons(el,
      btn('Set from Scene view', () => ed.keyFromView(k), { ico: 'camera', title: 'Copy the Scene view camera into this key' }),
      this.free(btn('Go to', () => ed.setTime(k.t))),
    );
    const g = this.select('Gizmo moves', { pos: 'Camera position', look: 'Look target' }, () => ed.gizmos.mode, (v) => { ed.gizmos.mode = v; });
    g.querySelector('select').dataset.free = '1';
    el.append(g);
    this.buttons(el, this.free(btn('Track', () => ed.select({ kind: 'track', track: t }))), btn('Delete', () => ed.deleteSelection(), { cls: 'danger' }));
  }

  caption(el, t, c) {
    const { ed } = this;
    this.header(el, 'Caption', `caption · ${fmtTime(c.a)} → ${fmtTime(c.b)}`);
    el.append(this.text('Title', () => c.title, (v) => { c.title = v; }, { area: true, placeholder: 'Line breaks are kept' }));
    el.append(this.text('Small text', () => c.sub, (v) => { c.sub = v; }, { placeholder: 'optional, e.g. SCROLL' }));
    el.append(this.select('Size', { large: 'Large (hero)', medium: 'Medium' }, () => c.size || 'medium', (v) => { c.size = v; }));
    el.append(this.num('Height (%)', () => c.y ?? 42, (v) => { c.y = v; }, { step: 0.5, min: 0, max: 95, dec: 1 }));
    this.sec(el, 'Timing');
    el.append(this.time('Start', () => c.a, (v) => { c.a = Math.min(v, c.b - 0.1); }));
    el.append(this.time('End', () => c.b, (v) => { c.b = Math.max(v, c.a + 0.1); }));
    el.append(this.num('Fade (s)', () => c.fade ?? 2.4, (v) => { c.fade = v; }, { step: 0.1, min: 0, max: 20, dec: 2 }));
    el.append(h('div', { class: 'hint' }, 'A caption starting at 0:00 is already visible when the page opens. Right-click the caption for split / trim to playhead.'));
    this.buttons(el, this.free(btn('Go to', () => ed.setTime((c.a + c.b) / 2))), btn('Delete', () => ed.deleteSelection(), { cls: 'danger' }));
  }

  chapter(el, c) {
    const { ed } = this;
    this.header(el, c.name, `chapter marker · ${fmtTime(c.t)}`);
    el.append(this.text('Name', () => c.name, (v) => { c.name = v; }));
    el.append(this.time('Starts at (s)', () => c.t, (v) => { c.t = v; }));
    el.append(h('div', { class: 'hint' }, 'Chapters only label the timeline (and the reference you copy for Claude) — they don’t change the scene.'));
    this.buttons(el, this.free(btn('Go to', () => ed.setTime(c.t))), btn('Delete', () => ed.deleteSelection(), { cls: 'danger' }));
  }

  note(el, n) {
    const { ed } = this;
    this.header(el, 'Note', `note at ${fmtTime(n.t)}`);
    el.append(this.text('Text', () => n.text, (v) => { n.text = v; }, { area: true, placeholder: 'e.g. “tentacle pops in here — should grow smoothly”' }));
    el.append(this.time('At (s)', () => n.t, (v) => { n.t = v; }));
    el.append(h('div', { class: 'hint' }, 'Notes are saved in story.json — ask Claude to “check the notes in story.json” and it will read them.'));
    this.buttons(el, this.free(btn('Go to', () => ed.setTime(n.t))), btn('Delete', () => ed.deleteSelection(), { cls: 'danger' }));
  }

  object(el, o) {
    const { ed } = this;
    this.header(el, o.name, `scene object · ${o.group}`);
    el.append(this.check('Visible', () => !ed.isHidden(o), (v) => ed.setHidden(o, !v)));
    if (o.name === 'Tuna school') {
      const d = ed.tl.data;
      el.append(this.num('Count', () => d.settings.tunaCount ?? 2000, (v) => { d.settings.tunaCount = Math.round(v); ed.app.setTunaCount(Math.round(v)); }, { step: 10, min: 200, max: 4096, dec: 0, live: false }));
    }
    this.buttons(el, btn('Solo', () => ed.solo(o), { title: 'Show only this' }), btn('Show all', () => ed.showAll()),
      ed.focusPoint(o) ? btn('Focus in Scene view', () => ed.focus(o), { ico: 'camera' }) : null);
    el.append(h('div', { class: 'hint' }, 'Hiding is for looking around while editing — it is not saved and does not affect the site.'));
  }
}
