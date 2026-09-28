// Scroll-driven story: one progress value (0..1, smoothed) drives the camera, the school, the
// water "50" and the tuna stunts. Everything is a function of progress, so scrolling back rewinds.
import * as THREE from 'three/webgpu';

const { clamp, lerp, smoothstep } = THREE.MathUtils;
const ease = (k) => k * k * (3 - 2 * k);
const range = (p, a, b) => clamp((p - a) / (b - a), 0, 1);

// Per-fish flight targets for FishSwarm (see its `targets` contract): a few tuna live inside the
// water glyph, a squad leaps through the hole of the "0"; the rest just school.
export function flightTargets(G, max, { inside = 90, hoop = 140 } = {}) {
  const out = new Float32Array(max * 4).fill(-1);
  G.insidePoints(inside, 1.6).forEach((p, i) => out.set([p.x, p.y, p.z, Math.random() * 0.4], i * 4));
  for (let k = 0; k < hoop; k++) {
    out.set([(Math.random() - 0.5) * G.holeSize.x * 0.4, (Math.random() - 0.5) * G.holeSize.y * 0.35,
      Math.random() < 0.5 ? 1 : -1, 10 + Math.random()], (inside + k) * 4);
  }
  return out;
}

export class Story {
  constructor({ camera, tuna, glyph, drips, G, setSun, captions }) {
    Object.assign(this, { camera, tuna, glyph, drips, G, setSun });
    this.captions = [...captions].map((el) => ({ el, a: +el.dataset.in, b: +el.dataset.out }));
    this.p = 0;
    this.look = new THREE.Vector3();
    this.forceP = null; // tests / debugging: pin progress
  }

  target() {
    if (this.forceP !== null) return this.forceP;
    const max = document.documentElement.scrollHeight - innerHeight;
    return max > 0 ? clamp(scrollY / max, 0, 1) : 0;
  }

  update(dt, t) {
    const pt = this.target();
    this.p = this.forceP !== null ? pt : this.p + (pt - this.p) * (1 - Math.exp(-dt * 2.4));
    const p = this.p;
    const { camera, tuna, look, G } = this;
    const gu = this.glyph.userData.u, du = this.drips.userData.u;

    // --- the water 50 rises out of the sea, dragging liquid columns that snap off, then hovers
    // midday light underwater -> golden hour behind the 50 once we surface
    const gh = ease(range(p, 0.4, 0.66));
    this.setSun(lerp(55, 9, gh), lerp(0.9, Math.PI - 0.1, gh));

    const rise = ease(range(p, 0.48, 0.68));
    const lift = -(G.height + 4) * (1 - rise) + rise * Math.sin(t * 0.6) * 0.25;
    gu.lift.value = lift;
    gu.tendril.value = ease(range(p, 0.5, 0.56)) * (1 - ease(range(p, 0.71, 0.78)));
    du.lift.value = lift;
    du.drip.value = p < 0.48 ? 0 : lerp(0.12, 1, range(p, 0.5, 0.56) * (1 - range(p, 0.7, 0.8)));
    this.glyph.visible = this.drips.visible = p > 0.4;

    // --- school: wander at depth, then gather under the glyph
    const gather = smoothstep(p, 0.22, 0.46);
    tuna.u.goal.value.set(
      Math.cos(t * 0.045) * 10 * (1 - gather),
      lerp(-9 + Math.sin(t * 0.11) * 1.5, -4.5, gather),
      Math.sin(t * 0.063) * 8 * (1 - gather) + 4 * gather,
    );
    tuna.u.lift.value = lift;
    tuna.u.form.value = range(p, 0.44, 0.62);
    tuna.u.hoop.value = p > 0.72 ? 1 : 0;

    // --- camera
    const R = 26, C = G.center;
    if (p < 0.3) {
      // I: underwater, slow arc around the school
      const a = lerp(-1.1, 0, ease(p / 0.3));
      camera.position.set(Math.sin(a) * R, -9 + Math.sin(t * 0.25) * 0.5, Math.cos(a) * R);
      look.copy(tuna.u.goal.value);
    } else if (p < 0.5) {
      // II: ascend and break the surface, tilting up toward where the 50 will rise
      const k = ease(range(p, 0.3, 0.5));
      camera.position.set(0, lerp(-9, 5, k), lerp(R, 50, k));
      look.lerpVectors(tuna.u.goal.value, new THREE.Vector3(C.x, C.y * 0.6, C.z), ease(range(p, 0.34, 0.5)));
    } else {
      // III/IV: above the sea, slow arc + push-in while the 50 rises
      const k = ease(range(p, 0.5, 1));
      const a = -0.3 * k + Math.sin(t * 0.15) * 0.015;
      const r = lerp(50, 42, k);
      camera.position.set(Math.sin(a) * r, lerp(5, 6.5, k) + Math.sin(t * 0.4) * 0.15, Math.cos(a) * r);
      look.set(C.x, lerp(C.y * 0.6, C.y - 0.5, rise), C.z);
    }
    camera.lookAt(look);

    for (const c of this.captions) {
      const o = Math.min(smoothstep(p, c.a, c.a + 0.04), 1 - smoothstep(p, c.b - 0.04, c.b));
      c.el.style.opacity = o.toFixed(3);
      c.el.style.transform = `translateY(${((1 - o) * 14).toFixed(1)}px)`;
    }
  }
}
