// Editor tools for media layers (src/layers.js): add from file / URL / HTML, drag & drop files onto the
// viewport, move / scale screen layers directly in the Game view (auto-keying when a layer has motion),
// parallax presets, and the layer right-click menu.
import * as THREE from 'three/webgpu';
import { h } from './dom.js';
import { dialog } from './menu.js';
import { evalKeys, fmtTime } from '../timeline.js';
import { kindOf, MEDIA_EXT, SCREEN_KEY, isGPU } from '../layers.js';

const r4 = (x) => Math.round(x * 1e4) / 1e4;
const r2 = (x) => Math.round(x * 100) / 100;
const ACCEPT = Object.values(MEDIA_EXT).flat().map((e) => `.${e}`).join(',');
const DEPTHS = [['Far background', 0.15], ['Background', 0.35], ['Middle', 0.7], ['Near', 1.2], ['Foreground', 2]];
// one-click looks for GPU layers (the designer can fine-tune each slider afterwards)
export const LOOKS = {
  clean: { label: 'Clean (no effects)', reveal: 'fade', distort: 0, caustic: 0, chroma: 0, glow: 0, glass: 0 },
  underwater: { label: 'Underwater card', reveal: 'dissolve', distort: 0.22, caustic: 0.45, chroma: 0.25, glow: 0, glass: 0.9 },
  liquid: { label: 'Liquid reveal', reveal: 'ripple', distort: 0.45, caustic: 0.2, chroma: 0.45, glow: 0.12, glass: 0 },
  glow: { label: 'Glowing', reveal: 'dissolve', distort: 0.12, caustic: 0.3, chroma: 0.2, glow: 0.6, glass: 0 },
  wipe: { label: 'Current wipe', reveal: 'wipe', distort: 0.3, caustic: 0.25, chroma: 0.35, glow: 0.05, glass: 0 },
};
const HTML_SAMPLE = `<div style="text-align:center">
  <h2 style="font-family:'Cormorant Garamond',serif;font-weight:500;font-size:4cqw;margin:0">Your title</h2>
  <p style="letter-spacing:.3em;text-transform:uppercase;font-size:.8em;opacity:.8">Your text</p>
</div>`;

export class LayerTools {
  constructor(ed) {
    this.ed = ed;
    this.layers = ed.app.layers;
    this.layers.editing = true;
    this.root = document.getElementById('captions');
    this.handle = h('div', { class: 'ed-handle', title: 'Drag to scale' });
    this.box = h('div', { class: 'ed-gbox' }); // selection box for GPU layers (they have no element of their own)
    this.root.append(this.box);
    this.bindPicking();
    this.bindDrop();
  }

  // ------------------------------------------------------------------ adding
  addItems() {
    return [
      { label: 'Text with shader effects', onClick: () => this.add({ kind: 'text', label: 'Headline' }) },
      { label: 'Glass panel (refracts the scene)', onClick: () => this.add({ kind: 'glass', label: 'Glass panel' }) },
      { label: 'Image or video from file…', onClick: () => this.fromFile('screen') },
      { label: '3D model (.glb) from file…', onClick: () => this.fromFile('world', '.glb,.gltf') },
      { label: 'Image / video / page from a URL…', onClick: () => this.fromUrl() },
      { label: 'Web page (iframe)…', onClick: () => this.fromUrl('iframe') },
      { label: 'HTML / text / button block', onClick: () => this.add({ kind: 'html', html: HTML_SAMPLE, label: 'HTML block' }) },
      '-',
      { label: 'In the 3D world: image or video from file…', onClick: () => this.fromFile('world') },
      '-',
      { label: 'Tip: drag files from your computer onto the viewport', disabled: true },
    ];
  }

  async fromFile(space, accept) {
    const f = await this.ed.saves.pickFile(accept ?? (space === 'world' ? '.png,.jpg,.jpeg,.webp,.gif,.avif,.mp4,.webm,.mov,.m4v,.glb,.gltf' : ACCEPT));
    if (f) await this.addFile(f, { space });
  }

  async addFile(file, opts = {}) {
    if (/\.tuna$/i.test(file.name)) { this.ed.project.openTuna(file); return null; } // a project file: open it
    const kind = kindOf(file.name);
    if (!kind) return this.ed.toast(`Can't use ${file.name} — images, videos, .glb models or .html pages only`, true);
    try {
      this.ed.toast(`Adding ${file.name}…`);
      const src = await this.ed.saves.upload(file);
      const space = kind === 'iframe' ? 'screen' : kind === 'model' ? 'world' : opts.space || 'screen';
      const t = this.add({ kind, src, label: file.name.replace(/\.[^.]+$/, ''), ...opts, space });
      this.ed.assets?.refresh();
      return t;
    } catch (e) { this.ed.toast(e.message, true, 6000); }
  }

  fromUrl(forceKind) {
    const input = h('input', { type: 'text', placeholder: forceKind === 'iframe' ? 'https://example.com  or  assets/page.html' : 'https://…/picture.jpg  or  assets/clip.mp4' });
    const go = () => {
      const src = input.value.trim();
      if (!src) return false;
      const kind = forceKind || kindOf(src) || 'iframe';
      this.add({ kind, src, label: src.split('/').pop().split('?')[0] || kind });
      return true;
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && go()) d.close(); });
    const d = dialog({
      title: forceKind === 'iframe' ? 'Add a web page' : 'Add from a URL',
      body: [h('label', { class: 'lbl' }, 'Address', input),
        h('p', { class: 'muted' }, forceKind === 'iframe'
          ? 'Shown in a frame over the scene. Some sites refuse to be framed — your own pages in assets/ always work. Turn on “Clickable” in the inspector to let visitors use it.'
          : 'Images and videos from other websites only show if that site allows it; uploading the file (drag it onto the viewport) is safer.')],
      buttons: [{ label: 'Cancel' }, { label: 'Add', primary: true, onClick: go }],
    });
  }

  // create a layer at the playhead, visible for 8 s
  add({ kind, src = '', html, label, space = 'screen', x = 50, y = 50, pos, lane, at }) {
    const ed = this.ed, D = ed.duration;
    const a = r4(Math.min(at ?? ed.time, Math.max(0, D - 0.5))), b = r4(Math.min(D, a + 8));
    const world = space === 'world';
    const key = kind === 'model' ? { t: a, pos: (pos ?? this.worldSpot()).map(r2), rot: [0, 0, 0], s: 1, o: 1 }
      : world ? { t: a, pos: (pos ?? this.worldSpot()).map(r2), s: 1, r: 0, o: 1 } : { t: a, x: r2(x), y: r2(y), s: 1, r: 0, o: 1 };
    const id = `layer-${Date.now().toString(36)}`;
    const t = { id, type: 'layer', label: label || kind, kind, src, space, a, b, fade: 0.6, z: 5, w: world ? 8 : kind === 'html' ? 40 : 30, keys: [key] };
    if (kind === 'html') t.html = html ?? HTML_SAMPLE;
    // images, videos, text and glass render in the scene with shader effects by default
    if (kind === 'image' || kind === 'video' || kind === 'text' || kind === 'glass') {
      if (!world) { t.render = 'gpu'; t.depth = 8; }
      const { label: _l, ...look } = LOOKS[kind === 'text' ? 'liquid' : 'underwater'];
      Object.assign(t, look);
      t.fade = 1.2;
    }
    if (kind === 'image' || kind === 'video') t.glass = 0;
    if (kind === 'text') Object.assign(t, { kicker: 'Chapter', title: 'Your headline', body: '', w: 60, size: 180, glass: 0 });
    if (kind === 'glass') Object.assign(t, { w: 30, h: 40, glass: 1, caustic: 0.35 });
    if (kind === 'iframe') { t.h = 50; t.w = 50; t.interactive = true; }
    if (kind === 'model') { t.w = 6; t.fade = 1; }
    if (kind === 'video') t.loop = true;
    t.lane = (lane ?? ed.defaultLane('layer', 'Layers')).id;
    ed.tl.tracks.push(t);
    ed.commit();
    ed.select({ kind: 'track', track: t });
    ed.toast(`Layer “${t.label}” added at ${fmtTime(a)} — drag it in the ${world ? 'Scene' : 'Game'} view to place it`);
    return t;
  }

  // a point in the world under the cursor (on the sea surface plane if the ray hits it, else 20 m out)
  dropPoint(e) {
    const ed = this.ed, cv = ed.app.renderer.domElement, r = cv.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), ed.app.camera);
    const d = ray.ray.direction, o = ray.ray.origin;
    const t = Math.abs(d.y) > 1e-3 ? (-4 - o.y) / d.y : -1; // a plane 4 m under the surface
    return o.clone().addScaledVector(d, t > 0 && t < 120 ? t : 20).toArray();
  }

  // where a new 3D layer goes: the Scene view's orbit target, or what the story camera looks at
  worldSpot() {
    const { controls } = this.ed.app;
    const p = this.ed.sceneView ? controls.target : this.ed.story.look;
    return [p.x, Math.max(p.y, 2), p.z];
  }

  duplicate(t) {
    const c = structuredClone(t);
    c.id = `layer-${Date.now().toString(36)}`;
    c.label = `${t.label} copy`;
    delete c.locked;
    const tracks = this.ed.tl.tracks;
    tracks.splice(tracks.indexOf(t) + 1, 0, c);
    this.ed.commit();
    this.ed.select({ kind: 'track', track: c });
  }

  async replace(t) {
    const f = await this.ed.saves.pickFile(ACCEPT);
    if (!f) return;
    try {
      const kind = kindOf(f.name);
      if (!kind) throw new Error('images, videos or .html pages only');
      t.src = await this.ed.saves.upload(f);
      t.kind = kind;
      if (kind === 'iframe') t.space = 'screen';
      this.ed.commit();
    } catch (e) { this.ed.toast(e.message, true); }
  }

  // a drop on the timeline: onto a lane (or a new lane in the group under the pointer), starting at `at`
  async dropOnTimeline(dt, at, target) {
    const ed = this.ed;
    const tuna = [...dt.files].find((f) => /\.tuna$/i.test(f.name));
    if (tuna) return ed.project.openTuna(tuna); // a project file: open it (no lane)
    let lane = target?.type === 'lane' ? target : null;
    if (!lane) lane = ed.addLane({ parent: target?.type === 'group' ? target.id : target?.parent, select: false });
    if (ed.tl.lockedTrack(lane)) return ed.toast(`“${lane.label}” is locked`, true);
    const asset = dt.getData('application/x-opentuna-asset');
    if (asset) return this.addAsset(asset, { lane, at });
    let t = at;
    for (const f of dt.files) { const made = await this.addFile(f, { lane, at: t }); if (made) t = made.b; }
  }

  // an asset already in assets/ (from the Assets tab)
  addAsset(src, opts = {}) {
    const kind = kindOf(src);
    if (!kind) return this.ed.toast(`Can't use ${src}`, true);
    return this.add({ kind, src, label: src.split('/').pop().replace(/\.[^.]+$/, ''), ...opts, space: kind === 'iframe' ? 'screen' : kind === 'model' ? 'world' : opts.space || 'screen' });
  }

  // ------------------------------------------------------------------ keys
  // the key a drag at the playhead should edit: a static layer (one key) just moves; an animated one gets a
  // key at the playhead (created from its current state — "auto-key")
  keyAt(t, create = true) {
    const ed = this.ed;
    if (!t.keys.length) t.keys.push({ t: r4(t.a), ...(t.space === 'world' ? { pos: this.worldSpot(), s: 1, r: 0, o: 1 } : { ...SCREEN_KEY }) });
    if (t.keys.length === 1) return t.keys[0];
    let k = t.keys.find((q) => Math.abs(q.t - ed.time) < 1 / 60);
    if (!k && create) {
      const v = evalKeys(t.keys, ed.time, {});
      k = { t: r4(ed.time), ...Object.fromEntries(Object.entries(v).map(([f, x]) => [f, Array.isArray(x) ? x.map(r2) : r4(x)])), ease: 'smooth' };
      t.keys.push(k);
      ed.changed();
      ed.toast(`Key added to “${t.label}” at ${fmtTime(ed.time)}`);
    }
    return k?.locked ? null : k;
  }

  addKey(t) {
    const ed = this.ed;
    if (t.locked) return ed.toast(`“${t.label}” is locked`, true);
    const v = evalKeys(t.keys, ed.time, {});
    let k = t.keys.find((q) => Math.abs(q.t - ed.time) < 1e-3);
    if (!k) { k = { t: r4(ed.time), ...v, ease: 'smooth' }; t.keys.push(k); }
    ed.commit();
    ed.select({ kind: 'key', track: t, item: k });
  }

  // parallax: the layer drifts across the screen over its whole clip; slower = further away
  parallaxDialog(t) {
    const ed = this.ed;
    if (t.space === 'world') return ed.toast('3D layers get parallax for free from the camera move — this is for screen layers', true);
    const dir = h('select', {}, [['up', 'Up (as you scroll down)'], ['down', 'Down'], ['left', 'Left'], ['right', 'Right']].map(([v, l]) => h('option', { value: v }, l)));
    const depth = h('select', {}, DEPTHS.map(([l, v]) => h('option', { value: String(v) }, `${l} — ${Math.round(v * 100)}% of the screen`)));
    depth.value = '0.7';
    const apply = () => {
      const k0 = evalKeys(t.keys, t.a, { ...SCREEN_KEY });
      const dist = +depth.value * 100, d = dir.value;
      const dx = d === 'left' ? -dist : d === 'right' ? dist : 0, dy = d === 'up' ? -dist : d === 'down' ? dist : 0;
      const base = { s: r4(k0.s), r: r4(k0.r), o: r4(k0.o) };
      t.keys = [
        { t: t.a, x: r2(k0.x - dx / 2), y: r2(k0.y - dy / 2), ...base, ease: 'linear' },
        { t: t.b, x: r2(k0.x + dx / 2), y: r2(k0.y + dy / 2), ...base, ease: 'linear' },
      ];
      ed.commit();
      ed.toast(`Parallax: “${t.label}” moves ${Math.round(dist)}% of the screen ${d} over ${fmtTime(t.b - t.a)}`);
    };
    dialog({
      title: `Parallax — ${t.label}`,
      body: [
        h('label', { class: 'lbl' }, 'Direction', dir),
        h('label', { class: 'lbl' }, 'Depth (how far it travels over the clip)', depth),
        h('p', { class: 'muted' }, 'Replaces this layer’s keys with a steady drift from start to end, centred where it is now. Give several layers different depths for a parallax stack: far layers move little, foreground layers a lot. The clip length sets the speed — longer clip, slower drift.'),
      ],
      buttons: [{ label: 'Cancel' }, { label: 'Apply', primary: true, onClick: apply }],
    });
  }

  applyLook(t, key) {
    if (t.locked) return this.ed.toast(`“${t.label}” is locked`, true);
    const { label, ...look } = LOOKS[key];
    Object.assign(t, look);
    if (t.kind === 'glass') t.glass = 1;
    else if (t.kind !== 'image' && t.kind !== 'video') t.glass = 0;
    if ((t.kind === 'image' || t.kind === 'video') && t.space !== 'world') t.render = 'gpu';
    this.ed.commit();
    this.ed.toast(`Look: ${label}`);
  }

  // ------------------------------------------------------------------ menus
  contextItems(t) {
    const ed = this.ed, L = !!t.locked, world = t.space === 'world';
    const canFx = t.kind !== 'html' && t.kind !== 'iframe' && t.kind !== 'model';
    return [
      canFx ? { label: 'Look', disabled: L, items: Object.entries(LOOKS).map(([k, v]) => ({ label: v.label, onClick: () => this.applyLook(t, k) })) } : null,
      { label: `Go to start (${fmtTime(t.a)})`, onClick: () => ed.setTime(t.a) },
      { label: `Add key at playhead (${fmtTime(ed.time)})`, shortcut: 'K', disabled: L, onClick: () => this.addKey(t) },
      { label: 'Make parallax…', disabled: L || world, onClick: () => this.parallaxDialog(t) },
      t.kind === 'model' ? { label: 'Show in Scene view', onClick: () => { ed.select({ kind: 'track', track: t }); ed.setView('scene'); const k = this.layers.state(t, ed.time); ed.app.controls.target.fromArray(k.pos); } } : null,
      { label: `Set start to playhead`, disabled: L || ed.time >= t.b, onClick: () => { t.a = r4(ed.time); ed.commit(); } },
      { label: `Set end to playhead`, disabled: L || ed.time <= t.a, onClick: () => { t.b = r4(ed.time); ed.commit(); } },
      '-',
      { label: 'Bring forward', disabled: L || world, onClick: () => { t.z = (t.z ?? 5) + 1; ed.commit(); } },
      { label: 'Send backward', disabled: L || world, onClick: () => { t.z = (t.z ?? 5) - 1; ed.commit(); } },
      t.kind !== 'html' ? { label: 'Replace file…', disabled: L, onClick: () => this.replace(t) } : null,
      t.src ? { label: 'Open source ↗', onClick: () => window.open(t.src, '_blank') } : null,
      { label: 'Duplicate layer', onClick: () => this.duplicate(t) },
      ed.laneMenu(t),
      '-',
      { label: t.mute ? 'Show (unmute)' : 'Hide (mute)', onClick: () => { if (t.mute) delete t.mute; else t.mute = true; ed.commit(); } },
      { label: L ? 'Unlock' : 'Lock', shortcut: 'L', onClick: () => { ed.select({ kind: 'track', track: t }); ed.toggleLock(); } },
      { label: 'Delete layer', danger: true, disabled: L, onClick: () => { ed.select({ kind: 'track', track: t }); ed.deleteSelection(); } },
    ];
  }

  // ------------------------------------------------------------------ Game view: pick, move, scale
  selected() {
    const s = this.ed.sel;
    return s?.track?.type === 'layer' ? s.track : null;
  }

  // GPU screen layers under a point (% of the view), topmost first
  gpuAt(px, py) {
    const ed = this.ed, cam = ed.story.cam, out = [];
    for (const t of ed.tl.layers()) {
      if (!isGPU(t) || t.space === 'world') continue;
      const k = this.layers.state(t, ed.time);
      if (k.f <= 0.002) continue;
      const r = this.layers.rect(t, k, cam.aspect);
      if (Math.abs(px - r.x) <= r.w / 2 && Math.abs(py - r.y) <= r.h / 2) out.push(t);
    }
    return out.sort((a, b) => (a.depth ?? 8) - (b.depth ?? 8)); // nearest first
  }

  bindPicking() {
    const ed = this.ed;
    const pct = (e) => { const s = this.root.getBoundingClientRect(); return [((e.clientX - s.left) / s.width) * 100, ((e.clientY - s.top) / s.height) * 100]; };
    // GPU layers: hit-test by rectangle (capture phase on the stage, before the canvas sees the click)
    ed.$stage.addEventListener('pointerdown', (e) => {
      if (!this.layers.pickable || e.button !== 0 || e.target.closest?.('.layer') || e.target.closest?.('#ed-scrollbar')) return;
      const handle = e.target === this.handle && this.box.contains(this.handle);
      const t = handle ? this.selected() : this.gpuAt(...pct(e))[0];
      if (!t) return;
      this.startDrag(e, t, handle);
    }, true);
    ed.$stage.addEventListener('contextmenu', (e) => {
      if (!this.layers.pickable || e.target.closest?.('.layer')) return;
      const t = this.gpuAt(...pct(e))[0];
      if (!t) return;
      e.preventDefault();
      e.stopPropagation();
      ed.contextMenu(e.clientX, e.clientY, { kind: 'layer', track: t });
    }, true);
    this.root.addEventListener('pointerdown', (e) => {
      const el = e.target.closest?.('.layer');
      if (!el || !this.layers.pickable || e.button !== 0) return;
      const t = ed.tl.layers().find((q) => q.id === el.dataset.id);
      if (t) this.startDrag(e, t, e.target === this.handle);
    }, true);
    this.root.addEventListener('contextmenu', (e) => {
      const el = e.target.closest?.('.layer');
      if (!el || !this.layers.pickable) return;
      const t = ed.tl.layers().find((q) => q.id === el.dataset.id);
      if (!t) return;
      e.preventDefault();
      ed.contextMenu(e.clientX, e.clientY, { kind: 'layer', track: t });
    });
  }

  // move (or, from the corner handle, scale) a screen layer; auto-keys an animated layer at the playhead
  startDrag(e, t, scaling) {
    const ed = this.ed;
    e.preventDefault();
    e.stopPropagation();
    if (this.selected() !== t) ed.select({ kind: 'track', track: t });
    if (ed.isLocked({ kind: 'track', track: t })) return ed.toast('Locked — right-click ▸ Unlock to move it', true);
    {
      const stage = this.root.getBoundingClientRect();
      const k0 = this.layers.state(t, ed.time);
      const r = isGPU(t) ? this.layers.rect(t, k0, ed.story.cam.aspect) : null;
      const cx = r ? stage.left + (r.x / 100) * stage.width : 0, cy = r ? stage.top + (r.y / 100) * stage.height : 0;
      const el = r ? null : this.layers.item(t.id)?.el;
      const er = el?.getBoundingClientRect();
      const ccx = el ? er.left + er.width / 2 : cx, ccy = el ? er.top + er.height / 2 : cy;
      let k = null, x0, y0, s0, d0;
      const start = () => {
        k = this.keyAt(t);
        if (!k) return false;
        x0 = k.x; y0 = k.y; s0 = k.s ?? 1; d0 = Math.max(8, Math.hypot(e.clientX - ccx, e.clientY - ccy));
        return true;
      };
      let moved = false;
      const move = (ev) => {
        if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 3) return;
        if (!moved) { moved = true; if (!start()) { up(); return ed.toast('That key is locked', true); } }
        if (scaling) k.s = r4(Math.max(0.05, s0 * (Math.hypot(ev.clientX - ccx, ev.clientY - ccy) / d0)));
        else {
          k.x = r2(x0 + ((ev.clientX - e.clientX) / stage.width) * 100);
          k.y = r2(y0 + ((ev.clientY - e.clientY) / stage.height) * 100);
        }
        ed.changed();
      };
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        if (moved) ed.commit();
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    }
  }

  bindDrop() {
    const ed = this.ed, wrap = ed.$wrap;
    wrap.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].some((ty) => ty === 'Files' || ty === 'application/x-opentuna-asset')) { e.preventDefault(); wrap.classList.add('drop'); } });
    wrap.addEventListener('dragleave', () => wrap.classList.remove('drop'));
    wrap.addEventListener('drop', async (e) => {
      e.preventDefault();
      wrap.classList.remove('drop');
      const r = ed.$stage.getBoundingClientRect();
      const x = Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)), y = Math.min(100, Math.max(0, ((e.clientY - r.top) / r.height) * 100));
      const where = ed.sceneView ? { space: 'world', pos: this.dropPoint(e) } : { x, y };
      const asset = e.dataTransfer.getData('application/x-opentuna-asset');
      if (asset) return this.addAsset(asset, where);
      for (const f of e.dataTransfer.files) await this.addFile(f, where);
    });
  }

  // per frame (editor)
  update() {
    const ed = this.ed, pick = ed.view === 'game' && !ed.playing;
    this.layers.pickable = pick;
    this.layers.editing = !ed.playing; // while playing, clickable layers work like on the website
    this.root.classList.toggle('ed-pick', pick);
    const t = this.selected(), it = t && t.space !== 'world' ? this.layers.item(t.id) : null;
    for (const x of this.layers.items.values()) x.el?.classList.toggle('ed-sel', x === it && pick);
    const k = t && this.layers.state(t, ed.time);
    const gpuSel = it?.gpu && pick && k.f > 0.002;
    this.box.style.display = gpuSel ? 'block' : 'none';
    if (gpuSel) {
      const r = this.layers.rect(t, k, ed.story.cam.aspect);
      Object.assign(this.box.style, { left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%`, transform: `translate(-50%, -50%) rotate(${k.r}deg)` });
    }
    const host = gpuSel ? this.box : it?.el && pick ? it.el : null;
    if (host && !t.locked) { if (this.handle.parentNode !== host) host.append(this.handle); } else this.handle.remove();
  }

  reference(x) {
    const out = [];
    for (const t of this.ed.tl.layers()) {
      const k = this.layers.state(t, x);
      if (k.o <= 0.01) continue;
      const where = t.space === 'world' ? `3D at [${k.pos.map((v) => v.toFixed(1)).join(', ')}]${k.rot ? ` rot [${k.rot.map((v) => v.toFixed(0)).join(', ')}]°` : ''}` : `screen x ${k.x.toFixed(0)}% y ${k.y.toFixed(0)}%`;
      out.push(`"${t.label}" (${t.kind}${t.src ? ` ${t.src}` : ''}, ${where}, scale ${k.s.toFixed(2)}, opacity ${k.o.toFixed(2)}, ${t.a}–${t.b} s)`);
    }
    return out.length ? `layers on screen: ${out.join(' · ')}` : '';
  }
}
