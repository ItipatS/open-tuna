// Turntable previews of 3D models (.glb) for the Assets tab and the inspector. Rendered once on the editor's own
// WebGPU renderer (offscreen, between frames) into a strip of FRAMES views around the model, then cached in the
// browser (Cache API) per file + size + date. Hovering a `.ed-spin` element steps through the strip (CSS).
import * as THREE from 'three/webgpu';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { loadGLTF } from '../layers.js';
import { assetURL } from '../project.js';
import { h } from './dom.js';

export const FRAMES = 24;
const S = 160; // px per frame: a readback row (S × 8 bytes, half floats) must be a multiple of 256 bytes
const CACHE = 'open-tuna-thumbs-v1';
const AUTO_MAX = 24 * 1048576; // bigger files render on hover only (they take a while to load)

const toSRGB = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

export class ModelThumbs {
  constructor(renderer) {
    this.renderer = renderer;
    this.urls = new Map(); // key -> Promise<object URL>
    this.queue = Promise.resolve(); // one model at a time
  }

  // asset {file, size, mtime} -> Promise<object URL of the strip (FRAMES·S × S webp)>
  get(a) {
    const key = `${a.file}|${a.size ?? ''}|${a.mtime ?? ''}`;
    if (!this.urls.has(key)) {
      const p = this.load(a.file, key);
      p.catch(() => this.urls.delete(key)); // retry next time
      this.urls.set(key, p);
    }
    return this.urls.get(key);
  }

  async load(file, key) {
    const req = new Request(`https://thumbs.open-tuna.local/${encodeURIComponent(key)}`);
    let cache = null;
    try {
      cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return URL.createObjectURL(await hit.blob());
    } catch { cache = null; }
    const job = this.queue.catch(() => {}).then(() => this.render(file));
    this.queue = job;
    const blob = await job;
    try { await cache?.put(req, new Response(blob, { headers: { 'Content-Type': 'image/webp' } })); } catch { /* not cached */ }
    return URL.createObjectURL(blob);
  }

  async render(file) {
    const gltf = await loadGLTF(assetURL(file));
    const model = cloneSkinned(gltf.scene);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xe4f6ff, 0x1a2a38, 1.8));
    const key = new THREE.DirectionalLight(0xfff4e6, 2.8);
    key.position.set(3, 5, 4);
    const rim = new THREE.DirectionalLight(0x7fe0ff, 2.0);
    rim.position.set(-4, 2, -5);
    const pivot = new THREE.Group();
    pivot.add(model);
    scene.add(key, rim, pivot);
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    if (box.isEmpty()) throw new Error('empty model');
    model.position.sub(box.getCenter(new THREE.Vector3()));
    const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
    const cam = new THREE.PerspectiveCamera(30, 1, radius / 50, radius * 50);
    const dist = (radius / Math.sin(THREE.MathUtils.degToRad(15))) * 1.02, el = THREE.MathUtils.degToRad(16);
    cam.position.set(0, Math.sin(el) * dist, Math.cos(el) * dist);
    cam.lookAt(0, 0, 0);

    const r = this.renderer;
    const rt = new THREE.RenderTarget(S, S, { type: THREE.HalfFloatType });
    const strip = new OffscreenCanvas(S * FRAMES, S), g = strip.getContext('2d');
    const img = g.createImageData(S, S), out = img.data, half = THREE.DataUtils.fromHalfFloat;
    const prevColor = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
    try {
      for (let i = 0; i < FRAMES; i++) {
        pivot.rotation.y = -0.75 + (i / FRAMES) * Math.PI * 2;
        // the main loop renders between our awaits: change renderer state only around this one render
        const prevTarget = r.getRenderTarget();
        r.setClearColor(0x000000, 0);
        r.setRenderTarget(rt);
        r.render(scene, cam);
        r.setRenderTarget(prevTarget);
        r.setClearColor(prevColor, prevAlpha);
        const px = await r.readRenderTargetPixelsAsync(rt, 0, 0, S, S);
        // linear HDR (half floats) -> tone-mapped sRGB bytes
        for (let p = 0; p < S * S * 4; p += 4) {
          const a = Math.min(1, half(px[p + 3]));
          for (let c = 0; c < 3; c++) {
            const v = half(px[p + c]) * 1.1;
            out[p + c] = Math.round(toSRGB(Math.min(1, v / (1 + v * 0.55))) * 255);
          }
          out[p + 3] = Math.round(a * 255);
        }
        g.putImageData(img, i * S, 0);
      }
    } finally {
      rt.dispose();
    }
    return strip.convertToBlob({ type: 'image/webp', quality: 0.86 });
  }

  // a square turntable element: frame 0 at rest, spins on hover. Big files render on the first hover.
  spin(a, { label = '3D MODEL' } = {}) {
    const el = h('div', { class: 'ed-spin' }, h('span', { class: 'ico' }, label));
    const go = () => {
      el.classList.add('busy');
      this.get(a).then((url) => {
        el.style.backgroundImage = `url("${url}")`;
        el.replaceChildren();
        el.classList.remove('busy');
        el.classList.add('ready');
      }).catch(() => { el.classList.remove('busy'); el.firstChild && (el.firstChild.textContent = 'no preview'); });
    };
    if (!a.size || a.size <= AUTO_MAX) go();
    else {
      el.firstChild.textContent = `${label} · hover to preview`;
      el.addEventListener('pointerenter', go, { once: true });
    }
    return el;
  }
}
