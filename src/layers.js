// Media layers from story.json `layer` tracks.
//   DOM layers   html / iframe (and image / video with render "dom"): elements over the canvas, positioned in % of
//                the view, stacked with the captions — for real GUI (links, buttons, web pages).
//   GPU layers   image / video / text / glass rendered INSIDE the WebGPU scene, so they take the scene's post
//                (bloom, god rays, colour grade) and shader effects: water-dissolve / wipe / ripple reveals,
//                flowing distortion, caustic light, scroll-reactive chroma split, glow, and frosted glass that
//                refracts the ocean behind it. "screen" GPU layers ride in front of the story camera at `depth`
//                metres, so fish closer than that swim in front of them; "world" layers are planes in the 3D world.
// Each layer is visible from `a` to `b` (s) with a `fade` (the reveal), keyframes animate x / y (or pos) / s / r / o.
// Rebuilt incrementally when the timeline or live data changes (videos / iframes only reload when their source
// changes). Text / html / src may hold {{data bindings}} (src/data.js); they're resolved before building.
import * as THREE from 'three/webgpu';
import {
  uniform, float, vec2, vec3, uv, texture, mix, smoothstep, sin, cos, abs, max, length, clamp, pow,
  screenUV, viewportTexture, select, normalize,
} from 'three/tsl';
import { evalKeys, captionOpacity } from './timeline.js';
import { U, causticTex } from './shared.js';
import { createLoader } from './models.js';
import { createAnimated } from './creatures.js';
import { assetURL, fixHTML } from './project.js';

export const SCREEN_KEY = { x: 50, y: 50, s: 1, r: 0, o: 1 };
export const WORLD_KEY = { pos: [0, 8, 10], s: 1, r: 0, o: 1 };
export const MODEL_KEY = { pos: [0, -6, 10], rot: [0, 0, 0], s: 1, o: 1 };
export const MEDIA_EXT = { image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif'], video: ['mp4', 'webm', 'mov', 'm4v'], iframe: ['html', 'htm'], model: ['glb', 'gltf'] };

// GLB models: loaded once per file, cloned per clip (skinned models included)
const gltfCache = new Map();
let gltfLoader = null;
export function loadGLTF(src) {
  gltfLoader ??= createLoader(new THREE.LoadingManager());
  if (!gltfCache.has(src)) gltfCache.set(src, gltfLoader.loadAsync(src));
  return gltfCache.get(src);
}
export const REVEALS = { fade: 0, dissolve: 1, wipe: 2, ripple: 3 };
export const FX = ['distort', 'caustic', 'chroma', 'glow', 'glass']; // 0..1 shader amounts on a GPU layer

export function kindOf(name) {
  const ext = String(name).split('?')[0].split('.').pop().toLowerCase();
  return Object.keys(MEDIA_EXT).find((k) => MEDIA_EXT[k].includes(ext)) ?? null;
}

// GPU or DOM? html / iframe are always DOM (they are real web content); text / glass are always GPU
export const isGPU = (t) => t.kind === 'text' || t.kind === 'glass' || t.kind === 'model' || t.space === 'world' || ((t.kind === 'image' || t.kind === 'video') && t.render === 'gpu');

// ---------------------------------------------------------------------------------------------
// Text drawn into a canvas (brand fonts) so it can be a GPU layer with the same effects as images.
// ---------------------------------------------------------------------------------------------
function wrap(g, text, width) {
  const out = [];
  for (const para of String(text || '').split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const test = line ? `${line} ${word}` : word;
      if (g.measureText(test).width > width && line) { out.push(line); line = word; } else line = test;
    }
    out.push(line);
  }
  return out;
}

export function drawText(t) {
  const W = 2048, pad = 60, inner = W - pad * 2;
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  let size = t.size ?? 180;
  // "Max lines": a headline longer than that (a long CMS name) gets smaller until it fits, down to 35 %
  if (t.maxLines > 0 && t.title) {
    for (let i = 0; i < 24 && size > (t.size ?? 180) * 0.35; i++) {
      g.font = `500 ${size}px "Cormorant Garamond", Georgia, serif`;
      g.letterSpacing = '0px';
      if (wrap(g, t.title, inner).length <= t.maxLines) break;
      size *= 0.92;
    }
  }
  const parts = [];
  if (t.kicker) parts.push({ text: t.kicker.toUpperCase(), font: '600 46px Inter, system-ui, sans-serif', lh: 70, spacing: '18px', color: t.accent || '#9fe7ff', gap: 24 });
  if (t.title) parts.push({ text: t.title, font: `500 ${size}px "Cormorant Garamond", Georgia, serif`, lh: size * 1.02, spacing: '0px', color: t.color || '#f4fbff', gap: 30 });
  if (t.body) parts.push({ text: t.body, font: '400 54px Inter, system-ui, sans-serif', lh: 78, spacing: '0px', color: t.bodyColor || '#d8eef5', gap: 0 });
  let h = pad;
  for (const p of parts) {
    g.font = p.font;
    g.letterSpacing = p.spacing;
    p.lines = wrap(g, p.text, inner);
    h += p.lines.length * p.lh + p.gap;
  }
  c.width = W;
  c.height = Math.max(64, Math.ceil(h + pad));
  const align = t.align || 'center';
  let y = pad;
  g.textBaseline = 'top';
  g.textAlign = align;
  g.shadowColor = 'rgba(0, 18, 28, 0.55)';
  g.shadowBlur = 28;
  for (const p of parts) {
    g.font = p.font;
    g.letterSpacing = p.spacing;
    g.fillStyle = p.color;
    for (const line of p.lines) { g.fillText(line, align === 'center' ? W / 2 : align === 'right' ? W - pad : pad, y); y += p.lh; }
    y += p.gap;
  }
  return c;
}

// ---------------------------------------------------------------------------------------------
// The GPU layer material. One per layer (they are few); the glass branch only exists when used.
// ---------------------------------------------------------------------------------------------
function layerMaterial(tex, withGlass) {
  const u = {
    opacity: uniform(1), reveal: uniform(1), mode: uniform(1), aspect: uniform(1), seed: uniform(Math.random() * 10),
    distort: uniform(0), caustic: uniform(0), chroma: uniform(0), glow: uniform(0), glass: uniform(0), radius: uniform(0.05),
    tint: uniform(new THREE.Color(0.55, 0.85, 1.0)),
  };
  const t = U.time, p = uv();
  const asp = vec2(1, u.aspect);

  // flowing water distortion
  const w1 = vec2(sin(p.y.mul(11).add(t.mul(1.3)).add(u.seed)), cos(p.x.mul(9).sub(t.mul(1.1)).add(u.seed.mul(1.7))));
  const w2 = vec2(sin(p.x.add(p.y).mul(23).sub(t.mul(2.1))), cos(p.y.sub(p.x).mul(19).add(t.mul(1.7))));
  const flow = w1.mul(0.011).add(w2.mul(0.004)).mul(u.distort);

  // reveal: an organic mask (caustic texture as noise) sweeping in as reveal goes 0 -> 1
  const nz = texture(causticTex, p.mul(asp).mul(0.85).add(vec2(u.seed, u.seed.mul(0.37)))).r;
  const centred = p.sub(0.5).mul(asp);
  const field = select(u.mode.equal(2), p.x.mul(0.8).add(nz.mul(0.2)),
    select(u.mode.equal(3), length(centred).mul(1.15).add(nz.mul(0.12)), nz.mul(0.85).add(0.075)));
  const edge = float(0.07);
  const m = select(u.mode.equal(0), float(1), smoothstep(field, field.add(edge), u.reveal.mul(float(1.2).add(edge)).sub(0.1)));
  const band = select(u.mode.equal(0), float(0), m.mul(float(1).sub(m)).mul(4)); // bright water edge on the front

  // uv: flow, plus a ripple ring pushing outward on the reveal front (ripple mode)
  const ring = select(u.mode.equal(3), normalize(centred.add(vec2(1e-4, 0))).mul(band).mul(0.035), vec2(0, 0));
  const uvD = p.add(flow).add(flow.mul(band).mul(3)).add(ring.div(asp));

  // chroma split (grows with scroll speed, see Layers.update)
  const ca = p.sub(0.5).mul(u.chroma.mul(0.02));
  let col, a;
  if (tex) {
    const c0 = texture(tex, uvD);
    col = vec3(texture(tex, uvD.add(ca)).r, c0.g, texture(tex, uvD.sub(ca)).b);
    a = c0.a;
  } else { col = vec3(0); a = float(0); }

  // caustic light dancing over the image (underwater feel)
  const cz = texture(causticTex, p.mul(asp).mul(1.6).add(vec2(t.mul(0.03), t.mul(0.02)))).r;
  const cz2 = texture(causticTex, p.mul(asp).mul(0.9).sub(vec2(t.mul(0.017), t.mul(-0.011)))).r;
  const light = pow(clamp(cz.mul(cz2).mul(2.2), 0, 1), 2);
  col = col.add(col.mul(light).mul(u.caustic.mul(1.5))).add(vec3(0.6, 0.9, 1.0).mul(pow(light, 1.5)).mul(u.caustic.mul(0.3)).mul(a));
  col = col.mul(u.glow.mul(2.5).add(1));
  col = col.add(vec3(0.65, 0.95, 1.0).mul(band).mul(1.6).mul(max(a, u.glass)));

  // frosted glass panel: the live scene behind, blurred and refracted, with a bright rim
  let alpha = a;
  if (withGlass) {
    const copy = new THREE.FramebufferTexture();
    copy.type = THREE.HalfFloatType;
    const half = vec2(0.5, u.aspect.mul(0.5));
    const q = abs(centred).sub(half).add(u.radius);
    const d = length(max(q, vec2(0, 0))).add(clamp(max(q.x, q.y), -1, 0)).sub(u.radius);
    const inside = smoothstep(0.004, -0.004, d);
    const rim = smoothstep(0.0, -0.012, d).sub(smoothstep(-0.012, -0.05, d));
    const g0 = screenUV.add(flow.mul(2)).add(centred.mul(-0.012));
    const o = 0.006;
    const blur = viewportTexture(clamp(g0, 0.001, 0.999), null, copy).rgb
      .add(viewportTexture(clamp(g0.add(vec2(o, o)), 0.001, 0.999), null, copy).rgb)
      .add(viewportTexture(clamp(g0.add(vec2(-o, o)), 0.001, 0.999), null, copy).rgb)
      .add(viewportTexture(clamp(g0.add(vec2(o, -o)), 0.001, 0.999), null, copy).rgb)
      .add(viewportTexture(clamp(g0.add(vec2(-o, -o)), 0.001, 0.999), null, copy).rgb).div(5);
    const sheen = smoothstep(0.35, -0.5, centred.y.add(centred.x.mul(0.4))).mul(0.06);
    const glassCol = blur.mul(mix(vec3(1), u.tint, 0.35)).mul(0.82).add(u.tint.mul(0.035)).add(vec3(0.8, 0.96, 1).mul(rim.mul(0.55).add(sheen)));
    const ga = inside.mul(u.glass);
    col = mix(glassCol, col, a);
    alpha = max(a, ga);
  }

  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false });
  mat.colorNode = col;
  mat.opacityNode = alpha.mul(m).mul(u.opacity);
  mat.userData.u = u;
  return mat;
}

export class Layers {
  constructor({ timeline, root, scene, data = null }) {
    this.tl = timeline;
    this.data = data; // DataHub: {{bindings}} in text / html / src
    this.dataVersion = -1;
    this.root = root; // the overlay container (#captions), container-type: size
    this.wrap = document.createElement('div');
    this.wrap.className = 'lays';
    root.append(this.wrap);
    this.group = new THREE.Group();
    this.group.name = 'layers';
    scene.add(this.group);
    this.items = new Map(); // track id -> { track, el, media, mesh, sig }
    this.version = -1;
    this.pickable = false; // editor: screen layers take the mouse (select / drag) in the Game view
    this.vel = 0; // story-time velocity (s/s), drives the chroma split
    this.lastX = null;
    this.lastT = performance.now();
    this.fontsReady = false;
    document.fonts?.ready.then(() => { this.fontsReady = true; this.version = -1; });
  }

  // a layer's content with {{bindings}} resolved and asset paths turned into URLs (what build() reads)
  resolved(t, item) {
    const R = (v, html) => (this.data ? this.data.resolve(v, { html, item }) : v);
    const r = { ...t, src: assetURL(R(t.src)), html: fixHTML(R(t.html, true)) };
    if (t.kind === 'text') for (const f of ['kicker', 'title', 'body']) r[f] = R(t[f]);
    return r;
  }

  // (re)build what changed since the last timeline / data version
  sync() {
    const seen = new Set();
    for (const t0 of this.tl.layers()) {
      t0.id ??= `layer-${Math.random().toString(36).slice(2, 8)}`;
      seen.add(t0.id);
      const t = this.resolved(t0);
      const gpu = isGPU(t);
      const text = t.kind === 'text' ? [t.kicker, t.title, t.body, t.size, t.maxLines, t.align, t.color, t.accent, this.fontsReady].join('¦') : '';
      const sig = [t.kind, gpu, t.src, t.kind === 'html' ? t.html : '', (t.glass ?? 0) > 0, text, t.kind === 'model' ? `${!!t.flip}:${t.anim ?? ''}` : ''].join('|');
      let it = this.items.get(t.id);
      if (!it || it.sig !== sig) {
        if (it) this.dispose(it);
        it = this.build(t, gpu);
        it.sig = sig;
        this.items.set(t.id, it);
      }
      it.track = t0;
    }
    for (const [id, it] of this.items) if (!seen.has(id)) { this.dispose(it); this.items.delete(id); }
    this.version = this.tl.version;
    this.dataVersion = this.data?.version ?? 0;
    this.preloadNext();
  }

  // inside a stretch region: warm the browser cache with the next item's pictures / videos, so they're ready
  preloadNext() {
    const it = this.data?.item;
    if (!it || it.k + 1 >= it.n) return;
    const next = this.data.itemFor(it.list, it.k + 1, it.n);
    for (const t of this.tl.layers()) {
      if (!/\{\{\s*item/.test(t.src ?? '') || !['image', 'video'].includes(t.kind)) continue;
      const url = assetURL(this.data.resolve(t.src, { item: next }));
      if (!url || this.preloaded?.has(url)) continue;
      (this.preloaded ??= new Set()).add(url);
      if (t.kind === 'image') { const im = new Image(); im.crossOrigin = 'anonymous'; im.src = url; } else fetch(url).catch(() => {});
    }
  }

  media(t, forTexture) {
    let m;
    if (t.kind === 'image') {
      m = new Image();
      m.decoding = 'async';
      m.draggable = false;
      if (forTexture) m.crossOrigin = 'anonymous';
      m.src = t.src || '';
    } else if (t.kind === 'video') {
      m = document.createElement('video');
      Object.assign(m, { muted: true, playsInline: true, preload: 'auto', loop: t.loop !== false });
      m.setAttribute('muted', '');
      m.setAttribute('playsinline', '');
      if (forTexture) m.crossOrigin = 'anonymous';
      m.src = t.src || '';
    } else if (t.kind === 'iframe') {
      m = document.createElement('iframe');
      m.src = t.src || 'about:blank';
      m.setAttribute('allow', 'autoplay; fullscreen');
      m.setAttribute('loading', 'lazy');
      // a click inside the page moves keyboard focus into it: pass Esc back out (same-origin pages, e.g. assets/)
      m.addEventListener('load', () => {
        try {
          m.contentWindow.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape' }));
          });
        } catch { /* cross-origin page: can't listen */ }
      });
    } else if (t.kind === 'text') {
      m = drawText(t);
    } else if (t.kind === 'glass' || t.kind === 'model') {
      m = null;
    } else {
      m = document.createElement('div');
      m.className = 'html';
      m.innerHTML = t.html || '';
    }
    return m;
  }

  build(t, gpu) {
    const it = { track: t, gpu };
    const m = it.media = this.media(t, gpu);
    if (!gpu) {
      const el = it.el = document.createElement('div');
      el.className = `layer layer-${t.kind}`;
      el.dataset.id = t.id;
      el.append(m);
      this.wrap.append(el);
      return it;
    }
    if (t.kind === 'model') return this.buildModel(it, t);
    // GPU plane: built once the image / video knows its size (text and glass right away)
    const make = () => {
      if (it.disposed || it.mesh) return;
      let tex = null;
      if (t.kind === 'video') { tex = new THREE.VideoTexture(m); it.aspect = m.videoHeight / m.videoWidth; }
      else if (t.kind === 'image') { tex = new THREE.Texture(m); it.aspect = m.naturalHeight / m.naturalWidth; }
      else if (t.kind === 'text') { tex = new THREE.CanvasTexture(m); it.aspect = m.height / m.width; }
      else it.aspect = 0.6;
      if (tex) { tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; tex.needsUpdate = true; }
      it.tex = tex;
      it.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), layerMaterial(tex, (t.glass ?? 0) > 0 || t.kind === 'glass'));
      it.mesh.renderOrder = 16;
      it.mesh.frustumCulled = false;
      it.mesh.userData.layerId = t.id;
      it.mesh.visible = false;
      this.group.add(it.mesh);
    };
    if (t.kind === 'video') m.addEventListener('loadeddata', make, { once: true });
    else if (t.kind === 'image') { if (m.complete && m.naturalWidth) make(); else m.addEventListener('load', make, { once: true }); }
    else make();
    return it;
  }

  // a GLB clip: a holder group in the scene (picking / visibility), the model added once loaded
  buildModel(it, t) {
    const holder = it.mesh = new THREE.Group();
    holder.userData.layerId = t.id;
    holder.visible = false;
    this.group.add(holder);
    it.loading = loadGLTF(t.src).then((gltf) => {
      if (it.disposed) return;
      // createAnimated: forward = +Z, length 1 m (scaled by the clip's width), materials converted, mixer
      const model = createAnimated(gltf, { length: 1, flip: !!t.flip, clone: true, style: { rim: 0.6 } });
      model.traverse((o) => {
        o.userData.layerId = t.id;
        if (!o.isMesh) return;
        o.castShadow = false;
        for (const m of [o.material].flat()) { m.transparent = true; m.depthWrite = true; } // fades via opacity (set once: no recompile)
      });
      const mixer = model.userData.mixer;
      mixer.stopAllAction();
      const clip = gltf.animations.find((a) => a.name === t.anim) ?? gltf.animations[0];
      if (clip) { it.action = mixer.clipAction(clip); it.action.play(); it.clipLen = clip.duration; }
      it.anims = gltf.animations.map((a) => a.name);
      it.model = model;
      holder.add(model);
    }).catch((e) => { console.warn(`model ${t.src}:`, e.message); });
    return it;
  }

  dispose(it) {
    it.disposed = true;
    it.el?.remove();
    if (it.media?.tagName === 'VIDEO') { it.media.pause(); it.media.removeAttribute('src'); it.media.load(); }
    if (it.mesh) {
      this.group.remove(it.mesh);
      if (it.mesh.isMesh) {
        it.mesh.geometry.dispose();
        it.tex?.dispose();
        it.mesh.material.dispose();
      }
    }
  }

  // current state of a layer at story time x: { o (incl. fade), f (fade / reveal 0..1), x, y | pos (+ rot), s, r }
  state(t, x) {
    const k = evalKeys(t.keys ?? [], x, { ...(t.kind === 'model' ? MODEL_KEY : t.space === 'world' ? WORLD_KEY : SCREEN_KEY) });
    k.f = this.tl.muted(t) ? 0 : captionOpacity(t, x, this.tl.duration);
    k.o = (k.o ?? 1) * k.f;
    return k;
  }

  // a GPU screen layer's rectangle in % of the view (for picking / the editor's selection box)
  rect(t, k, viewAspect) {
    const it = this.items.get(t.id), w = (t.w ?? 30) * k.s;
    const h = t.h ? t.h * k.s : (w * (it?.aspect ?? 0.6) * viewAspect);
    return { x: k.x, y: k.y, w, h };
  }

  // shot: the story camera (screen GPU layers ride in front of it); view: the camera rendering (billboards)
  update(x, view, shot = view) {
    if (this.version !== this.tl.version || this.dataVersion !== (this.data?.version ?? 0)) this.sync();
    const now = performance.now(), dt = Math.max(1e-3, (now - this.lastT) / 1000);
    if (this.lastX !== null) this.vel += ((x - this.lastX) / dt - this.vel) * Math.min(1, dt * 6);
    this.lastX = x;
    this.lastT = now;
    const speed = Math.min(1.5, Math.abs(this.vel) * 0.4);
    for (const it of this.items.values()) {
      const t = it.track, k = this.state(t, x), on = k.f > 0.002 && k.o > 0.002;
      const m = it.media;
      if (m?.tagName === 'VIDEO') this.video(m, t, x, on);
      if (t.kind === 'model') { this.model(it, t, k, on, x); continue; }
      if (it.gpu) { this.gpu(it, t, k, on, view, shot, speed); continue; }
      const st = it.el.style;
      st.display = on ? '' : 'none';
      if (!on) continue;
      st.left = `${k.x}%`;
      st.top = `${k.y}%`;
      st.width = `${t.w ?? 30}cqw`;
      st.height = t.h ? `${t.h}cqh` : t.kind === 'iframe' ? '40cqh' : '';
      it.el.classList.toggle('fixed-h', !!t.h || t.kind === 'iframe');
      st.transform = `translate(-50%, -50%) rotate(${k.r}deg) scale(${k.s})`;
      st.opacity = k.o.toFixed(3);
      st.zIndex = String(Math.round(t.z ?? 5));
      st.pointerEvents = this.pickable || (t.interactive && !this.editing) ? 'auto' : 'none';
      if (t.fit && m.tagName !== 'DIV') m.style.objectFit = t.fit;
      if (t.shrink && m.tagName === 'DIV') this.shrink(it);
    }
  }

  // "Shrink to fit": an HTML layer whose content (e.g. a CMS list) outgrows its box is scaled down to fit
  shrink(it) {
    const el = it.el, m = it.media;
    const key = `${el.clientWidth}x${el.clientHeight}|${it.sig}`;
    if (key === it.fitKey || !el.clientHeight) return;
    it.fitKey = key;
    m.style.zoom = 1;
    const s = Math.min(1, el.clientHeight / Math.max(1, m.scrollHeight), el.clientWidth / Math.max(1, m.scrollWidth));
    m.style.zoom = s < 0.999 ? s.toFixed(3) : '';
  }

  gpu(it, t, k, on, view, shot, speed) {
    const mesh = it.mesh;
    if (!mesh) return;
    mesh.visible = on;
    if (!on) return;
    const u = mesh.material.userData.u;
    const reveal = REVEALS[t.reveal ?? 'dissolve'] ?? 1;
    u.mode.value = reveal;
    u.reveal.value = k.f;
    u.opacity.value = reveal === 0 ? k.o : (k.o / Math.max(k.f, 1e-3));
    for (const f of FX) u[f].value = t[f] ?? (f === 'glass' && t.kind === 'glass' ? 1 : 0);
    u.chroma.value = (t.chroma ?? 0) * (0.25 + speed);
    u.radius.value = t.radius ?? 0.05;
    if (t.tint) u.tint.value.set(t.tint);
    let aspect = it.aspect || 0.6;
    if (t.space === 'world') {
      const w = (t.w ?? 8) * k.s;
      if (t.kind === 'glass' && t.h) aspect = t.h / (t.w ?? 8);
      mesh.position.fromArray(k.pos);
      mesh.scale.set(w, w * aspect, 1);
      if (t.billboard !== false) mesh.quaternion.copy(view.quaternion);
      else mesh.rotation.set(0, THREE.MathUtils.degToRad(k.r), 0);
    } else {
      // ride in front of the story camera at `depth` m: fish nearer than that pass in front
      const D = t.depth ?? 8;
      const H = 2 * D * Math.tan(THREE.MathUtils.degToRad(shot.fov) / 2), W = H * shot.aspect;
      const w = ((t.w ?? 30) / 100) * W * k.s;
      const hgt = t.h ? (t.h / 100) * H * k.s : w * aspect;
      aspect = hgt / w;
      const q = shot.quaternion;
      mesh.position.set(((k.x / 100) - 0.5) * W, (0.5 - (k.y / 100)) * H, -D).applyQuaternion(q).add(shot.position);
      mesh.quaternion.copy(q).multiply(_rz.setFromAxisAngle(_z, THREE.MathUtils.degToRad(-k.r)));
      mesh.scale.set(w, hgt, 1);
    }
    u.aspect.value = aspect;
  }

  model(it, t, k, on, x) {
    const h = it.mesh;
    if (!h) return;
    h.visible = on && !!it.model;
    if (!h.visible) return;
    h.position.fromArray(k.pos);
    const r = k.rot ?? [0, 0, 0], d = THREE.MathUtils.degToRad;
    h.rotation.set(d(r[0]), d(r[1]), d(r[2]), 'YXZ');
    h.scale.setScalar((t.w ?? 6) * k.s);
    if (k.o !== it.lastO) {
      it.lastO = k.o;
      it.model.traverse((o) => { if (o.isMesh) for (const m of [o.material].flat()) m.opacity = k.o; });
    }
    // its own animation: scrubbed by the story time (scroll back = rewind) or running on its own
    if (it.action && t.anim !== 'none') {
      const time = t.scrub === false ? performance.now() / 1000 * (t.rate ?? 1) : Math.max(0, x - t.a) * (t.rate ?? 1);
      it.model.userData.mixer.setTime(it.clipLen ? time % it.clipLen : time);
    }
  }

  // looping videos play while visible; "scrub" videos follow the story time (scrolling plays them)
  video(v, t, x, on) {
    if (!on) { if (!v.paused) v.pause(); return; }
    if (t.scrub) {
      if (!v.paused) v.pause();
      if (v.readyState >= 2 && v.duration) {
        let ct = Math.max(0, (x - t.a) * (t.rate ?? 1));
        ct = t.loop !== false ? ct % v.duration : Math.min(ct, v.duration - 0.05);
        if (Math.abs(v.currentTime - ct) > 0.04) v.currentTime = ct;
      }
    } else if (v.paused) v.play().catch(() => {});
  }

  item(id) { return this.items.get(id); }

  // resolves when the GPU layers' images / videos are loaded (or after `ms`)
  ready(ms) {
    const waits = [];
    for (const it of this.items.values()) {
      if (it.loading) { waits.push(it.loading); continue; }
      const m = it.media;
      if (!it.gpu || it.mesh || !m) continue;
      if (m.tagName === 'IMG') waits.push(new Promise((r) => { m.addEventListener('load', r, { once: true }); m.addEventListener('error', r, { once: true }); }));
      if (m.tagName === 'VIDEO') waits.push(new Promise((r) => { m.addEventListener('loadeddata', r, { once: true }); m.addEventListener('error', r, { once: true }); }));
    }
    return Promise.race([Promise.all(waits), new Promise((r) => setTimeout(r, ms))]).then(() => new Promise((r) => setTimeout(r, 0)));
  }
}

const _rz = new THREE.Quaternion(), _z = new THREE.Vector3(0, 0, 1);
