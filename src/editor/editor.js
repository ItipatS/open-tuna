// Open Tuna editor (?edit): a Unity-style shell around the story.
//   toolbar   Play / Pause / Stop, readout, sim speed, undo / redo, copy reference, snapshot, open site, save
//   left      outliner: scene objects (hide / focus) and post effects
//   centre    viewport: Game view (the story camera, captions, aspect frame) or Scene view (free camera,
//             camera-path gizmos)
//   right     inspector for the selection
//   bottom    timeline of story.json
// Edits apply live. Save writes story.json via the local dev server (tools/serve.py / serve.ps1) and
// falls back to a file picker / download (e.g. on GitHub Pages). Unsaved work is kept as a browser draft.
import * as THREE from 'three/webgpu';
import { h, btn, icon, download } from './dom.js';
import { Inspector } from './inspector.js';
import { TimelineView } from './timeline-view.js';
import { SceneGizmos } from './scene-gizmos.js';
import { PARAMS, DRIVERS } from '../story.js';

const DRAFT_KEY = 'openTuna.draft.v1';
const ASPECTS = { '16:9': 16 / 9, '16:10': 16 / 10, '21:9': 21 / 9, '4:3': 4 / 3, '9:19.5': 9 / 19.5, free: 0 };
const clamp01 = (x) => Math.min(1, Math.max(0, x));

export class Editor {
  constructor(app) {
    this.app = app;
    this.tl = app.timeline;
    this.story = app.story;
    this.p = 0;
    this.playing = false;
    this.playFrom = 0;
    this.view = 'game';
    this.aspect = '16:9';
    this.maxOnPlay = false;
    this.snap = true;
    this.sel = null;
    this.perf = new Float32Array(400); // fps measured along the story
    this.born = performance.now();
    this.history = [this.tl.serialize()];
    this.hi = 0;
    this.saved = this.history[0];
    this.sceneCam = null; // remembered Scene view pose

    document.head.append(h('link', { rel: 'stylesheet', href: new URL('./editor.css', import.meta.url).href }));
    this.buildDOM();
    this.inspector = new Inspector(this, this.$right);
    this.timeline = new TimelineView(this, this.$tlwrap);
    this.gizmos = new SceneGizmos(this);
    this.buildOutliner();
    this.bindKeys();
    this.setView('game');
    this.select(null);
    this.story.forceP = this.p;
    this.ping();
    this.checkDraft();
  }

  get sceneView() { return this.view === 'scene' && !this.playing; }

  // ------------------------------------------------------------------ layout
  buildDOM() {
    const { renderer } = this.app;
    const tb = (label, fn, opt) => btn(label, fn, opt);
    this.$play = tb('', () => (this.playing ? this.pause() : this.play()), { ico: 'play', title: 'Play / Pause (Space)', id: 'ed-play' });
    this.$readout = h('div', { id: 'ed-readout' });
    this.$fps = h('div', { id: 'ed-fps' });
    this.$save = tb('Save', () => this.save(), { ico: 'save', title: 'Save story.json (Ctrl+S)', cls: 'primary' });
    this.$undo = tb('', () => this.undo(), { ico: 'undo', title: 'Undo (Ctrl+Z)' });
    this.$redo = tb('', () => this.redo(), { ico: 'redo', title: 'Redo (Ctrl+Y)' });
    const speed = h('select', { title: 'Simulation speed (fish, water, particles). 0 = freeze the moment.' },
      [['1', 'Sim 1×'], ['0.5', 'Sim ½×'], ['0.25', 'Sim ¼×'], ['0', 'Sim frozen']].map(([v, t]) => h('option', { value: v }, t)));
    speed.addEventListener('change', () => { this.app.setTimeScale(+speed.value); speed.blur(); });

    const bar = h('header', { id: 'ed-bar' },
      h('div', { class: 'brand' }, h('b', {}, 'OPEN TUNA'), ' · EDITOR'),
      tb('', () => { this.pause(); this.setP(0); }, { ico: 'start', title: 'Go to start (Home)' }),
      this.$play,
      tb('', () => this.stop(), { ico: 'stop', title: 'Stop — back to where Play started (Esc)' }),
      this.$readout,
      h('div', { class: 'sep' }),
      speed,
      h('div', { class: 'sep' }),
      this.$undo, this.$redo,
      h('div', { class: 'sep' }),
      tb('Copy ref', () => this.copyRef(), { ico: 'copy', title: 'Copy a precise reference to this moment — paste it to Claude' }),
      tb('', () => this.snapshot(), { ico: 'image', title: 'Save a PNG of the viewport' }),
      tb('Open site', () => window.open(`./?p=${this.p.toFixed(3)}`, '_blank'), { ico: 'link', title: 'Open the real scroll site at this moment (new tab)' }),
      h('div', { class: 'grow' }),
      this.$fps,
      this.$save,
    );

    this.$outliner = h('div');
    const left = h('aside', { id: 'ed-left' }, h('div', { class: 'ed-h' }, 'Scene'), this.$outliner);

    this.$tabs = {
      scene: h('button', { class: 'tab', onclick: () => this.setView('scene'), title: 'Free camera + camera path (1)' }, 'Scene'),
      game: h('button', { class: 'tab', onclick: () => this.setView('game'), title: 'What the visitor sees (2)' }, 'Game'),
    };
    const aspect = h('select', { title: 'Game view frame' }, Object.keys(ASPECTS).map((k) => h('option', { value: k }, k === 'free' ? 'Free aspect' : k)));
    aspect.value = this.aspect;
    aspect.addEventListener('change', () => { this.aspect = aspect.value; aspect.blur(); this.layoutStage(); });
    const maxBtn = h('button', { class: 'tab', title: 'Hide the editor panels while playing' }, 'Maximize on Play');
    maxBtn.addEventListener('click', () => { this.maxOnPlay = !this.maxOnPlay; maxBtn.classList.toggle('on', this.maxOnPlay); });
    this.$viewHint = h('span', { class: 'hint' });
    const align = h('button', { class: 'tab', title: 'Put the Scene camera where the story camera is', onclick: () => this.alignToShot() }, 'Align to shot');
    this.$align = align;
    const tabs = h('div', { id: 'ed-tabs' }, this.$tabs.scene, this.$tabs.game, aspect, maxBtn, align, this.$viewHint);

    this.$stage = h('div', { id: 'ed-stage' });
    this.$badge = h('div', { id: 'ed-badge' });
    this.$toast = h('div', { id: 'ed-toast' });
    this.$wrap = h('div', { id: 'ed-wrap' }, this.$stage);
    const view = h('main', { id: 'ed-view' }, tabs, this.$wrap, this.$toast);
    this.$stage.append(renderer.domElement, document.getElementById('captions'), this.$badge);

    this.$right = h('aside', { id: 'ed-right' });

    const add = (label, fn, title) => btn(label, fn, { ico: 'plus', title });
    this.$addTrack = h('select', { title: 'Add a track that animates a parameter or drives a story beat' });
    this.$addTrack.addEventListener('change', () => { const v = this.$addTrack.value; this.$addTrack.value = ''; this.$addTrack.blur(); if (v) this.addTrack(v); });
    const snapBtn = btn('Snap', () => { this.snap = !this.snap; snapBtn.classList.toggle('on', this.snap); }, { title: 'Snap to keys, chapters, playhead and grid (hold Shift to bypass)', cls: 'on' });
    this.$pInput = h('input', { type: 'text', title: 'Type a position (0–1) and press Enter' });
    this.$pInput.addEventListener('change', () => { const v = parseFloat(this.$pInput.value); if (Number.isFinite(v)) this.setP(clamp01(v)); this.$pInput.blur(); });
    const tlbar = h('div', { id: 'ed-tlbar' },
      add('Key', () => this.addKey(), 'Add a key at the playhead to the selected camera / curve track (K)'),
      add('Caption', () => this.addCaption(), 'Add a caption at the playhead'),
      add('Note', () => this.addNote(), 'Leave a note at the playhead (saved in story.json)'),
      add('Chapter', () => this.addChapter(), 'Start a new chapter at the playhead'),
      this.$addTrack,
      h('div', { class: 'sep' }),
      snapBtn,
      btn('Fit', () => { this.timeline.fit(); this.timeline.draw(); }, { title: 'Show the whole story (F)' }),
      this.$pInput,
      h('span', { class: 'hint' }, 'Drag the ruler to scrub · Ctrl+wheel zoom · Shift+wheel pan · double-click a lane to add'),
      h('div', { class: 'grow' }),
    );
    this.$tlwrap = h('div', { id: 'ed-tlwrap' });
    const split = h('div', { id: 'ed-split', title: 'Drag to resize' });
    const tlEl = h('section', { id: 'ed-tl' }, split, tlbar, this.$tlwrap);

    this.$root = h('div', { id: 'ed' }, bar, left, view, this.$right, tlEl);
    document.body.append(this.$root);
    // a clicked button keeps focus and would also react to Space (play / pause)
    this.$root.addEventListener('click', (e) => e.target.closest?.('button')?.blur());

    split.addEventListener('pointerdown', (e) => {
      split.setPointerCapture(e.pointerId);
      const y0 = e.clientY, h0 = tlEl.getBoundingClientRect().height;
      const mv = (ev) => this.$root.style.setProperty('--tl-h', `${Math.min(innerHeight - 200, Math.max(120, h0 - (ev.clientY - y0)))}px`);
      const up = () => { split.removeEventListener('pointermove', mv); split.removeEventListener('pointerup', up); };
      split.addEventListener('pointermove', mv);
      split.addEventListener('pointerup', up);
    });
    new ResizeObserver(() => this.layoutStage()).observe(this.$wrap);
    this.refreshAddTrack();
  }

  // fit the stage to the viewport (Game view keeps the chosen aspect)
  layoutStage() {
    const W = this.$wrap.clientWidth, H = this.$wrap.clientHeight;
    const r = this.view === 'game' || this.playing ? ASPECTS[this.aspect] : 0;
    let w = W, hh = H;
    if (r) { if (W / H > r) w = H * r; else hh = W / r; }
    this.$stage.style.width = `${Math.max(1, Math.floor(w))}px`;
    this.$stage.style.height = `${Math.max(1, Math.floor(hh))}px`;
    this.app.onResize();
  }

  viewSize() { return { w: Math.max(1, this.$stage.clientWidth), h: Math.max(1, this.$stage.clientHeight) }; }

  setView(v) {
    const { camera, controls } = this.app;
    if (this.view === 'scene' && v !== 'scene') this.sceneCam = { pos: camera.position.clone(), target: controls.target.clone() };
    const entering = v === 'scene' && this.view !== 'scene';
    this.view = v;
    if (entering) {
      if (this.sceneCam) { camera.position.copy(this.sceneCam.pos); controls.target.copy(this.sceneCam.target); }
      else this.alignToShot(true);
    }
    controls.enabled = this.sceneView;
    for (const [k, b] of Object.entries(this.$tabs)) b.classList.toggle('on', k === v);
    this.$stage.classList.toggle('scene', v === 'scene');
    this.$align.style.display = v === 'scene' ? '' : 'none';
    this.$viewHint.textContent = v === 'scene'
      ? 'Drag orbit · right-drag pan · wheel zoom · WASD/QE fly (Shift fast) · click a ball to pick a camera key · K adds a key from this view'
      : 'The story camera — exactly what the site shows at this point';
    this.layoutStage();
  }

  alignToShot(keepView) {
    const { camera, controls } = this.app;
    camera.position.copy(this.story.cam.position);
    camera.quaternion.copy(this.story.cam.quaternion);
    controls.target.copy(this.story.look);
    if (!keepView) this.setView('scene');
  }

  // ------------------------------------------------------------------ outliner
  buildOutliner() {
    const { objects, opts, buildPost } = this.app;
    this.hiddenEntries = new Set();
    const rows = [];
    let group = null;
    const row = (entry, isOn, toggle, selectable = true) => {
      const eye = h('span', { class: 'eye', title: 'Show / hide (editor only)' });
      const el = h('div', { class: 'ed-item' }, eye, h('span', { class: 'name' }, entry.name));
      const sync = () => { const on = isOn(); el.classList.toggle('off', !on); eye.replaceChildren(icon(on ? 'eye' : 'eyeOff')); };
      eye.addEventListener('click', (e) => { e.stopPropagation(); toggle(); sync(); if (this.sel?.item === entry) this.inspector.show(); });
      if (selectable) el.addEventListener('click', () => this.select({ kind: 'object', item: entry }));
      entry.el = el;
      entry.sync = sync;
      sync();
      return el;
    };
    for (const o of objects) {
      if (o.group !== group) { group = o.group; rows.push(h('div', { class: 'ed-group' }, group)); }
      rows.push(row(o, () => !this.isHidden(o), () => this.setHidden(o, !this.isHidden(o))));
    }
    rows.push(h('div', { class: 'ed-group' }, 'Post / overlay'));
    const caps = document.getElementById('captions');
    const fx = [
      { name: 'God rays', on: () => opts.godRays, set: () => { opts.godRays = !opts.godRays; buildPost(); } },
      { name: 'Bloom', on: () => opts.bloom, set: () => { opts.bloom = !opts.bloom; buildPost(); } },
      { name: 'Captions', on: () => caps.style.visibility !== 'hidden', set: () => { caps.style.visibility = caps.style.visibility === 'hidden' ? '' : 'hidden'; } },
    ];
    for (const f of fx) rows.push(row({ name: f.name }, f.on, f.set, false));
    this.$outliner.replaceChildren(...rows);
  }

  isHidden(o) { return this.hiddenEntries.has(o); }
  setHidden(o, hide) {
    const list = [o.obj].flat();
    if (hide) { this.hiddenEntries.add(o); for (const x of list) this.app.hidden.add(x); }
    else { this.hiddenEntries.delete(o); for (const x of list) { this.app.hidden.delete(x); x.visible = true; } }
    o.sync?.();
  }

  focusPoint(o) {
    const { tuna, tentacles } = this.app;
    const first = [o.obj].flat()[0];
    if (first === tuna.mesh) return tuna.u.goal.value.clone();
    if (first === tentacles) return new THREE.Vector3(0, 13, 0);
    if (first.isObject3D && first.position.lengthSq() > 0) return first.getWorldPosition(new THREE.Vector3());
    return null;
  }

  focus(o) {
    const p = this.focusPoint(o);
    if (!p) return;
    const { camera, controls } = this.app;
    if (this.view !== 'scene') this.setView('scene');
    const dir = camera.position.clone().sub(controls.target).normalize();
    controls.target.copy(p);
    camera.position.copy(p).addScaledVector(dir, o.name === 'Water tentacles' ? 60 : 22);
  }

  // ------------------------------------------------------------------ selection & editing
  select(sel) {
    this.sel = sel;
    for (const o of this.app.objects) o.el?.classList.toggle('sel', sel?.kind === 'object' && sel.item === o);
    this.inspector.show();
    this.timeline.draw();
  }

  setP(p) {
    this.p = clamp01(p);
    this.story.forceP = this.p;
  }

  // live edit: re-sort + redraw (no undo step yet)
  changed() {
    this.tl.changed();
    this.timeline.draw();
  }

  // finish an edit: one undo step, draft autosave
  commit() {
    this.tl.changed();
    const s = this.tl.serialize();
    if (s === this.history[this.hi]) return;
    this.history.splice(this.hi + 1);
    this.history.push(s);
    if (this.history.length > 300) this.history.shift();
    this.hi = this.history.length - 1;
    this.afterEdit(s);
  }

  afterEdit(s) {
    try { if (s !== this.saved) localStorage.setItem(DRAFT_KEY, JSON.stringify({ text: s, time: Date.now() })); else localStorage.removeItem(DRAFT_KEY); } catch { /* storage unavailable */ }
    this.refreshAddTrack();
    this.syncButtons();
    if (!this.$right.contains(document.activeElement)) this.inspector.show();
    this.timeline.draw();
  }

  restore(s) {
    const path = this.selPath();
    this.tl.set(JSON.parse(s));
    this.sel = this.resolve(path);
    const n = this.tl.data.settings.tunaCount;
    if (n && n !== this.app.tuna.count) this.app.setTunaCount(n);
    this.afterEdit(s);
    this.inspector.show();
  }

  undo() { if (this.hi > 0) { this.hi--; this.restore(this.history[this.hi]); } }
  redo() { if (this.hi < this.history.length - 1) { this.hi++; this.restore(this.history[this.hi]); } }

  // selection as indices (survives undo / redo, which rebuild the data objects)
  selPath() {
    const s = this.sel, d = this.tl.data;
    if (!s) return null;
    if (s.kind === 'object') return s;
    const ti = s.track ? d.tracks.indexOf(s.track) : -1;
    const ii = s.kind === 'key' ? s.track.keys.indexOf(s.item) : s.kind === 'clip' ? s.track.clips.indexOf(s.item)
      : s.kind === 'chapter' ? d.chapters.indexOf(s.item) : s.kind === 'note' ? d.notes.indexOf(s.item) : -1;
    return { kind: s.kind, ti, ii };
  }

  resolve(path) {
    if (!path) return null;
    if (path.kind === 'object') return path;
    const d = this.tl.data, track = d.tracks[path.ti];
    if (path.kind === 'chapter') return d.chapters[path.ii] ? { kind: 'chapter', item: d.chapters[path.ii] } : null;
    if (path.kind === 'note') return d.notes[path.ii] ? { kind: 'note', item: d.notes[path.ii] } : null;
    if (!track) return null;
    if (path.kind === 'track') return { kind: 'track', track };
    const item = path.kind === 'key' ? track.keys?.[path.ii] : track.clips?.[path.ii];
    return item ? { kind: path.kind, track, item } : { kind: 'track', track };
  }

  // the track K / "+ Key" adds to: the selected camera / curve track, else the camera
  keyTrack() {
    const t = this.sel?.track;
    return t && (t.type === 'camera' || t.type === 'curve') ? t : this.tl.tracks.find((x) => x.type === 'camera');
  }

  addKey(track = this.keyTrack()) {
    if (!track) return this.toast('Select a camera or curve track first');
    const p = +this.p.toFixed(4);
    let key = track.keys.find((k) => Math.abs(k.p - p) < 1e-4);
    const isNew = !key;
    if (track.type === 'camera') {
      const pose = this.currentPose();
      key ??= { p };
      Object.assign(key, pose);
    } else {
      const P = PARAMS[track.bind] || { def: 0 };
      key ??= { p, ease: 'smooth' };
      key.v = +this.tl.param(track.bind, p, P.def).toFixed(4);
    }
    if (isNew) track.keys.push(key);
    this.commit();
    this.select({ kind: 'key', track, item: key });
    this.toast(isNew ? `Key added at p ${p.toFixed(3)}${track.type === 'camera' && this.sceneView ? ' from the Scene view' : ''}` : `Key at p ${p.toFixed(3)} updated`);
  }

  // camera pose for a new key: the Scene view camera, or (Game view) the story camera's current pose
  currentPose() {
    const { camera, controls } = this.app;
    const r = (v) => v.toArray().map((x) => +x.toFixed(3));
    if (this.sceneView) return { pos: r(camera.position), look: r(controls.target), follow: 0, fov: +camera.fov.toFixed(1) };
    const k = { pos: [0, 0, 0], look: [0, 0, 0], follow: 0, fov: 50 };
    this.tl.camera(this.p, k);
    return { pos: k.pos.map((x) => +x.toFixed(3)), look: k.look.map((x) => +x.toFixed(3)), follow: +k.follow.toFixed(3), fov: +k.fov.toFixed(1) };
  }

  keyFromView(key) {
    if (!this.sceneView) { this.toast('Switch to the Scene view (1), frame the shot, then press this again'); return; }
    const pose = this.currentPose();
    Object.assign(key, { pos: pose.pos, look: pose.look, follow: 0 });
    this.commit();
    this.toast('Key set from the Scene view');
  }

  addCaption() {
    let t = this.tl.tracks.find((x) => x.type === 'captions');
    if (!t) { t = { id: 'captions', type: 'captions', label: 'Captions', clips: [] }; this.tl.tracks.splice(1, 0, t); }
    const a = +this.p.toFixed(4), c = { a, b: Math.min(1, +(a + 0.08).toFixed(4)), size: 'medium', y: 42, title: 'New caption', sub: '' };
    t.clips.push(c);
    this.commit();
    this.select({ kind: 'clip', track: t, item: c });
  }

  addNote() {
    const n = { p: +this.p.toFixed(4), text: '' };
    this.tl.data.notes.push(n);
    this.commit();
    this.select({ kind: 'note', item: n });
    setTimeout(() => this.$right.querySelector('textarea')?.focus(), 0);
  }

  addChapter() {
    const c = { p: +this.p.toFixed(4), name: 'New chapter' };
    this.tl.data.chapters.push(c);
    this.commit();
    this.select({ kind: 'chapter', item: c });
  }

  refreshAddTrack() {
    const used = new Set(this.tl.tracks.map((t) => t.bind).filter(Boolean));
    const opt = (v, t) => h('option', { value: v, disabled: used.has(v.slice(v.indexOf(':') + 1)) }, t);
    this.$addTrack.replaceChildren(
      h('option', { value: '' }, '+ Track…'),
      h('optgroup', { label: 'Animate a parameter (curve)' }, Object.entries(PARAMS).map(([k, v]) => opt(`curve:${k}`, v.label))),
      h('optgroup', { label: 'Drive a story beat (clip)' }, Object.entries(DRIVERS).map(([k, v]) => opt(`clip:${k}`, v))),
      ...(this.tl.tracks.some((t) => t.type === 'camera') ? [] : [h('option', { value: 'camera:' }, 'Camera')]),
    );
  }

  addTrack(spec) {
    const [type, bind] = spec.split(':'), p = +this.p.toFixed(4);
    let t;
    if (type === 'curve') {
      const P = PARAMS[bind];
      t = { id: bind.replace('.', '-'), type, label: P.label.replace(/ \(.*\)/, ''), bind, keys: [{ p, v: +this.tl.param(bind, p, P.def).toFixed(4), ease: 'smooth' }] };
    } else if (type === 'clip') {
      t = { id: bind.replace('.', '-'), type, label: DRIVERS[bind].replace(/ \(.*\)/, ''), bind, a: p, b: Math.min(1, +(p + 0.1).toFixed(4)), ease: bind.startsWith('tuna.') ? 'gate' : 'smooth' };
    } else {
      t = { id: 'camera', type: 'camera', label: 'Camera', drift: 1, keys: [{ p, ...this.currentPose() }] };
    }
    this.tl.tracks.push(t);
    this.commit();
    this.select({ kind: 'track', track: t });
  }

  deleteSelection() {
    const s = this.sel, d = this.tl.data;
    if (!s || s.kind === 'object') return;
    const drop = (arr, it) => { const i = arr.indexOf(it); if (i >= 0) arr.splice(i, 1); };
    if (s.kind === 'key') drop(s.track.keys, s.item);
    else if (s.kind === 'clip') drop(s.track.clips, s.item);
    else if (s.kind === 'track') drop(d.tracks, s.track);
    else if (s.kind === 'chapter') drop(d.chapters, s.item);
    else if (s.kind === 'note') drop(d.notes, s.item);
    const back = s.kind === 'key' || s.kind === 'clip' ? { kind: 'track', track: s.track } : null;
    this.commit();
    this.select(back);
    this.toast('Deleted — Ctrl+Z to undo');
  }

  duplicate() {
    const s = this.sel, p = +this.p.toFixed(4);
    if (s?.kind === 'key') {
      const k = structuredClone(s.item);
      k.p = p;
      s.track.keys = s.track.keys.filter((x) => Math.abs(x.p - p) > 1e-4);
      s.track.keys.push(k);
      this.commit();
      this.select({ kind: 'key', track: s.track, item: k });
    } else if (s?.kind === 'clip') {
      const c = structuredClone(s.item), w = c.b - c.a;
      c.a = Math.min(p, 1 - w); c.b = c.a + w;
      s.track.clips.push(c);
      this.commit();
      this.select({ kind: 'clip', track: s.track, item: c });
    }
  }

  stepKey(dir) {
    const keys = [];
    const tracks = this.sel?.track ? [this.sel.track] : this.tl.tracks;
    for (const t of tracks) {
      if (t.keys) keys.push(...t.keys.map((k) => k.p));
      if (t.clips) for (const c of t.clips) keys.push(c.a, c.b);
      if (t.type === 'clip') keys.push(t.a, t.b);
    }
    keys.sort((a, b) => a - b);
    const next = dir > 0 ? keys.find((k) => k > this.p + 1e-5) : keys.reverse().find((k) => k < this.p - 1e-5);
    if (next !== undefined) this.setP(next);
  }

  // ------------------------------------------------------------------ play mode
  play() {
    if (this.p >= 1) this.setP(0);
    this.playing = true;
    this.playFrom = this.p;
    const { camera, controls } = this.app;
    if (this.view === 'scene') this.sceneCam = { pos: camera.position.clone(), target: controls.target.clone() };
    if (this.maxOnPlay) this.$root.classList.add('max');
    this.app.controls.enabled = false;
    this.layoutStage();
    this.syncButtons();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.$root.classList.remove('max');
    const { camera, controls } = this.app;
    if (this.view === 'scene' && this.sceneCam) { camera.position.copy(this.sceneCam.pos); controls.target.copy(this.sceneCam.target); }
    this.setView(this.view);
    this.syncButtons();
  }

  stop() {
    if (!this.playing) return;
    this.pause();
    this.setP(this.playFrom);
  }

  // ------------------------------------------------------------------ per frame
  preUpdate(rdt) {
    if (this.playing) {
      this.setP(this.p + rdt / (this.tl.meta.playDuration || 60));
      if (this.p >= 1) this.pause();
    }
    this.story.forceP = this.p;
    // performance lane: fps at this point of the story (after a warm-up)
    if (rdt > 0 && performance.now() - this.born > 4000 && !document.hidden) {
      const fps = 1 / rdt, i = Math.min(this.perf.length - 1, Math.floor(this.p * this.perf.length));
      this.perf[i] = this.perf[i] ? this.perf[i] * 0.85 + fps * 0.15 : fps;
    }
  }

  postUpdate() {
    this.gizmos.update();
    this.timeline.draw();
    const now = performance.now();
    if (now - (this.lastUi || 0) > 120) {
      this.lastUi = now;
      const tl = this.tl, ch = tl.chapter(this.p);
      this.$readout.innerHTML = `<b>p ${this.p.toFixed(3)}</b> · ${(this.p * (tl.meta.playDuration || 60)).toFixed(1)} s / ${tl.meta.playDuration || 60} s${ch ? ` · <b>${ch.name}</b>` : ''}`;
      if (document.activeElement !== this.$pInput) this.$pInput.value = this.p.toFixed(3);
      const { fps, res } = this.app.fpsInfo;
      this.$fps.innerHTML = `<span style="color:${fps >= 55 ? 'var(--good)' : fps >= 40 ? 'var(--warn)' : 'var(--bad)'}">${Math.round(fps)} fps</span> · ${Math.round(res * 100)}%`;
      this.$badge.textContent = this.playing ? '▶ Playing' : this.view === 'scene' ? 'Scene' : 'Game';
      this.$badge.className = this.playing ? 'play' : '';
      this.inspector.refresh();
    }
  }

  syncButtons() {
    this.$play.replaceChildren(icon(this.playing ? 'pause' : 'play'));
    this.$play.classList.toggle('on', this.playing);
    this.$undo.disabled = this.hi <= 0;
    this.$redo.disabled = this.hi >= this.history.length - 1;
    this.$save.classList.toggle('dirty', this.history[this.hi] !== this.saved);
  }

  // ------------------------------------------------------------------ keyboard
  bindKeys() {
    addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.code === 'KeyS') { e.preventDefault(); this.save(); return; }
      if (typing) return;
      if (mod && e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
      if (mod && e.code === 'KeyY') { e.preventDefault(); this.redo(); return; }
      if (mod && e.code === 'KeyD') { e.preventDefault(); this.duplicate(); return; }
      if (mod) return;
      const step = e.shiftKey ? 0.01 : 0.001;
      switch (e.code) {
        case 'Space': e.preventDefault(); this.playing ? this.pause() : this.play(); break;
        case 'Escape': if (this.playing) this.stop(); else this.select(null); break;
        case 'Home': this.pause(); this.setP(0); break;
        case 'End': this.pause(); this.setP(1); break;
        case 'ArrowLeft': e.preventDefault(); this.pause(); this.setP(this.p - step); break;
        case 'ArrowRight': e.preventDefault(); this.pause(); this.setP(this.p + step); break;
        case 'Comma': this.pause(); this.stepKey(-1); break;
        case 'Period': this.pause(); this.stepKey(1); break;
        case 'KeyK': this.addKey(); break;
        case 'Delete': case 'Backspace': e.preventDefault(); this.deleteSelection(); break;
        case 'Digit1': this.setView('scene'); break;
        case 'Digit2': this.setView('game'); break;
        case 'KeyF': this.timeline.fit(); break;
        default:
      }
    });
  }

  // ------------------------------------------------------------------ save / drafts
  async ping() {
    try {
      const r = await fetch('./__editor/ping', { cache: 'no-store' });
      this.server = r.ok && (await r.json()).save === true;
    } catch { this.server = false; }
    this.$save.title = this.server ? 'Save story.json (Ctrl+S)' : 'No editor server: Save downloads story.json — start the editor with “Open Editor” to save in place';
  }

  async save() {
    const text = this.tl.serialize();
    const done = (msg) => {
      this.saved = text;
      try { localStorage.removeItem(DRAFT_KEY); } catch { /* storage unavailable */ }
      this.syncButtons();
      this.toast(msg);
    };
    if (this.server !== false) {
      try {
        const r = await fetch('./__editor/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text });
        if (r.ok) return done('Saved story.json');
        this.toast(`Save failed: ${(await r.json().catch(() => ({}))).error || r.status}`, true);
        return;
      } catch { this.server = false; }
    }
    if (window.showSaveFilePicker) {
      try {
        this.fileHandle ??= await window.showSaveFilePicker({ suggestedName: 'story.json', types: [{ description: 'Story timeline', accept: { 'application/json': ['.json'] } }] });
        const w = await this.fileHandle.createWritable();
        await w.write(text);
        await w.close();
        return done(`Saved ${this.fileHandle.name}`);
      } catch (e) { if (e.name === 'AbortError') return; }
    }
    download('story.json', text);
    done('Downloaded story.json — put it in the project folder');
  }

  checkDraft() {
    let draft = null;
    try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { /* ignore */ }
    if (!draft || draft.text === this.saved) return;
    const when = new Date(draft.time).toLocaleString();
    this.toast(h('span', {}, `Unsaved changes from ${when}. `,
      btn('Restore', (e) => { this.history.push(draft.text); this.hi = this.history.length - 1; this.restore(draft.text); e.target.closest('div').remove(); }),
      ' ',
      btn('Discard', (e) => { try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ } e.target.closest('div').remove(); })), false, 0);
  }

  // ------------------------------------------------------------------ sharing
  // A precise, human + Claude readable description of the current moment.
  reference() {
    const tl = this.tl, p = this.p, d = tl.data;
    const lines = [];
    const ch = tl.chapter(p);
    lines.push(`Open Tuna — story.json @ p=${p.toFixed(3)}${ch ? ` (chapter "${ch.name}")` : ''}, ${(p * (d.meta.playDuration || 60)).toFixed(1)} s into the ${d.meta.playDuration || 60} s play`);
    const active = [];
    for (const t of tl.tracks) {
      if (t.mute) continue;
      if (t.type === 'clip') {
        const v = tl.clip(t.bind, p);
        if (t.ease === 'gate') { if (v) active.push(`${t.bind} ON (${t.a}–${t.b})`); }
        else if (p >= t.a && p <= t.b) active.push(`${t.bind} ${Math.round(v * 100)}% (${t.a}–${t.b})`);
      }
      if (t.type === 'curve') active.push(`${t.bind}=${+tl.param(t.bind, p, 0).toFixed(2)}`);
    }
    if (active.length) lines.push(`active: ${active.join(' · ')}`);
    const cam = tl.ofType('camera');
    if (cam?.keys.length) {
      const i = cam.keys.findLastIndex((k) => k.p <= p);
      const a = cam.keys[i], b = cam.keys[i + 1];
      lines.push(`camera: ${a ? `key #${i + 1} (p ${a.p})` : 'before first key'}${b ? ` → key #${i + 2} (p ${b.p})` : ''}; at [${this.story.cam.position.toArray().map((x) => x.toFixed(1)).join(', ')}] looking at [${this.story.look.toArray().map((x) => x.toFixed(1)).join(', ')}]`);
    }
    const caps = tl.captions().filter((c) => p >= c.a && p <= c.b).map((c) => `"${c.title.replace(/\n/g, ' ')}"`);
    if (caps.length) lines.push(`caption on screen: ${caps.join(', ')}`);
    const notes = d.notes.filter((n) => Math.abs(n.p - p) < 0.03 && n.text);
    if (notes.length) lines.push(`notes nearby: ${notes.map((n) => `p ${n.p}: "${n.text}"`).join(' · ')}`);
    const s = this.sel;
    if (s && s.kind !== 'object') lines.push(`selected: ${s.kind}${s.track ? ` on track "${s.track.label}"` : ''}${s.item?.p !== undefined ? ` at p ${s.item.p}` : ''}`);
    lines.push(`fps here: ${Math.round(this.app.fpsInfo.fps)} · view: ${this.view === 'scene' ? 'Scene' : `Game ${this.aspect}`} · unsaved changes: ${this.history[this.hi] !== this.saved ? 'yes' : 'no'}`);
    return lines.join('\n');
  }

  async copyRef() {
    const text = this.reference();
    try {
      await navigator.clipboard.writeText(text);
      this.toast('Reference copied — paste it to Claude with what you want changed');
    } catch {
      const ta = h('textarea', { rows: 6, cols: 60, readOnly: true, style: 'background:#111;color:#ddd;border:0' });
      ta.value = text;
      this.toast(ta, false, 15000);
      ta.select();
    }
  }

  async snapshot() {
    const blob = await this.app.capture();
    if (blob) download(`open-tuna_p${this.p.toFixed(3)}.png`, blob);
    else this.toast('Snapshot failed', true);
  }

  toast(msg, err = false, ms = 3200) {
    const el = h('div', { class: err ? 'err' : '' }, msg);
    this.$toast.append(el);
    if (ms) setTimeout(() => el.remove(), ms);
  }
}
