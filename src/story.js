// Scroll-driven story: scroll progress p (0..1, smoothed) maps to story time x = p · duration (s), which
// drives the camera, sun, school, the water "50", the tuna stunts and the captions. *When* things happen
// lives in story.json (see timeline.js), edited with the timeline editor (?edit); *what* happens is code
// here and in the systems. Everything is a function of x, so scrolling back rewinds.
import * as THREE from 'three/webgpu';
import { captionOpacity } from './timeline.js';

const { clamp, lerp } = THREE.MathUtils;

// Scalar parameters a `curve` track can animate (constant default in story.json settings.params).
export const PARAMS = {
  'sun.elevation': { label: 'Sun elevation (°)', def: 55, min: -5, max: 90, step: 0.5 },
  'sun.azimuth': { label: 'Sun azimuth (°)', def: 51.6, min: -180, max: 180, step: 1 },
  'post.exposure': { label: 'Exposure', def: 1.05, min: 0.2, max: 3, step: 0.01 },
  'post.bloom': { label: 'Bloom', def: 0.28, min: 0, max: 2, step: 0.01 },
  'post.skyRays': { label: 'Sky god rays', def: 0.6, min: 0, max: 3, step: 0.01 },
  'post.underRays': { label: 'Underwater god rays', def: 0.34, min: 0, max: 2, step: 0.01 },
  'sea.state': { label: 'Sea state', def: 0.45, min: 0, max: 2, step: 0.01 },
  'water.clarity': { label: 'Water clarity', def: 0.7, min: 0, max: 1, step: 0.01 },
};

// Creatures a `path` track can steer (see Story.actors, set up in main.js).
export const ACTORS = {
  school: 'Tuna school', bluewhale: 'Blue whale', humpback: 'Humpback whale',
  shark1: 'Shark 1', shark2: 'Shark 2', turtle1: 'Turtle 1', turtle2: 'Turtle 2',
};

// Story beats a `clip` track can drive (0..1 ramp across the clip, or a 0/1 gate).
export const DRIVERS = {
  'school.gather': 'School gathers in front of the 50 (ramp)',
  'tentacles.fade': 'Water 50 fades in (ramp)',
  'tentacles.form': 'Water 50: braid → unfurl → draw → settle (ramp)',
  'tuna.free': 'Tuna leap across / over the camera (gate)',
  'tuna.hoop': 'Tuna leap through the 0 (gate)',
};

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

// w = (switched on at, switched off at) in sim time; 1e9 = never / still on
function gate(w, on, t) {
  if (on) { if (w.x > 1e8 || w.y < 1e8) w.set(t, 1e9); } else if (w.x < 1e8 && w.y > 1e8) w.y = t;
}

export class Story {
  // apply: { sun(elevationDeg, azimuthRad), [param id]: (value) => void } for the PARAMS above
  // actors: { school, bluewhale: Object3D, … } — what path tracks can move (ACTORS)
  constructor({ tuna, tentacles, timeline, apply, captionLayer, actors = {} }) {
    Object.assign(this, { tuna, tentacles, timeline, apply, captionLayer, actors });
    this.pk = { pos: [0, 0, 0], ahead: [0, 0, 0], w: 0 };
    this.tmpV = new THREE.Vector3();
    this.tmpM = new THREE.Matrix4();
    this.tmpQ = new THREE.Quaternion();
    this.cam = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.2, 9000); // the shot camera
    this.look = new THREE.Vector3(); // where the shot camera looks
    this.k = { pos: [0, 0, 0], look: [0, 0, 0], follow: 0, fov: 50, drift: 1 };
    this.p = 0; // scroll progress 0..1
    this.x = 0; // story time (s) = p · duration
    this.forceP = null; // editor / tests: pin progress (no smoothing)
    this.capVersion = -1;
  }

  target() {
    if (this.forceP !== null) return this.forceP;
    const max = document.documentElement.scrollHeight - innerHeight;
    return max > 0 ? clamp(scrollY / max, 0, 1) : 0;
  }

  update(dt, t) {
    const pt = this.target();
    this.p = this.forceP !== null ? pt : this.p + (pt - this.p) * (1 - Math.exp(-dt * 2.4));
    this.evaluate(this.p, t);
  }

  // p = progress 0..1, t = simulation time (idle motion)
  evaluate(p, t) {
    const { tuna, timeline: tl, apply, cam, look, k } = this;
    const tu = this.tentacles.userData;
    const x = this.x = p * tl.duration;

    // sun + post / sea parameters (curves or constants)
    apply.sun(tl.param('sun.elevation', x, PARAMS['sun.elevation'].def), THREE.MathUtils.degToRad(tl.param('sun.azimuth', x, PARAMS['sun.azimuth'].def)));
    for (const id in PARAMS) if (apply[id]) apply[id](tl.param(id, x, PARAMS[id].def));

    // water tentacles braid up out of the sea, unfurl and draw the 50 (see tentacles.js)
    const fade = tl.clip('tentacles.fade', x);
    tu.u.visible.value = fade;
    this.tentacles.visible = fade > 0;
    if (this.tentacles.visible) tu.update(tl.clip('tentacles.form', x), t);

    // school: wander at depth, then gather under the leap band in front of the 50
    const gather = tl.clip('school.gather', x);
    tuna.u.goal.value.set(
      Math.cos(t * 0.045) * 10 * (1 - gather),
      lerp(-9 + Math.sin(t * 0.11) * 1.5, -4.5, gather),
      Math.sin(t * 0.063) * 8 * (1 - gather) + 18 * gather,
    );
    tuna.u.free.value = tl.clip('tuna.free', x);
    tuna.u.hoop.value = tl.clip('tuna.hoop', x);
    // creature paths: blend each actor from what it does by itself toward its keyed route
    let schoolW = 0;
    for (const pt of tl.paths()) {
      const k = tl.path(pt, x, this.pk);
      if (k.w <= 0) continue;
      const P = this.tmpV.fromArray(k.pos);
      if (pt.bind === 'school') { tuna.u.goal.value.lerp(P, k.w); schoolW = Math.max(schoolW, k.w); continue; }
      const obj = this.actors[pt.bind];
      if (!obj) continue;
      obj.position.lerp(P, k.w);
      const A = new THREE.Vector3().fromArray(k.ahead);
      if (A.distanceToSquared(P) > 1e-6) {
        this.tmpM.lookAt(A, P, obj.up); // Object3D convention: +Z faces the target
        this.tmpQ.setFromRotationMatrix(this.tmpM);
        obj.quaternion.slerp(this.tmpQ, k.w);
      }
    }

    // a school on a path keeps up with it: stronger pull to the goal, tighter school (restored afterwards)
    const su = tuna.u;
    if (schoolW > 0) {
      const sb = this.schoolBase ??= { wGoal: su.wGoal.value, spread: su.goalSpread.value.clone() };
      su.wGoal.value = lerp(sb.wGoal, 6, schoolW);
      su.goalSpread.value.set(lerp(sb.spread.x, Math.min(sb.spread.x, 9), schoolW), sb.spread.y, lerp(sb.spread.z, Math.min(sb.spread.z, 9), schoolW));
    } else if (this.schoolBase) {
      su.wGoal.value = this.schoolBase.wGoal;
      su.goalSpread.value.copy(this.schoolBase.spread);
      this.schoolBase = null;
    }

    // leap windows (sim time on / off): a fish only starts a leap cycle while its group is on
    gate(tuna.u.freeWin.value, tuna.u.free.value > 0.5, t);
    gate(tuna.u.hoopWin.value, tuna.u.hoop.value > 0.5, t);

    // camera: keyframed path + slow hand-held drift; `follow` blends the look-at toward the school
    if (tl.camera(x, k)) {
      cam.position.fromArray(k.pos);
      cam.position.x += Math.sin(t * 0.15) * 0.6 * k.drift;
      cam.position.y += Math.sin(t * 0.25) * 0.4 * k.drift;
      cam.position.z += Math.cos(t * 0.19) * 0.3 * k.drift;
      look.fromArray(k.look).lerp(tuna.u.goal.value, k.follow);
      cam.lookAt(look);
      if (cam.fov !== k.fov) { cam.fov = k.fov; cam.updateProjectionMatrix(); }
    }
    cam.updateMatrixWorld();

    // captions
    if (this.capVersion !== tl.version) this.buildCaptions();
    tl.captions().forEach((c, i) => {
      const el = this.capEls[i], o = captionOpacity(c, x, tl.duration);
      el.style.opacity = o.toFixed(3);
      el.style.visibility = o > 0.001 ? 'visible' : 'hidden';
      el.style.transform = `translateY(${((1 - o) * 14).toFixed(1)}px)`;
    });
  }

  buildCaptions() {
    this.capVersion = this.timeline.version;
    // captions live in their own (unpositioned) wrapper so they stack with the media layers in the overlay
    if (!this.capWrap) { this.capWrap = document.createElement('div'); this.capWrap.className = 'caps'; this.captionLayer.prepend(this.capWrap); }
    this.capWrap.replaceChildren();
    this.capEls = this.timeline.captions().map((c) => {
      const el = document.createElement('div');
      el.className = `cap cap-${c.size || 'medium'}`;
      el.style.top = `${c.y ?? 42}%`;
      const h = document.createElement(c.size === 'large' ? 'h1' : 'h2');
      (c.title || '').split('\n').forEach((line, i) => { if (i) h.append(document.createElement('br')); h.append(line); });
      el.append(h);
      if (c.sub) { const s = document.createElement('p'); s.textContent = c.sub; el.append(s); }
      this.capWrap.append(el);
      return el;
    });
  }
}
