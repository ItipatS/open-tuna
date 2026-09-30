// Scroll-driven story: one progress value (0..1, smoothed) drives the camera, the school, the
// water "50" and the tuna stunts. Everything is a function of progress, so scrolling back rewinds.
import * as THREE from 'three/webgpu';

const { clamp, lerp, smoothstep } = THREE.MathUtils;
const ease = (k) => k * k * (3 - 2 * k);
const range = (p, a, b) => clamp((p - a) / (b - a), 0, 1);

// Per-fish leap targets for FishSwarm (see its `targets` contract). A few tuna leap through the hole
// of the "0" (hoop); most leap across / toward / over the camera in the band between it and the 50.
export function flightTargets(G, max, { hoop = 14, free = 70 } = {}) {
  const launch = new Float32Array(max * 4).fill(-1), land = new Float32Array(max * 4).fill(-1);
  const R = (a, b) => a + Math.random() * (b - a);
  const put = (i, L, E, apex, group) => { launch.set([...L, group + Math.random()], i * 4); land.set([...E, apex], i * 4); };
  for (let k = 0; k < hoop; k++) {
    const x = G.hole.x + R(-0.2, 0.2) * G.holeSize.x, dir = Math.random() < 0.5 ? 1 : -1;
    put(k, [x, -1.2, 14 * dir], [x + R(-1, 1), -1.2, -14 * dir], G.hole.y + R(-0.18, 0.18) * G.holeSize.y, 10);
  }
  for (let k = 0; k < free; k++) {
    const r = Math.random();
    let L, E, apex;
    if (r < 0.6) { // across the view
      const z = R(10, 32), side = Math.random() < 0.5 ? 1 : -1;
      L = [side * R(6, 22), -1, z + R(-3, 3)]; E = [-side * R(6, 22), -1, z + R(-3, 3)]; apex = R(3, 9);
    } else if (r < 0.8) { // toward and over the camera
      const x = R(-8, 8);
      L = [x, -1, R(18, 28)]; E = [x + R(-5, 5), -1, R(52, 64)]; apex = R(8, 11);
    } else { // from under the camera, away toward the 50
      const x = R(-10, 10);
      L = [x, -1, R(40, 48)]; E = [x + R(-6, 6), -1, R(12, 22)]; apex = R(4, 8);
    }
    put(hoop + k, L, E, apex, 20);
  }
  return { launch, land };
}

export class Story {
  constructor({ camera, tuna, tentacles, G, setSun, captions }) {
    Object.assign(this, { camera, tuna, tentacles, G, setSun });
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
    const tu = this.tentacles.userData;

    // midday light underwater -> golden hour behind the 50 once we surface
    const gh = ease(range(p, 0.4, 0.66));
    this.setSun(lerp(55, 7, gh), lerp(0.9, 0.42 - Math.PI, gh)); // swings behind the camera, never across the frame

    // --- water tentacles braid up out of the sea, unfurl and draw the 50 (see tentacles.js)
    tu.u.visible.value = smoothstep(p, 0.43, 0.46);
    this.tentacles.visible = p > 0.43;
    if (this.tentacles.visible) tu.update(range(p, 0.44, 0.92), t);

    // --- school: wander at depth, then gather under the glyph
    const gather = smoothstep(p, 0.22, 0.46);
    tuna.u.goal.value.set(
      Math.cos(t * 0.045) * 10 * (1 - gather),
      lerp(-9 + Math.sin(t * 0.11) * 1.5, -4.5, gather),
      Math.sin(t * 0.063) * 8 * (1 - gather) + 18 * gather,
    );
    tuna.u.free.value = p > 0.5 ? 1 : 0;
    tuna.u.hoop.value = p > 0.84 ? 1 : 0;

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
      // III/IV: above the sea, slow arc + push-in while the tentacles draw the 50
      const k = ease(range(p, 0.5, 1));
      const a = -0.3 * k + Math.sin(t * 0.15) * 0.015;
      const r = lerp(50, 42, k);
      camera.position.set(Math.sin(a) * r, lerp(5, 6.5, k) + Math.sin(t * 0.4) * 0.15, Math.cos(a) * r);
      look.set(C.x, lerp(4, C.y - 0.5, ease(range(p, 0.52, 0.84))), C.z);
    }
    camera.lookAt(look);

    for (const c of this.captions) {
      const o = Math.min(smoothstep(p, c.a, c.a + 0.04), 1 - smoothstep(p, c.b - 0.04, c.b));
      c.el.style.opacity = o.toFixed(3);
      c.el.style.transform = `translateY(${((1 - o) * 14).toFixed(1)}px)`;
    }
  }
}
