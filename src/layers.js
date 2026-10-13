// Media layers from story.json `layer` tracks: images, videos, HTML (text / GUI) and web pages (iframes),
// either over the canvas ("screen", stacked with the captions, positioned in % of the view) or as planes in
// the 3D world ("world", images / videos only, optionally always facing the camera). Each layer is visible
// from `a` to `b` (s) with a `fade`, and keyframes animate its position / scale / rotation / opacity —
// moving layers at different speeds as the visitor scrolls gives parallax.
// Rebuilt incrementally when the timeline changes (a video / iframe only reloads when its source changes).
import * as THREE from 'three/webgpu';
import { evalKeys, captionOpacity } from './timeline.js';

export const SCREEN_KEY = { x: 50, y: 50, s: 1, r: 0, o: 1 };
export const WORLD_KEY = { pos: [0, 8, 10], s: 1, r: 0, o: 1 };
export const MEDIA_EXT = { image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif'], video: ['mp4', 'webm', 'mov', 'm4v'], iframe: ['html', 'htm'] };

export function kindOf(name) {
  const ext = String(name).split('?')[0].split('.').pop().toLowerCase();
  return Object.keys(MEDIA_EXT).find((k) => MEDIA_EXT[k].includes(ext)) ?? null;
}

export class Layers {
  constructor({ timeline, root, scene }) {
    this.tl = timeline;
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
    this.k = {};
  }

  // (re)build what changed since the last timeline version
  sync() {
    const seen = new Set();
    for (const t of this.tl.layers()) {
      t.id ??= `layer-${Math.random().toString(36).slice(2, 8)}`;
      seen.add(t.id);
      const world = t.space === 'world' && (t.kind === 'image' || t.kind === 'video');
      const sig = [t.kind, world, t.src, t.kind === 'html' ? t.html : ''].join('|');
      let it = this.items.get(t.id);
      if (!it || it.sig !== sig) {
        if (it) this.dispose(it);
        it = this.build(t, world);
        it.sig = sig;
        this.items.set(t.id, it);
      }
      it.track = t;
    }
    for (const [id, it] of this.items) if (!seen.has(id)) { this.dispose(it); this.items.delete(id); }
    this.version = this.tl.version;
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
    } else {
      m = document.createElement('div');
      m.className = 'html';
      m.innerHTML = t.html || '';
    }
    return m;
  }

  build(t, world) {
    const it = { track: t, world };
    const m = it.media = this.media(t, world);
    if (!world) {
      const el = it.el = document.createElement('div');
      el.className = `layer layer-${t.kind}`;
      el.dataset.id = t.id;
      el.append(m);
      this.wrap.append(el);
      return it;
    }
    // world plane: created once the image / video knows its size
    const make = () => {
      if (it.disposed || it.mesh) return;
      const isVid = t.kind === 'video';
      const tex = isVid ? new THREE.VideoTexture(m) : new THREE.Texture(m);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      it.aspect = isVid ? m.videoHeight / m.videoWidth : m.naturalHeight / m.naturalWidth;
      const mat = new THREE.MeshBasicNodeMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false, fog: false });
      it.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      it.mesh.renderOrder = 15;
      it.mesh.userData.layerId = t.id;
      it.mesh.visible = false;
      this.group.add(it.mesh);
    };
    if (t.kind === 'video') m.addEventListener('loadeddata', make, { once: true });
    else if (m.complete && m.naturalWidth) make(); else m.addEventListener('load', make, { once: true });
    return it;
  }

  dispose(it) {
    it.disposed = true;
    it.el?.remove();
    if (it.media?.tagName === 'VIDEO') { it.media.pause(); it.media.removeAttribute('src'); it.media.load(); }
    if (it.mesh) {
      this.group.remove(it.mesh);
      it.mesh.geometry.dispose();
      it.mesh.material.map?.dispose();
      it.mesh.material.dispose();
    }
  }

  // current state of a layer at story time x: { o (incl. fade), x, y | pos, s, r }
  state(t, x) {
    const k = evalKeys(t.keys ?? [], x, { ...(t.space === 'world' ? WORLD_KEY : SCREEN_KEY) });
    k.o = (k.o ?? 1) * (t.mute ? 0 : captionOpacity(t, x, this.tl.duration));
    return k;
  }

  update(x, camera) {
    if (this.version !== this.tl.version) this.sync();
    for (const it of this.items.values()) {
      const t = it.track, k = this.state(t, x), on = k.o > 0.002;
      const m = it.media;
      if (m.tagName === 'VIDEO') this.video(m, t, x, on);
      if (it.world) {
        if (!it.mesh) continue;
        it.mesh.visible = on;
        if (!on) continue;
        const w = (t.w ?? 8) * k.s;
        it.mesh.position.fromArray(k.pos);
        it.mesh.scale.set(w, w * (it.aspect || 0.5625), 1);
        if (t.billboard !== false) it.mesh.quaternion.copy(camera.quaternion);
        else it.mesh.rotation.set(0, THREE.MathUtils.degToRad(k.r), 0);
        it.mesh.material.opacity = k.o;
        continue;
      }
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
}
