// Editor tools for media layers (src/layers.js): add from file / URL / HTML, drag & drop files onto the
// viewport, move / scale screen layers directly in the Game view (auto-keying when a layer has motion),
// parallax presets, and the layer right-click menu.
import { h } from './dom.js';
import { dialog } from './menu.js';
import { evalKeys, fmtTime } from '../timeline.js';
import { kindOf, MEDIA_EXT, SCREEN_KEY } from '../layers.js';

const r4 = (x) => Math.round(x * 1e4) / 1e4;
const r2 = (x) => Math.round(x * 100) / 100;
const ACCEPT = Object.values(MEDIA_EXT).flat().map((e) => `.${e}`).join(',');
const DEPTHS = [['Far background', 0.15], ['Background', 0.35], ['Middle', 0.7], ['Near', 1.2], ['Foreground', 2]];
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
    this.bindPicking();
    this.bindDrop();
  }

  // ------------------------------------------------------------------ adding
  addItems() {
    return [
      { label: 'Image or video from file…', onClick: () => this.fromFile('screen') },
      { label: 'Image / video / page from a URL…', onClick: () => this.fromUrl() },
      { label: 'Web page (iframe)…', onClick: () => this.fromUrl('iframe') },
      { label: 'HTML / text / button block', onClick: () => this.add({ kind: 'html', html: HTML_SAMPLE, label: 'HTML block' }) },
      '-',
      { label: 'In the 3D world: image or video from file…', onClick: () => this.fromFile('world') },
      '-',
      { label: 'Tip: drag files from your computer onto the viewport', disabled: true },
    ];
  }

  async fromFile(space) {
    const f = await this.ed.saves.pickFile(space === 'world' ? '.png,.jpg,.jpeg,.webp,.gif,.avif,.mp4,.webm,.mov,.m4v' : ACCEPT);
    if (f) await this.addFile(f, { space });
  }

  async addFile(file, opts = {}) {
    const kind = kindOf(file.name);
    if (!kind) return this.ed.toast(`Can't use ${file.name} — images, videos or .html pages only`, true);
    try {
      this.ed.toast(`Adding ${file.name}…`);
      const src = await this.ed.saves.upload(file);
      const space = kind === 'iframe' ? 'screen' : opts.space || 'screen';
      this.add({ kind, src, label: file.name.replace(/\.[^.]+$/, ''), ...opts, space });
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
  add({ kind, src = '', html, label, space = 'screen', x = 50, y = 50, pos }) {
    const ed = this.ed, D = ed.duration;
    const a = r4(Math.min(ed.time, Math.max(0, D - 0.5))), b = r4(Math.min(D, a + 8));
    const world = space === 'world';
    const key = world ? { t: a, pos: (pos ?? this.worldSpot()).map(r2), s: 1, r: 0, o: 1 } : { t: a, x: r2(x), y: r2(y), s: 1, r: 0, o: 1 };
    const id = `layer-${Date.now().toString(36)}`;
    const t = { id, type: 'layer', label: label || kind, kind, src, space, a, b, fade: 0.6, z: 5, w: world ? 8 : kind === 'html' ? 40 : 30, keys: [key] };
    if (kind === 'html') t.html = html ?? HTML_SAMPLE;
    if (kind === 'iframe') { t.h = 50; t.w = 50; t.interactive = true; }
    if (kind === 'video') t.loop = true;
    const tracks = ed.tl.tracks, ci = tracks.findIndex((q) => q.type === 'captions');
    tracks.splice(ci >= 0 ? ci + 1 : tracks.length, 0, t);
    ed.commit();
    ed.select({ kind: 'track', track: t });
    ed.toast(`Layer “${t.label}” added at ${fmtTime(a)} — drag it in the ${world ? 'Scene' : 'Game'} view to place it`);
    return t;
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

  // ------------------------------------------------------------------ menus
  contextItems(t) {
    const ed = this.ed, L = !!t.locked, world = t.space === 'world';
    return [
      { label: `Go to start (${fmtTime(t.a)})`, onClick: () => ed.setTime(t.a) },
      { label: `Add key at playhead (${fmtTime(ed.time)})`, shortcut: 'K', disabled: L, onClick: () => this.addKey(t) },
      { label: 'Make parallax…', disabled: L || world, onClick: () => this.parallaxDialog(t) },
      { label: `Set start to playhead`, disabled: L || ed.time >= t.b, onClick: () => { t.a = r4(ed.time); ed.commit(); } },
      { label: `Set end to playhead`, disabled: L || ed.time <= t.a, onClick: () => { t.b = r4(ed.time); ed.commit(); } },
      '-',
      { label: 'Bring forward', disabled: L || world, onClick: () => { t.z = (t.z ?? 5) + 1; ed.commit(); } },
      { label: 'Send backward', disabled: L || world, onClick: () => { t.z = (t.z ?? 5) - 1; ed.commit(); } },
      t.kind !== 'html' ? { label: 'Replace file…', disabled: L, onClick: () => this.replace(t) } : null,
      t.src ? { label: 'Open source ↗', onClick: () => window.open(t.src, '_blank') } : null,
      { label: 'Duplicate layer', onClick: () => this.duplicate(t) },
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

  bindPicking() {
    const ed = this.ed;
    this.root.addEventListener('pointerdown', (e) => {
      const el = e.target.closest?.('.layer');
      if (!el || !this.layers.pickable || e.button !== 0) return;
      const t = ed.tl.layers().find((q) => q.id === el.dataset.id);
      if (!t) return;
      e.preventDefault();
      e.stopPropagation();
      if (this.selected() !== t) ed.select({ kind: 'track', track: t });
      if (ed.isLocked({ kind: 'track', track: t })) return ed.toast('Locked — right-click ▸ Unlock to move it', true);
      const stage = this.root.getBoundingClientRect();
      const scaling = e.target === this.handle;
      const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      let k = null, x0, y0, s0, d0;
      const start = () => {
        k = this.keyAt(t);
        if (!k) return false;
        x0 = k.x; y0 = k.y; s0 = k.s ?? 1; d0 = Math.max(8, Math.hypot(e.clientX - cx, e.clientY - cy));
        return true;
      };
      let moved = false;
      const move = (ev) => {
        if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 3) return;
        if (!moved) { moved = true; if (!start()) { up(); return ed.toast('That key is locked', true); } }
        if (scaling) k.s = r4(Math.max(0.05, s0 * (Math.hypot(ev.clientX - cx, ev.clientY - cy) / d0)));
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

  bindDrop() {
    const ed = this.ed, wrap = ed.$wrap;
    wrap.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); wrap.classList.add('drop'); } });
    wrap.addEventListener('dragleave', () => wrap.classList.remove('drop'));
    wrap.addEventListener('drop', async (e) => {
      e.preventDefault();
      wrap.classList.remove('drop');
      const r = ed.$stage.getBoundingClientRect();
      const x = Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)), y = Math.min(100, Math.max(0, ((e.clientY - r.top) / r.height) * 100));
      for (const f of e.dataTransfer.files) await this.addFile(f, ed.sceneView ? { space: 'world' } : { x, y });
    });
  }

  // per frame (editor)
  update() {
    const ed = this.ed, pick = ed.view === 'game' && !ed.playing;
    this.layers.pickable = pick;
    this.root.classList.toggle('ed-pick', pick);
    const t = this.selected(), it = t && !t.space?.startsWith('w') ? this.layers.item(t.id) : null;
    for (const x of this.layers.items.values()) x.el?.classList.toggle('ed-sel', x === it && pick);
    if (it?.el && pick && !t.locked) { if (this.handle.parentNode !== it.el) it.el.append(this.handle); } else this.handle.remove();
  }

  reference(x) {
    const out = [];
    for (const t of this.ed.tl.layers()) {
      const k = this.layers.state(t, x);
      if (k.o <= 0.01) continue;
      const where = t.space === 'world' ? `3D at [${k.pos.map((v) => v.toFixed(1)).join(', ')}]` : `screen x ${k.x.toFixed(0)}% y ${k.y.toFixed(0)}%`;
      out.push(`"${t.label}" (${t.kind}${t.src ? ` ${t.src}` : ''}, ${where}, scale ${k.s.toFixed(2)}, opacity ${k.o.toFixed(2)}, ${t.a}–${t.b} s)`);
    }
    return out.length ? `layers on screen: ${out.join(' · ')}` : '';
  }
}
