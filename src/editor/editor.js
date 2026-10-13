// Open Tuna editor (?edit): a Unity-style shell around the story.
//   top bar   menus (File / Edit / View / Help) · transport (start, Play/Pause, Stop, speed) · big Scene | Game
//             switch · time readout · save status · Copy ref · fps · Save
//   left      outliner: scene objects (hide / solo / focus) and post effects
//   centre    viewport: Game (the story camera, captions, aspect frame) or Scene (free camera, camera gizmos);
//             the frame colour says which (blue Scene, green Game, orange Playing)
//   right     inspector for the selection
//   bottom    timeline of story.json in story time (seconds; the story length can be extended)
// Right-click anything for its options. Locked items (track / key / clip / marker `locked: true`) can't be
// moved, edited or deleted. Saving, autosave, checkpoints, restore and git live in saves.js.
import * as THREE from 'three/webgpu';
import { h, btn, icon, download } from './dom.js';
import { openMenu, dialog } from './menu.js';
import { Inspector } from './inspector.js';
import { TimelineView } from './timeline-view.js';
import { SceneGizmos } from './scene-gizmos.js';
import { Saves } from './saves.js';
import { LayerTools } from './layer-tools.js';
import { AssetsPanel } from './assets-panel.js';
import { PARAMS, DRIVERS, ACTORS } from '../story.js';
import { EASES, fmtTime, migrate } from '../timeline.js';

const ASPECTS = { '16:9': 16 / 9, '16:10': 16 / 10, '21:9': 21 / 9, '4:3': 4 / 3, '9:19.5': 9 / 19.5, free: 0 };
const CLIP_KEY = 'openTuna.clipboard.v2';
const PERF_STEP = 0.5; // s per fps bucket
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const isMac = /Mac/.test(navigator.platform);
const mod = isMac ? '⌘' : 'Ctrl+';

export class Editor {
  constructor(app) {
    this.app = app;
    this.tl = app.timeline;
    this.story = app.story;
    this.time = 0; // playhead (s)
    this.playing = false;
    this.playFrom = 0;
    this.speed = 1; // auto-play speed
    this.playMode = 'site'; // 'site' = scroll it like the website, 'auto' = runs by itself
    this.scrollT = 0; // site play: where the (virtual) scroll wants the story to be
    this.view = 'game';
    this.aspect = '16:9';
    this.maxOnPlay = false;
    this.snap = true;
    this.sel = null;
    this.perf = new Float32Array(Math.ceil(this.tl.duration / PERF_STEP) + 1); // fps measured along the story
    this.born = performance.now();
    this.history = [this.tl.serialize()];
    this.hi = 0;
    this.sceneCam = null; // remembered Scene view pose
    try { this.clipboard = JSON.parse(localStorage.getItem(CLIP_KEY) || 'null'); } catch { this.clipboard = null; }

    document.head.append(h('link', { rel: 'stylesheet', href: new URL('./editor.css', import.meta.url).href }));
    this.saves = new Saves(this);
    this.buildDOM();
    this.inspector = new Inspector(this, this.$right);
    this.timeline = new TimelineView(this, this.$tlwrap);
    this.gizmos = new SceneGizmos(this);
    this.lt = new LayerTools(this);
    this.assets = new AssetsPanel(this, this.$assets);
    this.buildOutliner();
    this.bindKeys();
    this.setView('game');
    this.select(null);
    this.setTime(0);
    this.saves.ping();
    this.saves.checkDraft();
    setInterval(() => this.saves.tick(), 1000);
    addEventListener('beforeunload', (e) => { if (this.saves.dirty && !this.saves.autosave) { e.preventDefault(); e.returnValue = ''; } });
  }

  get sceneView() { return this.view === 'scene' && !this.playing; }
  get duration() { return this.tl.duration; }
  current() { return this.tl.serialize(); }

  // ------------------------------------------------------------------ layout
  buildDOM() {
    const { renderer } = this.app;
    this.$play = btn('', () => (this.playing ? this.pause() : this.play('site')), { ico: 'play', title: 'Play — use it like the website: scroll / arrow keys move through the story, buttons and pages are clickable (Space)', id: 'ed-play' });
    this.$auto = btn('', () => (this.playing && this.playMode === 'auto' ? this.pause() : this.play('auto')), { ico: 'auto', title: 'Auto-play — the story runs by itself at the chosen speed' });
    this.$readout = h('div', { id: 'ed-readout' });
    this.$fps = h('div', { id: 'ed-fps' });
    this.$status = h('div', { id: 'ed-status', title: 'Save status — File menu for autosave, checkpoints and restore' });
    this.$save = btn('Save', () => this.saves.save(), { ico: 'save', title: `Save story.json (${mod}S)`, cls: 'primary' });
    this.$speed = h('select', { title: 'Auto-play speed' }, ['0.25', '0.5', '1', '2', '4', '8'].map((v) => h('option', { value: v }, `${v}×`)));
    this.$speed.value = '1';
    this.$speed.addEventListener('change', () => { this.speed = +this.$speed.value; this.$speed.blur(); });

    const menus = h('nav', { id: 'ed-menus' }, ['File', 'Edit', 'View', 'Help'].map((name) => {
      const b = h('button', { class: 'mb' }, name);
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const r = b.getBoundingClientRect();
        openMenu(r.left, r.bottom + 2, this[`menu${name}`]());
      });
      return b;
    }));

    // the big Scene | Game switch
    this.$mode = {
      scene: h('button', { class: 'm scene', onclick: () => this.setView('scene'), title: 'Scene view — free camera to look around and place camera keys (1)' },
        icon('camera'), h('span', {}, h('b', {}, 'SCENE'), h('small', {}, 'edit · free camera'))),
      game: h('button', { class: 'm game', onclick: () => this.setView('game'), title: 'Game view — exactly what a visitor sees (2)' },
        icon('play'), h('span', {}, h('b', {}, 'GAME'), h('small', {}, 'what visitors see'))),
    };

    const bar = h('header', { id: 'ed-bar' },
      h('div', { class: 'brand' }, h('b', {}, 'OPEN TUNA')),
      menus,
      h('div', { class: 'sep' }),
      btn('', () => { this.pause(); this.setTime(0); }, { ico: 'start', title: 'Go to start (Home)' }),
      this.$play,
      btn('', () => this.stop(), { ico: 'stop', title: 'Stop — back to where Play started (Esc)' }),
      this.$auto,
      this.$speed,
      h('div', { class: 'sep' }),
      h('div', { id: 'ed-mode' }, this.$mode.scene, this.$mode.game),
      this.$readout,
      h('div', { class: 'grow' }),
      this.$status,
      btn('Copy ref', () => this.copyRef(), { ico: 'copy', title: 'Copy a precise reference to this moment — paste it to Claude' }),
      this.$fps,
      this.$save,
    );

    this.$outliner = h('div');
    this.$assets = h('div', { style: 'display:none' });
    const tab = (name, el) => h('button', { class: 'ltab', onclick: (e) => {
      this.$outliner.style.display = name === 'scene' ? '' : 'none';
      this.$assets.style.display = name === 'assets' ? '' : 'none';
      e.currentTarget.parentNode.querySelectorAll('.ltab').forEach((b) => b.classList.toggle('on', b === e.currentTarget));
      if (name === 'assets') this.assets?.refresh();
    } }, el);
    const left = h('aside', { id: 'ed-left' }, h('div', { class: 'ed-h ltabs' }, tab('scene', 'Scene'), tab('assets', 'Assets')), this.$outliner, this.$assets);
    left.querySelector('.ltab').classList.add('on');

    const aspect = h('select', { title: 'Game view frame' }, Object.keys(ASPECTS).map((k) => h('option', { value: k }, k === 'free' ? 'Free aspect' : k)));
    aspect.value = this.aspect;
    aspect.addEventListener('change', () => { this.aspect = aspect.value; aspect.blur(); this.layoutStage(); });
    this.$aspect = aspect;
    this.$maxBtn = h('button', { class: 'tab', title: 'Hide the editor panels while playing' }, 'Maximize on Play');
    this.$maxBtn.addEventListener('click', () => this.toggleMax());
    this.$viewHint = h('span', { class: 'hint' });
    this.$align = h('button', { class: 'tab', title: 'Put the Scene camera where the story camera is', onclick: () => this.alignToShot() }, 'Align to shot');
    const tabs = h('div', { id: 'ed-tabs' }, aspect, this.$maxBtn, this.$align, this.$viewHint);

    this.$stage = h('div', { id: 'ed-stage' });
    this.$badge = h('div', { id: 'ed-badge' });
    this.$toast = h('div', { id: 'ed-toast' });
    this.$wrap = h('div', { id: 'ed-wrap' }, this.$stage);
    const view = h('main', { id: 'ed-view' }, tabs, this.$wrap, this.$toast);
    this.$scrollbar = h('div', { id: 'ed-scrollbar', title: 'Drag to scroll (like the browser scrollbar)' }, h('i'));
    this.$stage.append(renderer.domElement, document.getElementById('captions'), this.$badge, this.$scrollbar);
    this.bindSitePlay();

    this.$right = h('aside', { id: 'ed-right' });

    const add = (label, fn, title) => btn(label, fn, { ico: 'plus', title });
    this.$addTrack = h('select', { title: 'Add a track that animates a parameter or drives a story beat' });
    this.$addTrack.addEventListener('change', () => { const v = this.$addTrack.value; this.$addTrack.value = ''; this.$addTrack.blur(); if (v) this.addTrack(v); });
    this.$snapBtn = btn('Snap', () => this.toggleSnap(), { title: 'Snap to keys, chapters, the playhead and the grid (hold Shift to bypass)', cls: 'on' });
    this.$tInput = h('input', { type: 'text', title: 'Type a time (e.g. 1:05 or 65) and press Enter' });
    this.$tInput.addEventListener('change', () => { const v = parseTime(this.$tInput.value); if (v !== null) this.setTime(v); this.$tInput.blur(); });
    this.$len = h('button', { class: 'ed-btn', title: 'Story length — click to change, or drag the end marker on the ruler', onclick: () => this.lengthDialog() });
    const tlbar = h('div', { id: 'ed-tlbar' },
      add('Key', () => this.addKey(), 'Add a key at the playhead to the selected camera / curve track (K)'),
      add('Caption', () => this.addCaption(), 'Add a caption at the playhead'),
      add('Note', () => this.addNote(), 'Leave a note at the playhead (saved in story.json)'),
      add('Chapter', () => this.addChapter(), 'Start a new chapter at the playhead'),
      add('Lane', () => this.addLane(), 'A lane holds many layer / path clips side by side, like a video-editor track'),
      add('Group', () => this.addGroup(), 'A folder for tracks — collapse it to save space'),
      btn('Layer ▾', (e) => { const r = e.currentTarget.getBoundingClientRect(); openMenu(r.left, r.top - 4, this.lt.addItems()).style.transform = 'translateY(-100%)'; }, { ico: 'image', title: 'Add an image, video, web page or HTML block (or drag files onto the viewport)' }),
      this.$addTrack,
      h('div', { class: 'sep' }),
      this.$snapBtn,
      btn('Fit', () => { this.timeline.fit(); }, { title: 'Show the whole story (F)' }),
      this.$tInput,
      this.$len,
      h('span', { class: 'hint' }, 'Right-click anything for options · drag the ruler to scrub · Ctrl+wheel zoom · Shift+wheel pan'),
      h('div', { class: 'grow' }),
    );
    this.$tlwrap = h('div', { id: 'ed-tlwrap' });
    const split = h('div', { id: 'ed-split', title: 'Drag to resize' });
    const tlEl = h('section', { id: 'ed-tl' }, split, tlbar, this.$tlwrap);

    // side panels resize by dragging their inner edge (widths remembered per browser)
    const grip = (side) => {
      const g = h('div', { class: `ed-vsplit ${side}`, title: 'Drag to resize · double-click to reset' });
      const save = () => {
        try { localStorage.setItem('openTuna.panels', JSON.stringify({ l: this.$root.style.getPropertyValue('--left-w'), r: this.$root.style.getPropertyValue('--right-w') })); } catch { /* storage unavailable */ }
      };
      g.addEventListener('dblclick', () => { this.$root.style.removeProperty(side === 'l' ? '--left-w' : '--right-w'); save(); });
      g.addEventListener('pointerdown', (e) => {
        g.setPointerCapture(e.pointerId);
        const x0 = e.clientX, w0 = (side === 'l' ? left : this.$right).getBoundingClientRect().width;
        const mv = (ev) => {
          const w = Math.round(Math.min(innerWidth * 0.45, Math.max(160, w0 + (side === 'l' ? 1 : -1) * (ev.clientX - x0))));
          this.$root.style.setProperty(side === 'l' ? '--left-w' : '--right-w', `${w}px`);
        };
        const up = () => {
          g.removeEventListener('pointermove', mv); g.removeEventListener('pointerup', up);
          save();
        };
        g.addEventListener('pointermove', mv);
        g.addEventListener('pointerup', up);
      });
      return g;
    };
    this.$root = h('div', { id: 'ed' }, bar, left, view, this.$right, tlEl, grip('l'), grip('r'));
    try {
      const pw = JSON.parse(localStorage.getItem('openTuna.panels') || 'null');
      if (pw?.l) this.$root.style.setProperty('--left-w', pw.l);
      if (pw?.r) this.$root.style.setProperty('--right-w', pw.r);
    } catch { /* storage unavailable */ }
    document.body.append(this.$root);
    // a clicked button keeps focus and would also react to Space (play / pause)
    this.$root.addEventListener('click', (e) => e.target.closest?.('button')?.blur());
    this.$root.addEventListener('contextmenu', (e) => { if (!/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) e.preventDefault(); });

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
    let w = W - 8, hh = H - 8; // room for the coloured frame
    if (r) { if (w / hh > r) w = hh * r; else hh = w / r; }
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
    this.$align.style.display = v === 'scene' ? '' : 'none';
    this.$viewHint.textContent = v === 'scene'
      ? 'Drag orbit · right-drag pan · wheel zoom · WASD/QE fly (Shift fast) · click a ball to pick a camera key · K adds a key from this view'
      : 'The story camera — exactly what the site shows at this moment';
    this.syncMode();
    this.layoutStage();
  }

  // ------------------------------------------------------------------ site play: scroll like the website
  // px of wheel -> seconds of story: the site's page scrolls (duration · scrollPerSecond − 100) vh in total
  scrollBy(px) {
    const D = this.duration, vh = innerHeight / 100;
    const range = Math.max(1, (D * this.tl.meta.scrollPerSecond - 100) * vh);
    this.scrollT = Math.min(D, Math.max(0, this.scrollT + (px / range) * D));
  }

  bindSitePlay() {
    const site = () => this.playing && this.playMode === 'site';
    this.$stage.addEventListener('wheel', (e) => {
      if (!site()) return;
      e.preventDefault();
      this.scrollBy(e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1));
    }, { passive: false });
    // drag the page (touch-style) on the canvas
    const cv = this.app.renderer.domElement;
    cv.addEventListener('pointerdown', (e) => {
      if (!site() || e.button !== 0) return;
      let y = e.clientY;
      const mv = (ev) => { this.scrollBy(y - ev.clientY); y = ev.clientY; };
      const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); };
      addEventListener('pointermove', mv);
      addEventListener('pointerup', up);
    });
    // the scrollbar thumb
    const bar = this.$scrollbar;
    bar.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const set = (ev) => { const r = bar.getBoundingClientRect(); this.scrollT = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)) * this.duration; };
      set(e);
      const up = () => { removeEventListener('pointermove', set); removeEventListener('pointerup', up); };
      addEventListener('pointermove', set);
      addEventListener('pointerup', up);
    });
  }

  syncMode() {
    const mode = this.playing ? 'playing' : this.view;
    for (const [k, b] of Object.entries(this.$mode)) b.classList.toggle('on', k === this.view);
    this.$root.dataset.mode = mode;
    this.$stage.classList.toggle('scene', this.view === 'scene' && !this.playing);
    this.$badge.textContent = this.playing ? (this.playMode === 'site' ? '▶  PLAYING · scroll like the website' : `▶▶  AUTO-PLAY ${this.speed}×`) : this.view === 'scene' ? 'SCENE · free camera' : 'GAME · visitor view';
    this.$scrollbar.style.display = this.playing && this.playMode === 'site' ? '' : 'none';
  }

  alignToShot(keepView) {
    const { camera, controls } = this.app;
    camera.position.copy(this.story.cam.position);
    camera.quaternion.copy(this.story.cam.quaternion);
    controls.target.copy(this.story.look);
    if (!keepView) this.setView('scene');
  }

  toggleMax() { this.maxOnPlay = !this.maxOnPlay; this.$maxBtn.classList.toggle('on', this.maxOnPlay); }
  toggleSnap() { this.snap = !this.snap; this.$snapBtn.classList.toggle('on', this.snap); }

  // ------------------------------------------------------------------ menus
  menuFile() {
    const s = this.saves, A = s.autosave;
    return [
      { label: 'Save', shortcut: `${mod}S`, onClick: () => s.save() },
      { label: 'Save checkpoint…', shortcut: `${mod}⇧S`, onClick: () => s.checkpointDialog(), disabled: !s.server },
      { label: 'Open / Restore…', shortcut: `${mod}O`, onClick: () => s.openDialog() },
      { label: 'Autosave', items: [0, 30, 60, 300].map((v) => ({ label: v ? (v < 60 ? `Every ${v} s` : `Every ${v / 60} min`) : 'Off', checked: A === v, onClick: () => s.setAutosave(v) })) },
      { label: 'Revert to saved file', onClick: () => s.revert(), disabled: !s.dirty },
      '-',
      { label: 'Import story JSON…', onClick: () => s.importFile() },
      { label: 'Export / download story JSON', onClick: () => s.exportFile() },
      '-',
      { label: 'Commit to git…', onClick: () => s.gitDialog(), disabled: !s.git },
      '-',
      { label: 'Open site at this moment ↗', onClick: () => this.openSite() },
      { label: 'Snapshot (PNG of the viewport)', onClick: () => this.snapshot() },
    ];
  }

  menuEdit() {
    const s = this.sel, locked = this.isLocked(s);
    return [
      { label: 'Undo', shortcut: `${mod}Z`, onClick: () => this.undo(), disabled: this.hi <= 0 },
      { label: 'Redo', shortcut: `${mod}Y`, onClick: () => this.redo(), disabled: this.hi >= this.history.length - 1 },
      '-',
      { label: 'Cut', shortcut: `${mod}X`, onClick: () => this.cut(), disabled: !this.copyable(s) || locked },
      { label: 'Copy', shortcut: `${mod}C`, onClick: () => this.copy(), disabled: !this.copyable(s) },
      { label: `Paste at ${fmtTime(this.time)}`, shortcut: `${mod}V`, onClick: () => this.paste(), disabled: !this.clipboard },
      { label: 'Duplicate at playhead', shortcut: `${mod}D`, onClick: () => this.duplicate(), disabled: !this.copyable(s) },
      { label: 'Delete', shortcut: 'Del', onClick: () => this.deleteSelection(), disabled: !s || s.kind === 'object' || locked, danger: true },
      '-',
      { label: locked ? 'Unlock' : 'Lock', shortcut: 'L', onClick: () => this.toggleLock(), disabled: !s || s.kind === 'object' },
      '-',
      { label: 'Add key at playhead', shortcut: 'K', onClick: () => this.addKey() },
      { label: 'Add caption at playhead', onClick: () => this.addCaption() },
      { label: 'Add note at playhead', onClick: () => this.addNote() },
      { label: 'Add chapter at playhead', onClick: () => this.addChapter() },
      { label: 'Add layer (image, video, HTML, web page)', items: this.lt.addItems() },
      { label: 'Add track', items: this.trackItems() },
      '-',
      { label: 'Story length…', onClick: () => this.lengthDialog() },
    ];
  }

  menuView() {
    return [
      { label: 'Scene view', shortcut: '1', checked: this.view === 'scene', onClick: () => this.setView('scene') },
      { label: 'Game view', shortcut: '2', checked: this.view === 'game', onClick: () => this.setView('game') },
      { label: 'Game aspect', items: Object.keys(ASPECTS).map((k) => ({ label: k === 'free' ? 'Free' : k, checked: this.aspect === k, onClick: () => { this.aspect = k; this.$aspect.value = k; this.layoutStage(); } })) },
      { label: 'Maximize on Play', checked: this.maxOnPlay, onClick: () => this.toggleMax() },
      '-',
      { label: 'Snap on timeline', checked: this.snap, onClick: () => this.toggleSnap() },
      { label: 'Fit timeline', shortcut: 'F', onClick: () => this.timeline.fit() },
      { label: 'Zoom timeline to 10 s around playhead', onClick: () => this.timeline.zoomTo(this.time - 5, this.time + 5) },
      '-',
      { label: 'Simulation speed', items: [[1, '1× (normal)'], [0.5, '½×'], [0.25, '¼×'], [0, 'Frozen']].map(([v, l]) => ({ label: l, checked: this.simSpeed === v || (v === 1 && this.simSpeed === undefined), onClick: () => { this.simSpeed = v; this.app.setTimeScale(v); } })) },
      { label: 'Show all objects', onClick: () => this.showAll() },
    ];
  }

  menuHelp() {
    return [
      { label: 'Keyboard shortcuts', onClick: () => this.shortcutsDialog() },
      { label: 'Editor guide (EDITOR.md) ↗', onClick: () => window.open('./EDITOR.md', '_blank') },
      { label: 'Copy reference for Claude', onClick: () => this.copyRef() },
    ];
  }

  trackItems() {
    const used = new Set(this.tl.tracks.map((t) => t.bind).filter(Boolean));
    return [
      ...Object.entries(PARAMS).map(([k, v]) => ({ label: `Curve: ${v.label}`, disabled: used.has(k), onClick: () => this.addTrack(`curve:${k}`) })),
      '-',
      ...Object.entries(DRIVERS).map(([k, v]) => ({ label: `Clip: ${v}`, disabled: used.has(k), onClick: () => this.addTrack(`clip:${k}`) })),
      '-',
      ...Object.entries(ACTORS).map(([k, v]) => ({ label: `Path: move the ${v.toLowerCase()}`, onClick: () => this.addTrack(`path:${k}`) })),
      ...(this.tl.tracks.some((t) => t.type === 'camera') ? [] : ['-', { label: 'Camera', onClick: () => this.addTrack('camera:') }]),
      ...(this.tl.tracks.some((t) => t.type === 'captions') ? [] : [{ label: 'Captions', onClick: () => this.addTrack('captions:') }]),
    ];
  }

  // context menu for a target {kind, track?, item?, t?} at screen x, y (the target gets selected)
  contextMenu(x, y, target) {
    const items = this.contextItems(target);
    if (items.length) openMenu(x, y, items);
  }

  contextMenuItems(x, y, items) { openMenu(x, y, items); }

  contextItems(tg) {
    const at = tg.t ?? this.time;
    const here = `at ${fmtTime(at)}`;
    const go = { label: `Move playhead here`, onClick: () => this.setTime(at) };
    const paste = { label: `Paste ${here}`, shortcut: `${mod}V`, disabled: !this.clipboard, onClick: () => { this.setTime(at); this.paste(tg.track); } };
    const sel = (s) => { if (s) this.select(s); };
    const lockItem = (s) => {
      const own = s.item ?? s.track, trackLocked = s.item && s.track?.locked;
      return { label: own?.locked ? 'Unlock' : 'Lock', shortcut: 'L', disabled: !!trackLocked && !own?.locked, onClick: () => { this.select(s); this.toggleLock(); } };
    };
    const del = (s) => ({ label: 'Delete', shortcut: 'Del', danger: true, disabled: this.isLocked(s), onClick: () => { this.select(s); this.deleteSelection(); } });
    const ccp = (s) => [
      { label: 'Cut', shortcut: `${mod}X`, disabled: this.isLocked(s), onClick: () => { this.select(s); this.cut(); } },
      { label: 'Copy', shortcut: `${mod}C`, onClick: () => { this.select(s); this.copy(); } },
      { label: 'Duplicate at playhead', shortcut: `${mod}D`, onClick: () => { this.select(s); this.duplicate(); } },
    ];

    switch (tg.kind) {
      case 'key': {
        const s = { kind: 'key', track: tg.track, item: tg.item }; sel(s);
        const L = this.isLocked(s), k = tg.item;
        return [
          { label: `Go to key (${fmtTime(k.t)})`, onClick: () => this.setTime(k.t) },
          tg.track.type === 'camera' ? { label: 'Set from Scene view', disabled: L, onClick: () => this.keyFromView(k) } : null,
          tg.track.type === 'camera' ? { label: 'Move key to playhead', disabled: L, onClick: () => { k.t = r4(this.time); this.commit(); } } : null,
          tg.track.type === 'curve' || tg.track.type === 'layer' ? { label: 'Ease to next', disabled: L, items: Object.keys(EASES).map((e) => ({ label: e, checked: (k.ease || 'smooth') === e, onClick: () => { k.ease = e; this.commit(); } })) } : null,
          '-', ...ccp(s), paste, '-', lockItem(s), del(s),
        ];
      }
      case 'clip': { // a caption, or the bar of a clip track
        const isCap = tg.track.type === 'captions';
        const s = isCap ? { kind: 'clip', track: tg.track, item: tg.item } : { kind: 'track', track: tg.track }; sel(s);
        const c = tg.item, L = this.isLocked(s);
        return [
          { label: `Go to start (${fmtTime(c.a)})`, onClick: () => this.setTime(c.a) },
          { label: `Set start to playhead (${fmtTime(this.time)})`, disabled: L || this.time >= c.b, onClick: () => { c.a = r4(this.time); this.commit(); } },
          { label: `Set end to playhead (${fmtTime(this.time)})`, disabled: L || this.time <= c.a, onClick: () => { c.b = r4(this.time); this.commit(); } },
          isCap ? { label: 'Split at playhead', disabled: L || this.time <= c.a || this.time >= c.b, onClick: () => this.splitCaption(tg.track, c) } : null,
          !isCap ? { label: 'Ease', disabled: L, items: [...Object.keys(EASES).filter((e) => e !== 'hold'), 'gate'].map((e) => ({ label: e, checked: (c.ease || 'linear') === e, onClick: () => { c.ease = e; this.commit(); } })) } : null,
          '-', ...(isCap ? [...ccp(s), paste, '-', lockItem(s), del(s)] : this.trackMenuTail(tg.track)),
        ].flat();
      }
      case 'track': {
        const s = { kind: 'track', track: tg.track }; sel(s);
        const t = tg.track, i = this.tl.tracks.indexOf(t), L = !!t.locked;
        if (t.type === 'group' || t.type === 'lane') return this.containerItems(t);
        return [
          { label: 'Rename…', disabled: L, onClick: () => this.inspector.focus('Name') },
          t.keys ? { label: `Add key at playhead (${fmtTime(this.time)})`, shortcut: 'K', disabled: L, onClick: () => this.addKey(t) } : null,
          t.type === 'captions' ? { label: `Add caption at playhead`, disabled: L, onClick: () => this.addCaption() } : null,
          t.keys || t.clips ? paste : null,
          '-',
          { label: t.mute ? 'Unmute' : 'Mute', onClick: () => { if (t.mute) delete t.mute; else t.mute = true; this.commit(); } },
          { label: L ? 'Unlock track' : 'Lock track', shortcut: 'L', onClick: () => this.toggleLock() },
          '-',
          { label: t.collapsed ? 'Expand row' : 'Collapse row', onClick: () => { if (t.collapsed) delete t.collapsed; else t.collapsed = true; this.commit(); } },
          { label: 'Move up', disabled: i <= 0, onClick: () => this.moveTrack(t, -1) },
          { label: 'Move down', disabled: i >= this.tl.tracks.length - 1, onClick: () => this.moveTrack(t, 1) },
          this.groupMenu(t),
          '-',
          { label: 'Delete track', danger: true, disabled: L, onClick: () => this.deleteSelection() },
        ];
      }
      case 'lane': {
        const t = tg.track; sel({ kind: 'track', track: t });
        const L = !!t.locked;
        return [
          go,
          t.keys ? { label: `Add key ${here}`, disabled: L, onClick: () => { this.setTime(at); this.addKey(t); } } : null,
          t.type === 'captions' ? { label: `Add caption ${here}`, disabled: L, onClick: () => { this.setTime(at); this.addCaption(); } } : null,
          t.keys || t.clips ? paste : null,
          '-',
          { label: `Add note ${here}`, onClick: () => { this.setTime(at); this.addNote(); } },
          '-', ...this.trackMenuTail(t),
        ];
      }
      case 'layer': {
        this.select({ kind: 'track', track: tg.track });
        return this.lt.contextItems(tg.track);
      }
      case 'path': {
        const t = tg.track, L = !!t.locked;
        this.select({ kind: 'track', track: t });
        return [
          { label: `Go to start (${fmtTime(t.a)})`, onClick: () => this.setTime(t.a) },
          { label: `Add waypoint at playhead (${fmtTime(this.time)})`, shortcut: 'K', disabled: L, onClick: () => this.addPathKey(t) },
          { label: 'Show in Scene view', onClick: () => { this.setView('scene'); const p = new THREE.Vector3().fromArray(this.actorPos(t.bind)); const { camera, controls } = this.app; const d = camera.position.clone().sub(controls.target); controls.target.copy(p); camera.position.copy(p).add(d.setLength(Math.min(d.length(), 45))); } },
          { label: 'Set start to playhead', disabled: L || this.time >= t.b, onClick: () => { t.a = r4(this.time); this.commit(); } },
          { label: 'Set end to playhead', disabled: L || this.time <= t.a, onClick: () => { t.b = r4(this.time); this.commit(); } },
          this.laneMenu(t),
          '-', ...this.trackMenuTail(t),
          { label: 'Delete path', danger: true, disabled: L, onClick: () => this.deleteSelection() },
        ];
      }
      case 'chapter': case 'note': {
        const s = { kind: tg.kind, item: tg.item }; sel(s);
        const L = this.isLocked(s);
        return [
          { label: `Go to (${fmtTime(tg.item.t)})`, onClick: () => this.setTime(tg.item.t) },
          { label: tg.kind === 'note' ? 'Edit text…' : 'Rename…', disabled: L, onClick: () => this.inspector.focus(tg.kind === 'note' ? 'Text' : 'Name') },
          { label: 'Move to playhead', disabled: L, onClick: () => { tg.item.t = r4(this.time); this.commit(); } },
          '-', ...ccp(s), '-', lockItem(s), del(s),
        ];
      }
      case 'ruler':
        return [
          go,
          { label: `Add chapter ${here}`, onClick: () => { this.setTime(at); this.addChapter(); } },
          { label: `Add note ${here}`, onClick: () => { this.setTime(at); this.addNote(); } },
          { label: 'Paste marker', disabled: !['chapter', 'note'].includes(this.clipboard?.kind), onClick: () => { this.setTime(at); this.paste(); } },
          '-',
          { label: 'Make the story longer', items: [10, 30, 60, 300, 600].map((d) => ({ label: `+ ${d < 60 ? `${d} s` : `${d / 60} min`}`, onClick: () => this.setDuration(this.duration + d) })) },
          { label: `End the story here (${fmtTime(at)})`, disabled: at < this.tl.contentEnd(), onClick: () => this.setDuration(at) },
          { label: 'Story length…', onClick: () => this.lengthDialog() },
          '-',
          { label: 'Fit timeline', shortcut: 'F', onClick: () => this.timeline.fit() },
        ];
      case 'object': {
        const o = tg.item;
        this.select({ kind: 'object', item: o });
        return [
          { label: this.isHidden(o) ? 'Show' : 'Hide', onClick: () => this.setHidden(o, !this.isHidden(o)) },
          { label: 'Show only this (solo)', onClick: () => this.solo(o) },
          { label: 'Show all', onClick: () => this.showAll() },
          '-',
          { label: 'Focus in Scene view', disabled: !this.focusPoint(o), onClick: () => this.focus(o) },
        ];
      }
      default: return [];
    }
  }

  // "Move to group ▸" for any track / lane; "Move to lane ▸" for layer and path clips
  groupMenu(t) {
    const groups = this.tl.tracks.filter((q) => q.type === 'group');
    return { label: 'Move to group', items: [
      ...groups.map((g) => ({ label: g.label, checked: t.parent === g.id, onClick: () => { t.parent = g.id; this.commit(); } })),
      groups.length ? '-' : null,
      { label: 'New group…', onClick: () => this.addGroup([t]) },
      { label: 'No group', disabled: !t.parent, onClick: () => { delete t.parent; this.commit(); } },
    ] };
  }

  laneMenu(t) {
    const lanes = this.tl.tracks.filter((q) => q.type === 'lane');
    return { label: 'Move to lane', items: [
      ...lanes.map((l) => ({ label: l.label, checked: t.lane === l.id, onClick: () => { t.lane = l.id; this.commit(); } })),
      lanes.length ? '-' : null,
      { label: 'New lane', onClick: () => { const l = this.addLane({ select: false }); t.lane = l.id; this.commit(); } },
      { label: 'Own row (no lane)', disabled: !t.lane, onClick: () => { delete t.lane; this.commit(); } },
    ] };
  }

  containerItems(t) {
    const L = !!t.locked, isG = t.type === 'group';
    return [
      { label: 'Rename…', onClick: () => this.inspector.focus('Name') },
      { label: t.collapsed ? 'Expand' : 'Collapse', onClick: () => { if (t.collapsed) delete t.collapsed; else t.collapsed = true; this.commit(); } },
      !isG ? { label: 'Drop files here: drag them from your computer or the Assets tab', disabled: true } : null,
      '-',
      { label: t.mute ? `Unmute ${isG ? 'group' : 'lane'}` : `Mute ${isG ? 'group' : 'lane'} (everything in it)`, onClick: () => { if (t.mute) delete t.mute; else t.mute = true; this.commit(); } },
      { label: L ? 'Unlock' : `Lock ${isG ? 'group' : 'lane'} (everything in it)`, onClick: () => this.toggleLock() },
      '-',
      { label: 'Move up', onClick: () => this.moveTrack(t, -1) },
      { label: 'Move down', onClick: () => this.moveTrack(t, 1) },
      !isG ? this.groupMenu(t) : null,
      '-',
      isG ? { label: 'Ungroup (keep the tracks)', disabled: L, onClick: () => this.removeContainer(t, false) } : null,
      { label: isG ? 'Delete group and everything in it' : 'Delete lane and its clips', danger: true, disabled: L, onClick: () => this.removeContainer(t, true) },
    ];
  }

  addGroup(members = []) {
    const n = this.tl.tracks.filter((q) => q.type === 'group').length + 1;
    const g = { id: `group-${Date.now().toString(36)}`, type: 'group', label: `Group ${n}` };
    const at = members.length ? this.tl.tracks.indexOf(members[0]) : this.tl.tracks.length;
    this.tl.tracks.splice(Math.max(0, at), 0, g);
    for (const m of members) m.parent = g.id;
    if (!members.length && this.sel?.track && this.sel.track.type !== 'group') { this.sel.track.parent = g.id; }
    this.commit();
    this.select({ kind: 'track', track: g });
    setTimeout(() => this.inspector.focus('Name'), 0);
    return g;
  }

  addLane({ label, parent, select = true } = {}) {
    const n = this.tl.tracks.filter((q) => q.type === 'lane').length + 1;
    const l = { id: `lane-${Date.now().toString(36)}${n}`, type: 'lane', label: label || `Lane ${n}` };
    if (parent) l.parent = parent;
    this.tl.tracks.push(l);
    this.commit();
    if (select) { this.select({ kind: 'track', track: l }); this.toast(`${l.label} added — drop files on it, or move clips into it`); }
    return l;
  }

  // a lane to put a new clip in: the selected lane / the selected clip's lane / one by name, created if needed
  defaultLane(type, name) {
    const s = this.sel?.track, tracks = this.tl.tracks;
    if (s?.type === 'lane') return s;
    if (s?.lane && s.type === type) return this.tl.byId.get(s.lane);
    return tracks.find((q) => q.type === 'lane' && q.label === name) ?? this.addLane({ label: name, select: false });
  }

  // delete a group / lane: with its contents, or (groups) just the folder
  removeContainer(t, withContents) {
    const tracks = this.tl.tracks;
    if (withContents) {
      const gone = new Set([t, ...(this.timeline.contents(t))]);
      if ([...gone].some((q) => q.locked || q.keys?.some((k) => k.locked))) return this.toast('Something inside is locked — unlock it first', true);
      this.tl.data.tracks = tracks.filter((q) => !gone.has(q));
    } else {
      for (const q of tracks) if (q.parent === t.id) delete q.parent;
      tracks.splice(tracks.indexOf(t), 1);
    }
    this.tl.changed();
    this.commit();
    this.select(null);
    this.toast(`Deleted — ${mod}Z to undo`);
  }

  trackMenuTail(t) {
    return [
      { label: t.mute ? 'Unmute track' : 'Mute track', onClick: () => { if (t.mute) delete t.mute; else t.mute = true; this.commit(); } },
      { label: t.locked ? 'Unlock track' : 'Lock track', onClick: () => { this.select({ kind: 'track', track: t }); this.toggleLock(); } },
    ];
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
      if (selectable) {
        el.addEventListener('click', () => this.select({ kind: 'object', item: entry }));
        el.addEventListener('contextmenu', (e) => { e.preventDefault(); this.contextMenu(e.clientX, e.clientY, { kind: 'object', item: entry }); });
      }
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
    if (this.sel?.item === o) this.inspector.show();
  }
  solo(o) { for (const x of this.app.objects) this.setHidden(x, x !== o); }
  showAll() { for (const x of this.app.objects) this.setHidden(x, false); }

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

  // ------------------------------------------------------------------ selection, locks & editing
  select(sel) {
    this.sel = sel;
    for (const o of this.app.objects) o.el?.classList.toggle('sel', sel?.kind === 'object' && sel.item === o);
    this.inspector.show();
    this.timeline.draw();
  }

  // locked: the item itself, or the track it lives on
  isLocked(s) {
    if (!s || s.kind === 'object') return false;
    return !!(s.item?.locked || (s.track && this.tl.lockedTrack(s.track)));
  }

  toggleLock() {
    const s = this.sel;
    if (!s || s.kind === 'object') return;
    const own = s.kind === 'track' ? s.track : s.item;
    if (!own.locked && s.track?.locked && s.kind !== 'track') return this.toast('The whole track is locked — unlock the track', true);
    if (own.locked) delete own.locked; else own.locked = true;
    this.commit();
    this.toast(own.locked ? 'Locked' : 'Unlocked');
  }

  // refuses (with a message) when the selection is locked
  guard(s = this.sel) {
    if (this.isLocked(s)) { this.toast('Locked — right-click ▸ Unlock (or press L) to change it', true); return false; }
    return true;
  }

  setTime(x) {
    this.time = Math.min(this.duration, Math.max(0, x));
    this.story.forceP = this.time / this.duration;
  }

  setDuration(d) {
    const min = Math.max(1, Math.ceil(this.tl.contentEnd() * 10) / 10);
    d = Math.max(min, Math.round(d * 10) / 10);
    if (d === this.duration) return;
    const old = this.duration;
    this.tl.meta.duration = d;
    // keep "until the end" clips / captions running to the new end
    for (const t of this.tl.tracks) {
      if (t.type === 'clip' && t.b >= old - 1e-6) t.b = d;
      if (t.clips) for (const c of t.clips) if (c.b >= old - 1e-6) c.b = d;
    }
    this.commit();
    this.setTime(Math.min(this.time, d));
    this.timeline.fit();
    this.toast(`Story length ${fmtTime(d, 0)}`);
  }

  lengthDialog() {
    const input = h('input', { type: 'text', value: fmtTime(this.duration, 0) });
    const per = h('input', { type: 'number', value: String(this.tl.meta.scrollPerSecond), step: '1', min: '2', max: '200' });
    const apply = () => {
      const v = parseTime(input.value);
      if (v === null || v <= 0) { this.toast('Type a length like 2:30 or 150', true); return false; }
      const sp = +per.value;
      if (sp > 0 && sp !== this.tl.meta.scrollPerSecond) { this.tl.meta.scrollPerSecond = sp; this.commit(); }
      this.setDuration(v);
      return true;
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && apply()) d.close(); });
    const d = dialog({
      title: 'Story length',
      body: [
        h('label', { class: 'lbl' }, 'Length (m:ss or h:mm:ss)', input),
        h('label', { class: 'lbl' }, 'Scroll per second of story (vh)', per),
        h('p', { class: 'muted' }, `Keys keep their times when you change the length. Can't be shorter than the last thing on the timeline (${fmtTime(this.tl.contentEnd())}). On the site, the page is length × scroll-per-second tall: 15 vh/s means a visitor scrolls about one screen every ~7 s of story.`),
      ],
      buttons: [{ label: 'Cancel' }, { label: 'Apply', primary: true, onClick: apply }],
    });
  }

  // live edit: re-sort + redraw (no undo step yet)
  changed() {
    this.tl.changed();
    this.timeline.draw();
  }

  // finish an edit: one undo step, draft + autosave bookkeeping
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
    this.saves.edited(s);
    if (this.perf.length !== Math.ceil(this.duration / PERF_STEP) + 1) {
      const p = new Float32Array(Math.ceil(this.duration / PERF_STEP) + 1);
      p.set(this.perf.subarray(0, Math.min(p.length, this.perf.length)));
      this.perf = p;
    }
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
    this.setTime(this.time);
    this.afterEdit(s);
    this.inspector.show();
  }

  undo() { if (this.hi > 0) { this.hi--; this.restore(this.history[this.hi]); } }
  redo() { if (this.hi < this.history.length - 1) { this.hi++; this.restore(this.history[this.hi]); } }

  // replace the whole story (open / restore / import) — one undo step
  loadText(text, label) {
    const data = migrate(JSON.parse(text));
    if (!Array.isArray(data.tracks)) throw new Error('not a story file (no tracks)');
    this.tl.set(data);
    this.sel = null;
    const n = data.settings?.tunaCount;
    if (n && n !== this.app.tuna.count) this.app.setTunaCount(n);
    this.commit();
    this.setTime(this.time);
    this.timeline.fit();
    this.select(null);
    this.toast(`Loaded ${label} — ${mod}Z to undo, Save to keep it`);
  }

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
    return t && (t.type === 'camera' || t.type === 'curve' || t.type === 'layer' || t.type === 'path') ? t : this.tl.tracks.find((x) => x.type === 'camera');
  }

  addKey(track = this.keyTrack()) {
    if (!track) return this.toast('Select a camera or curve track first');
    if (track.type === 'layer') return this.lt.addKey(track);
    if (track.type === 'path') return this.addPathKey(track);
    if (track.locked) return this.toast(`“${track.label}” is locked`, true);
    const t = r4(this.time);
    let key = track.keys.find((k) => Math.abs(k.t - t) < 1e-3);
    if (key?.locked) return this.toast('That key is locked', true);
    const isNew = !key;
    if (track.type === 'camera') {
      key ??= { t };
      Object.assign(key, this.currentPose());
    } else {
      const P = PARAMS[track.bind] || { def: 0 };
      key ??= { t, ease: 'smooth' };
      key.v = r4(this.tl.param(track.bind, t, P.def));
    }
    if (isNew) track.keys.push(key);
    this.commit();
    this.select({ kind: 'key', track, item: key });
    this.toast(isNew ? `Key added at ${fmtTime(t)}${track.type === 'camera' && this.sceneView ? ' from the Scene view' : ''}` : `Key at ${fmtTime(t)} updated`);
  }

  // camera pose for a new key: the Scene view camera, or (Game view) the story camera's current pose
  currentPose() {
    const { camera, controls } = this.app;
    const r = (v) => v.toArray().map((x) => +x.toFixed(3));
    if (this.sceneView) return { pos: r(camera.position), look: r(controls.target), follow: 0, fov: +camera.fov.toFixed(1) };
    const k = { pos: [0, 0, 0], look: [0, 0, 0], follow: 0, fov: 50 };
    this.tl.camera(this.time, k);
    return { pos: k.pos.map((x) => +x.toFixed(3)), look: k.look.map((x) => +x.toFixed(3)), follow: +k.follow.toFixed(3), fov: +k.fov.toFixed(1) };
  }

  keyFromView(key) {
    if (!this.sceneView) { this.toast('Switch to the Scene view (1), frame the shot, then press this again'); return; }
    if (!this.guard()) return;
    const pose = this.currentPose();
    Object.assign(key, { pos: pose.pos, look: pose.look, follow: 0 });
    this.commit();
    this.toast('Key set from the Scene view');
  }

  captionsTrack() {
    let t = this.tl.tracks.find((x) => x.type === 'captions');
    if (!t) { t = { id: 'captions', type: 'captions', label: 'Captions', clips: [] }; this.tl.tracks.splice(1, 0, t); }
    return t;
  }

  addCaption() {
    const t = this.captionsTrack();
    if (t.locked) return this.toast('The Captions track is locked', true);
    const a = r4(Math.min(this.time, this.duration - 0.5)), c = { a, b: r4(Math.min(this.duration, a + 5)), size: 'medium', y: 42, title: 'New caption', sub: '' };
    t.clips.push(c);
    this.commit();
    this.select({ kind: 'clip', track: t, item: c });
  }

  splitCaption(track, c) {
    const x = r4(this.time), right = { ...structuredClone(c), a: x };
    delete right.locked;
    c.b = x;
    track.clips.push(right);
    this.commit();
    this.select({ kind: 'clip', track, item: right });
  }

  addNote() {
    const n = { t: r4(this.time), text: '' };
    this.tl.data.notes.push(n);
    this.commit();
    this.select({ kind: 'note', item: n });
    setTimeout(() => this.inspector.focus('Text'), 0);
  }

  addChapter() {
    const c = { t: r4(this.time), name: 'New chapter' };
    this.tl.data.chapters.push(c);
    this.commit();
    this.select({ kind: 'chapter', item: c });
    setTimeout(() => this.inspector.focus('Name'), 0);
  }

  refreshAddTrack() {
    const used = new Set(this.tl.tracks.map((t) => t.bind).filter(Boolean));
    const opt = (v, t) => h('option', { value: v, disabled: used.has(v.slice(v.indexOf(':') + 1)) }, t);
    this.$addTrack.replaceChildren(
      h('option', { value: '' }, '+ Track…'),
      h('optgroup', { label: 'Animate a parameter (curve)' }, Object.entries(PARAMS).map(([k, v]) => opt(`curve:${k}`, v.label))),
      h('optgroup', { label: 'Drive a story beat (clip)' }, Object.entries(DRIVERS).map(([k, v]) => opt(`clip:${k}`, v))),
      h('optgroup', { label: 'Move a creature along a path' }, Object.entries(ACTORS).map(([k, v]) => h('option', { value: `path:${k}` }, `${v} path`))),
      ...(this.tl.tracks.some((t) => t.type === 'camera') ? [] : [h('option', { value: 'camera:' }, 'Camera')]),
      ...(this.tl.tracks.some((t) => t.type === 'captions') ? [] : [h('option', { value: 'captions:' }, 'Captions')]),
    );
    this.$len.textContent = `Length ${fmtTime(this.duration, 0)}`;
  }

  addTrack(spec) {
    const [type, bind] = spec.split(':'), t0 = r4(this.time);
    let t;
    if (type === 'curve') {
      const P = PARAMS[bind];
      t = { id: bind.replace('.', '-'), type, label: P.label.replace(/ \(.*\)/, ''), bind, keys: [{ t: t0, v: r4(this.tl.param(bind, t0, P.def)), ease: 'smooth' }] };
    } else if (type === 'clip') {
      t = { id: bind.replace('.', '-'), type, label: DRIVERS[bind].replace(/ \(.*\)/, ''), bind, a: t0, b: r4(Math.min(this.duration, t0 + 6)), ease: bind.startsWith('tuna.') ? 'gate' : 'smooth' };
    } else if (type === 'path') {
      const p = this.actorPos(bind), f = this.actorFwd(bind);
      const t1 = r4(Math.min(this.duration, t0 + 10));
      t = { id: `path-${bind}-${Date.now().toString(36)}`, type, label: `${ACTORS[bind]} path`, bind, lane: this.defaultLane('path', 'Creatures').id, a: t0, b: r4(Math.min(this.duration, t0 + 20)), blend: 2,
        keys: [{ t: t0, pos: p.map((v) => +v.toFixed(2)) }, { t: t1, pos: p.map((v, i) => +(v + f[i] * 25).toFixed(2)) }] };
      this.toast(`${ACTORS[bind]} path added — move its waypoints in the Scene view (1), or press K there to add one where you look`);
    } else if (type === 'captions') {
      t = this.captionsTrack();
      this.commit();
      return this.select({ kind: 'track', track: t });
    } else {
      t = { id: 'camera', type: 'camera', label: 'Camera', drift: 1, keys: [{ t: t0, ...this.currentPose() }] };
    }
    this.tl.tracks.push(t);
    this.commit();
    this.select({ kind: 'track', track: t });
  }

  // where a path actor is now (after any path blending), and which way it faces
  actorPos(bind) {
    if (bind === 'school') return this.app.tuna.u.goal.value.toArray();
    return this.story.actors[bind]?.obj.position.toArray() ?? [0, -6, 0];
  }

  actorFwd(bind) {
    const o = this.story.actors[bind]?.obj;
    if (!o) return [1, 0, 0];
    const d = o.getWorldDirection(new THREE.Vector3()); // +Z = forward for the creatures
    d.y = 0;
    return (d.lengthSq() < 1e-6 ? new THREE.Vector3(1, 0, 0) : d.normalize()).toArray();
  }

  // a waypoint at the playhead: where the Scene camera looks, or (Game view) where the creature is now
  addPathKey(track) {
    if (track.locked) return this.toast(`“${track.label}” is locked`, true);
    const t = r4(this.time);
    const p = this.sceneView ? this.app.controls.target.toArray() : this.actorPos(track.bind);
    let key = track.keys.find((k) => Math.abs(k.t - t) < 1e-3);
    if (key?.locked) return this.toast('That waypoint is locked', true);
    if (!key) { key = { t }; track.keys.push(key); }
    key.pos = p.map((v) => +v.toFixed(2));
    if (t < track.a) track.a = t;
    if (t > track.b) track.b = t;
    this.commit();
    this.select({ kind: 'key', track, item: key });
    this.toast(`Waypoint at ${fmtTime(t)}${this.sceneView ? ' (where the Scene camera looks)' : ''}`);
  }

  moveTrack(t, dir) {
    const a = this.tl.tracks, i = a.indexOf(t), j = i + dir;
    if (j < 0 || j >= a.length) return;
    [a[i], a[j]] = [a[j], a[i]];
    this.commit();
  }

  deleteSelection() {
    const s = this.sel, d = this.tl.data;
    if (!s || s.kind === 'object' || !this.guard()) return;
    if (s.kind === 'track' && (s.track.type === 'group' || s.track.type === 'lane')) return this.removeContainer(s.track, s.track.type === 'lane');
    if (s.kind === 'track' && (s.track.keys?.some((k) => k.locked) || s.track.clips?.some((c) => c.locked))) return this.toast('This track has locked items — unlock them first', true);
    const drop = (arr, it) => { const i = arr.indexOf(it); if (i >= 0) arr.splice(i, 1); };
    if (s.kind === 'key') drop(s.track.keys, s.item);
    else if (s.kind === 'clip') drop(s.track.clips, s.item);
    else if (s.kind === 'track') drop(d.tracks, s.track);
    else if (s.kind === 'chapter') drop(d.chapters, s.item);
    else if (s.kind === 'note') drop(d.notes, s.item);
    const back = s.kind === 'key' || s.kind === 'clip' ? { kind: 'track', track: s.track } : null;
    this.commit();
    this.select(back);
    this.toast(`Deleted — ${mod}Z to undo`);
  }

  // ------------------------------------------------------------------ clipboard
  copyable(s) { return !!s && ['key', 'clip', 'chapter', 'note'].includes(s.kind); }

  copy() {
    const s = this.sel;
    if (!this.copyable(s)) return;
    const item = structuredClone(s.item);
    delete item.locked;
    this.clipboard = { kind: s.kind, type: s.track?.type, bind: s.track?.bind, space: s.track?.space, layer: s.track?.type === 'layer' ? s.track.id : undefined, item };
    try { localStorage.setItem(CLIP_KEY, JSON.stringify(this.clipboard)); } catch { /* storage unavailable */ }
    navigator.clipboard?.writeText(JSON.stringify(this.clipboard, null, 1)).catch(() => {});
    this.toast('Copied');
  }

  cut() {
    if (!this.copyable(this.sel) || !this.guard()) return;
    this.copy();
    this.deleteSelection();
  }

  // paste at the playhead; keys go to a matching track (the given / selected one if it fits)
  paste(into) {
    const c = this.clipboard;
    if (!c) return;
    const x = r4(this.time), it = structuredClone(c.item);
    const fits = (t) => t && t.type === c.type && (c.type !== 'curve' || t.bind === c.bind) && (c.type !== 'path' || t.bind === c.bind) && (c.type !== 'layer' || (t.space ?? 'screen') === (c.space ?? 'screen'));
    if (c.kind === 'key') {
      const t = [into, this.sel?.track].find(fits) ?? this.tl.tracks.find(fits);
      if (!t) return this.toast(`No ${c.type === 'curve' ? `“${c.bind}”` : c.type === 'layer' ? 'matching layer (select one)' : c.type} track to paste into`, true);
      if (t.locked) return this.toast(`“${t.label}” is locked`, true);
      it.t = x;
      t.keys = t.keys.filter((k) => Math.abs(k.t - x) > 1e-3 || k.locked);
      t.keys.push(it);
      this.commit();
      return this.select({ kind: 'key', track: t, item: it });
    }
    if (c.kind === 'clip') {
      const t = this.captionsTrack();
      if (t.locked) return this.toast('The Captions track is locked', true);
      const w = it.b - it.a;
      it.a = r4(Math.max(0, Math.min(x, this.duration - w)));
      it.b = r4(it.a + w);
      t.clips.push(it);
      this.commit();
      return this.select({ kind: 'clip', track: t, item: it });
    }
    it.t = x;
    this.tl.data[c.kind === 'chapter' ? 'chapters' : 'notes'].push(it);
    this.commit();
    this.select({ kind: c.kind, item: it });
  }

  duplicate() {
    if (this.sel?.kind === 'track' && this.sel.track.type === 'layer') return this.lt.duplicate(this.sel.track);
    if (!this.copyable(this.sel)) return;
    const keep = this.clipboard;
    this.copy();
    this.paste(this.sel.track);
    this.clipboard = keep;
  }

  stepKey(dir) {
    const keys = [];
    const tracks = this.sel?.track ? [this.sel.track] : this.tl.tracks;
    for (const t of tracks) {
      if (t.keys) keys.push(...t.keys.map((k) => k.t));
      if (t.clips) for (const c of t.clips) keys.push(c.a, c.b);
      if (t.type === 'clip') keys.push(t.a, t.b);
    }
    if (!this.sel?.track) for (const c of this.tl.data.chapters) keys.push(c.t);
    keys.sort((a, b) => a - b);
    const next = dir > 0 ? keys.find((k) => k > this.time + 1e-4) : keys.reverse().find((k) => k < this.time - 1e-4);
    if (next !== undefined) this.setTime(next);
  }

  // ------------------------------------------------------------------ play mode
  play(mode = 'site') {
    if (this.playing) this.pause();
    this.playMode = mode;
    if (mode === 'auto' && this.time >= this.duration - 1e-3) this.setTime(0);
    this.playing = true;
    this.playFrom = this.time;
    this.scrollT = this.time;
    const { camera, controls } = this.app;
    if (this.view === 'scene') this.sceneCam = { pos: camera.position.clone(), target: controls.target.clone() };
    if (this.maxOnPlay) this.$root.classList.add('max');
    controls.enabled = false;
    this.syncMode();
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
    this.setTime(this.playFrom);
  }

  // ------------------------------------------------------------------ per frame
  preUpdate(rdt) {
    if (this.playing) {
      if (this.playMode === 'auto') {
        this.setTime(this.time + rdt * this.speed);
        if (this.time >= this.duration) this.pause();
      } else {
        // the website's scroll smoothing (story.js): p += (target − p)·(1 − e^(−2.4·dt))
        const d = this.scrollT - this.time;
        this.setTime(Math.abs(d) < 1e-4 ? this.scrollT : this.time + d * (1 - Math.exp(-rdt * 2.4)));
      }
      this.timeline.follow();
      const th = this.$scrollbar.firstChild;
      th.style.top = `${(this.time / this.duration) * 100}%`;
    }
    this.story.forceP = this.time / this.duration;
    // performance lane: fps at this moment of the story (after a warm-up)
    if (rdt > 0 && performance.now() - this.born > 4000 && !document.hidden) {
      const fps = 1 / rdt, i = Math.min(this.perf.length - 1, Math.floor(this.time / PERF_STEP));
      this.perf[i] = this.perf[i] ? this.perf[i] * 0.85 + fps * 0.15 : fps;
    }
  }

  postUpdate() {
    this.gizmos.update();
    this.lt.update();
    this.timeline.draw();
    const now = performance.now();
    if (now - (this.lastUi || 0) > 120) {
      this.lastUi = now;
      const ch = this.tl.chapter(this.time);
      this.$readout.innerHTML = `<b>${fmtTime(this.time)}</b> / ${fmtTime(this.duration, 0)}${ch ? ` · <b>${esc(ch.name)}</b>` : ''}`;
      if (document.activeElement !== this.$tInput) this.$tInput.value = fmtTime(this.time, 2);
      const { fps, res } = this.app.fpsInfo;
      this.$fps.innerHTML = `<span style="color:${fps >= 55 ? 'var(--good)' : fps >= 40 ? 'var(--warn)' : 'var(--bad)'}">${Math.round(fps)} fps</span> · ${Math.round(res * 100)}%`;
      const st = this.saves.status();
      this.$status.textContent = st.text;
      this.$status.className = st.cls;
      this.inspector.refresh();
    }
  }

  syncButtons() {
    this.$play.replaceChildren(icon(this.playing ? 'pause' : 'play'));
    this.$play.classList.toggle('on', this.playing);
    this.$save.classList.toggle('dirty', this.saves.dirty);
    this.syncMode();
  }

  // ------------------------------------------------------------------ keyboard
  bindKeys() {
    addEventListener('keydown', (e) => {
      if (document.querySelector('.ed-modal')) return; // a dialog is open
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
      const cmd = e.ctrlKey || e.metaKey;
      if (cmd && e.code === 'KeyS') { e.preventDefault(); if (e.shiftKey) this.saves.checkpointDialog(); else this.saves.save(); return; }
      if (cmd && e.code === 'KeyO') { e.preventDefault(); this.saves.openDialog(); return; }
      if (typing) return;
      if (cmd) {
        const k = { KeyZ: () => (e.shiftKey ? this.redo() : this.undo()), KeyY: () => this.redo(), KeyD: () => this.duplicate(), KeyC: () => this.copy(), KeyX: () => this.cut(), KeyV: () => this.paste() }[e.code];
        if (k) { e.preventDefault(); k(); }
        return;
      }
      if (this.playing && this.playMode === 'site') {
        const px = { ArrowDown: 40, ArrowUp: -40, PageDown: innerHeight * 0.9, PageUp: -innerHeight * 0.9 }[e.code];
        if (px) { e.preventDefault(); this.scrollBy(px); return; }
        if (e.code === 'Home') { this.scrollT = 0; return; }
        if (e.code === 'End') { this.scrollT = this.duration; return; }
      }
      const frame = e.shiftKey ? 1 : 1 / 30;
      switch (e.code) {
        case 'Space': e.preventDefault(); this.playing ? this.pause() : this.play('site'); break;
        case 'Escape': if (this.playing) this.stop(); else this.select(null); break;
        case 'Home': this.pause(); this.setTime(0); break;
        case 'End': this.pause(); this.setTime(this.duration); break;
        case 'ArrowLeft': e.preventDefault(); this.pause(); this.setTime(this.time - frame); break;
        case 'ArrowRight': e.preventDefault(); this.pause(); this.setTime(this.time + frame); break;
        case 'Comma': this.pause(); this.stepKey(-1); break;
        case 'Period': this.pause(); this.stepKey(1); break;
        case 'KeyK': this.addKey(); break;
        case 'KeyL': this.toggleLock(); break;
        case 'Delete': case 'Backspace': e.preventDefault(); this.deleteSelection(); break;
        case 'Digit1': this.setView('scene'); break;
        case 'Digit2': this.setView('game'); break;
        case 'KeyF': this.timeline.fit(); break;
        default:
      }
    });
  }

  shortcutsDialog() {
    const rows = [
      ['Space', 'Play (scroll like the website) / Pause'], ['▶▶', 'Auto-play at the chosen speed'], ['Wheel / ↑↓ / PgUp PgDn', 'Scroll while playing'], ['Esc', 'Stop (back to start of play) / deselect'], ['← →', 'Step 1 frame (Shift: 1 s)'], ['Home / End', 'Start / end of story'],
      [', .', 'Previous / next key'], ['K', 'Add key here (Scene view: from your view)'], ['L', 'Lock / unlock selection'], ['Del', 'Delete'],
      [`${mod}C / X / V`, 'Copy / cut / paste at playhead'], [`${mod}D`, 'Duplicate at playhead'], [`${mod}Z / Y`, 'Undo / redo'],
      [`${mod}S`, 'Save'], [`${mod}⇧S`, 'Save checkpoint'], [`${mod}O`, 'Open / restore'], ['1 / 2', 'Scene / Game view'], ['F', 'Fit timeline'],
      ['WASD QE', 'Fly (Scene view, Shift = fast)'], ['Right-click', 'Options for anything'], ['Ctrl + wheel', 'Zoom timeline'], ['Shift + wheel', 'Pan timeline'], ['Shift + drag', 'Move without snapping'],
    ];
    dialog({ title: 'Keyboard shortcuts', body: h('div', { class: 'ed-help' }, rows.map(([k, v]) => h('div', {}, h('kbd', {}, k), ` ${v}`))), buttons: [{ label: 'Close', primary: true }] });
  }

  // ------------------------------------------------------------------ sharing
  // A precise, human + Claude readable description of the current moment.
  reference() {
    const tl = this.tl, x = this.time, d = tl.data;
    const lines = [];
    const ch = tl.chapter(x);
    lines.push(`Open Tuna — story.json @ ${fmtTime(x, 2)} (t=${x.toFixed(2)} s of ${tl.duration} s, p=${(x / tl.duration).toFixed(3)})${ch ? `, chapter "${ch.name}"` : ''}`);
    const active = [];
    for (const t of tl.tracks) {
      if (t.mute) continue;
      if (t.type === 'clip') {
        const v = tl.clip(t.bind, x);
        if (t.ease === 'gate') { if (v) active.push(`${t.bind} ON (${t.a}–${t.b} s)`); }
        else if (x >= t.a && x <= t.b) active.push(`${t.bind} ${Math.round(v * 100)}% (${t.a}–${t.b} s)`);
      }
      if (t.type === 'curve') active.push(`${t.bind}=${+tl.param(t.bind, x, 0).toFixed(2)}`);
    }
    if (active.length) lines.push(`active: ${active.join(' · ')}`);
    const cam = tl.ofType('camera');
    if (cam?.keys.length) {
      const i = cam.keys.findLastIndex((k) => k.t <= x);
      const a = cam.keys[i], b = cam.keys[i + 1];
      lines.push(`camera: ${a ? `key #${i + 1} (t ${a.t})` : 'before first key'}${b ? ` → key #${i + 2} (t ${b.t})` : ''}; at [${this.story.cam.position.toArray().map((v) => v.toFixed(1)).join(', ')}] looking at [${this.story.look.toArray().map((v) => v.toFixed(1)).join(', ')}]`);
    }
    const caps = tl.captions().filter((c) => x >= c.a && x <= c.b).map((c) => `"${c.title.replace(/\n/g, ' ')}"`);
    if (caps.length) lines.push(`caption on screen: ${caps.join(', ')}`);
    const paths = tl.paths().map((pt) => ({ pt, w: tl.path(pt, x, { pos: [0, 0, 0], ahead: [0, 0, 0] }).w })).filter((q) => q.w > 0);
    if (paths.length) lines.push(`paths active: ${paths.map(({ pt, w }) => `${pt.bind} "${pt.label}" (${Math.round(w * 100)}%, ${pt.a}–${pt.b} s, ${pt.keys.length} waypoints)`).join(' · ')}`);
    const lay = this.lt.reference(x);
    if (lay) lines.push(lay);
    const notes = d.notes.filter((n) => Math.abs(n.t - x) < 3 && n.text);
    if (notes.length) lines.push(`notes nearby: ${notes.map((n) => `t ${n.t}: "${n.text}"`).join(' · ')}`);
    const s = this.sel;
    if (s && s.kind !== 'object') lines.push(`selected: ${s.kind}${s.track ? ` on track "${s.track.label}"` : ''}${s.item?.t !== undefined ? ` at t ${s.item.t}` : ''}${this.isLocked(s) ? ' (locked)' : ''}`);
    lines.push(`fps here: ${Math.round(this.app.fpsInfo.fps)} · view: ${this.view === 'scene' ? 'Scene' : `Game ${this.aspect}`} · unsaved changes: ${this.saves.dirty ? 'yes' : 'no'}`);
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

  openSite() { window.open(`./?t=${this.time.toFixed(2)}`, '_blank'); }

  async snapshot() {
    const blob = await this.app.capture();
    if (blob) download(`open-tuna_${fmtTime(this.time, 1).replace(/:/g, '-')}.png`, blob);
    else this.toast('Snapshot failed', true);
  }

  toast(msg, err = false, ms = 3200) {
    const el = h('div', { class: err ? 'err' : '' }, msg);
    this.$toast.append(el);
    while (this.$toast.children.length > 4) this.$toast.firstChild.remove();
    if (ms) setTimeout(() => el.remove(), ms);
  }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// "1:05", "1:05.5", "65", "1:02:03" -> seconds (null if unreadable)
export function parseTime(s) {
  const parts = String(s).trim().split(':').map((x) => x.trim());
  if (!parts.length || parts.some((x) => x === '' || !Number.isFinite(+x))) return null;
  return parts.reduce((acc, x) => acc * 60 + +x, 0);
}
