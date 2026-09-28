// Procedural bioluminescent jellyfish bloom: generated geometry (bell + oral arms + tentacles,
// ~1.4k triangles), animated and shaded entirely on the GPU, one instanced draw.
import * as THREE from 'three/webgpu';
import {
  Fn, uniform, uint, float, vec3, attribute, instanceIndex, hash, sin, cos, pow, mix, smoothstep, exp, abs,
  normalize, dot, length, saturate, atan, normalLocal, normalWorld, positionWorld, cameraPosition, max, select, vec2,
} from 'three/tsl';
import { U, WATER_Y } from './shared.js';

function buildJellyGeometry() {
  const P = [], N = [], PART = [], ALONG = [], SEED = [], idx = [];
  const push = (x, y, z, nx, ny, nz, part, along, seed) => {
    P.push(x, y, z); N.push(nx, ny, nz); PART.push(part); ALONG.push(along); SEED.push(seed);
    return P.length / 3 - 1;
  };
  // --- bell (lathe)
  const RS = 32, RR = 14;
  for (let r = 0; r <= RR; r++) {
    const a = r / RR;
    const th = a * 1.42;
    const rad = Math.sin(th) * 0.5 * (1 + 0.06 * Math.sin(a * 9));
    const y = Math.cos(th) * 0.42 - 0.08 - (a > 0.9 ? (a - 0.9) * 0.3 : 0);
    const nr = Math.sin(th), ny = Math.cos(th) * 1.2;
    for (let s = 0; s <= RS; s++) {
      const ph = (s / RS) * Math.PI * 2;
      const c = Math.cos(ph), sn = Math.sin(ph);
      const l = Math.hypot(nr, ny);
      push(c * rad, y, sn * rad, (c * nr) / l, ny / l, (sn * nr) / l, 0, a, s / RS);
    }
  }
  for (let r = 0; r < RR; r++) for (let s = 0; s < RS; s++) {
    const a = r * (RS + 1) + s, b = a + RS + 1;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
  }
  // --- ribbons (oral arms and tentacles): vertical strips; `seed` holds the angular slot
  const strip = (x0, z0, len, width, segs, part, seed, rot) => {
    const base = P.length / 3;
    const cx = Math.cos(rot), cz = Math.sin(rot);
    for (let k = 0; k <= segs; k++) {
      const a = k / segs;
      const w = width * (part === 1 ? (0.6 + 0.4 * Math.sin(a * 18) ** 2) * (1 - a * 0.6) : 1 - a * 0.7);
      push(x0 - cx * w, -0.05 - a * len, z0 - cz * w, cz, 0, -cx, part, a, seed);
      push(x0 + cx * w, -0.05 - a * len, z0 + cz * w, cz, 0, -cx, part, a, seed);
    }
    for (let k = 0; k < segs; k++) {
      const a = base + k * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  };
  for (let k = 0; k < 4; k++) {
    const ang = (k / 4) * Math.PI * 2 + 0.4;
    strip(Math.cos(ang) * 0.06, Math.sin(ang) * 0.06, 1.1 + Math.random() * 0.4, 0.07, 22, 1, k / 4, ang);
    strip(Math.cos(ang) * 0.06, Math.sin(ang) * 0.06, 1.0 + Math.random() * 0.4, 0.07, 22, 1, k / 4 + 0.1, ang + Math.PI / 2);
  }
  const T = 18;
  for (let k = 0; k < T; k++) {
    const ang = (k / T) * Math.PI * 2;
    const r = 0.45;
    strip(Math.cos(ang) * r, Math.sin(ang) * r, 1.6 + Math.random() * 1.4, 0.009, 26, 2, k / T, ang + Math.PI / 2);
    strip(Math.cos(ang) * r, Math.sin(ang) * r, 1.6 + Math.random() * 1.4, 0.009, 26, 2, k / T + 0.02, ang);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('part', new THREE.Float32BufferAttribute(PART, 1));
  g.setAttribute('along', new THREE.Float32BufferAttribute(ALONG, 1));
  g.setAttribute('jseed', new THREE.Float32BufferAttribute(SEED, 1));
  g.setIndex(idx);
  return g;
}

const PALETTE = [
  new THREE.Color(0.25, 0.85, 1.0), // cyan
  new THREE.Color(0.85, 0.35, 1.0), // violet
  new THREE.Color(1.0, 0.45, 0.75), // pink
  new THREE.Color(0.35, 1.0, 0.7), // mint
  new THREE.Color(1.0, 0.75, 0.35), // amber
];

export function createJellyBloom({ count = 420, clusters }) {
  const geometry = buildJellyGeometry();
  const cl = clusters.map((c) => uniform(c)); // vec4: xyz centre, radius
  const i = instanceIndex;
  const h = (k) => hash(i.add(uint(k)));
  const glow = uniform(1);

  const part = attribute('part', 'float');
  const along = attribute('along', 'float');
  const jseed = attribute('jseed', 'float');

  // per-instance placement: pick a cluster, random offset inside it
  const pick = h(1).mul(clusters.length).floor();
  let center = cl[0];
  for (let k = 1; k < cl.length; k++) center = select(pick.equal(k), cl[k], center);
  const off = vec3(h(2), h(3), h(4)).sub(0.5).mul(2);
  const scale = mix(0.35, 1.25, pow(h(5), 1.8));
  const freq = mix(0.9, 1.7, h(6));
  const phi = U.time.mul(freq).add(h(7).mul(60));
  const contract = pow(sin(phi).mul(0.5).add(0.5), 2.0);
  const t = U.time;
  const basePos = center.xyz.add(off.mul(vec3(center.w, 4.0, center.w)))
    .add(vec3(sin(t.mul(0.05).add(h(8).mul(40))).mul(3), sin(phi.sub(1.2)).mul(0.25).add(sin(t.mul(0.07).add(h(9).mul(30))).mul(2)), cos(t.mul(0.04).add(h(10).mul(40))).mul(3)));
  const yaw = h(11).mul(6.283), tilt = h(12).sub(0.5).mul(0.5);

  const posNode = Fn(() => {
    const p = attribute('position', 'vec3');
    const n = attribute('normal', 'vec3');
    const isBell = part.equal(0);
    // bell pulse: rim contracts more than the apex
    const squeeze = float(1).sub(contract.mul(0.2).mul(select(isBell, along, float(1))));
    const q = vec3(p.x.mul(squeeze), p.y.mul(select(isBell, contract.mul(0.1).add(1), float(1))), p.z.mul(squeeze)).toVar();
    // ribbons: travelling wave + drag trailing from the pulse
    const a2 = along.mul(along);
    const wave = sin(t.mul(1.4).sub(along.mul(7)).add(jseed.mul(31)).add(h(13).mul(20))).mul(0.12).mul(a2);
    const wave2 = cos(t.mul(1.1).sub(along.mul(5)).add(jseed.mul(17))).mul(0.1).mul(a2);
    const trail = contract.mul(0.12).mul(along);
    q.addAssign(select(isBell, vec3(0), vec3(wave, trail, wave2)));
    // instance rotation (yaw + small tilt)
    const cy = cos(yaw), sy = sin(yaw), ct = cos(tilt), st = sin(tilt);
    const rot = (v) => {
      const a = vec3(v.x, v.y.mul(ct).sub(v.z.mul(st)), v.y.mul(st).add(v.z.mul(ct)));
      return vec3(a.x.mul(cy).add(a.z.mul(sy)), a.y, a.z.mul(cy).sub(a.x.mul(sy)));
    };
    normalLocal.assign(rot(n));
    return basePos.add(rot(q).mul(scale));
  })();

  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false });
  mat.positionNode = posNode;

  // colour: palette pick per instance, slight hue drift across the bell
  const cpick = h(20).mul(PALETTE.length).floor();
  let col = vec3(PALETTE[0].r, PALETTE[0].g, PALETTE[0].b);
  for (let k = 1; k < PALETTE.length; k++) col = select(cpick.equal(k), vec3(PALETTE[k].r, PALETTE[k].g, PALETTE[k].b), col);

  mat.colorNode = Fn(() => {
    const V = normalize(cameraPosition.sub(positionWorld));
    const dist = length(cameraPosition.sub(positionWorld));
    const N = normalize(normalWorld);
    const fres = pow(float(1).sub(abs(dot(N, V))), 2.2);
    const lp = attribute('position', 'vec3');
    const ang = atan(lp.z, lp.x);
    const canals = pow(abs(sin(ang.mul(4))), 24).mul(0.6);
    const rimBand = smoothstep(0.82, 1.0, along);
    const pulseWave = exp(pow(along.sub(sin(phi.sub(0.5)).mul(0.5).add(0.5)), 2).mul(-40)).mul(0.9);
    const bell = fres.mul(0.9).add(0.06).add(canals.mul(smoothstep(0.1, 0.9, along))).add(rimBand.mul(1.2)).add(pulseWave);
    const sparkle = pow(sin(along.mul(46).sub(t.mul(5)).add(jseed.mul(90))).mul(0.5).add(0.5), 18);
    const arm = select(part.equal(1), float(0.35).add(sparkle.mul(0.6)), float(0.28).add(sparkle.mul(1.4)).mul(float(1).sub(along.mul(0.7))));
    const k = select(part.equal(0), bell, arm);
    const depthK = mix(0.75, 1.3, smoothstep(2.0, 18.0, float(WATER_Y).sub(positionWorld.y)));
    const vis = exp(dist.mul(U.fogDensity).mul(-1.15));
    const hue = mix(col, vec3(1, 1, 1), rimBand.mul(0.35).add(pulseWave.mul(0.25)));
    return hue.mul(k).mul(depthK).mul(vis).mul(glow).mul(contract.mul(0.35).add(0.75));
  })();
  mat.opacityNode = float(1);

  const mesh = new THREE.InstancedMesh(geometry, mat, count);
  mesh.frustumCulled = false;
  mesh.renderOrder = 6;
  mesh.userData.glow = glow;
  mesh.userData.clusters = cl;
  return mesh;
}
