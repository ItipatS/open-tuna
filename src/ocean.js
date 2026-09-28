// Procedural ocean: Gerstner-wave surface on a camera-centred polar grid, procedural sky dome,
// and a CPU-displaced sandy seabed. No textures from disk are used here.
import * as THREE from 'three/webgpu';
import {
  Fn, If, uniform, float, vec2, vec3, attribute, varying, sin, cos, normalize, length, dot, max, min, pow,
  mix, smoothstep, exp, saturate, reflect, refract, clamp, screenUV, positionView, positionWorld, cameraPosition,
  viewportTexture, viewportDepthTexture, perspectiveDepthToViewZ, cameraNear, cameraFar, texture,
  mx_noise_float, color, bumpMap,
} from 'three/tsl';
import { U, WATER_Y, SEABED_BASE, skyColor, underwaterColor, causticLight, causticTex } from './shared.js';

// ---------------------------------------------------------------------------------------------
// Wave spectrum (shared by GPU displacement and the CPU height query used for the waterline).
// ---------------------------------------------------------------------------------------------
function rng(seed) { return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646; }

const G = 9.81;
const WIND = 0.55;
export const WAVES = (() => {
  const r = rng(1337), out = [];
  let L = 90;
  const N = 11;
  for (let i = 0; i < N; i++) {
    const spread = 0.35 + (i / N) * 1.1;
    const a = WIND + (r() - 0.5) * spread * 2;
    const k = (Math.PI * 2) / L;
    out.push({ dx: Math.cos(a), dz: Math.sin(a), L, k, w: Math.sqrt(G * k), A: L * 0.0058, phase: r() * Math.PI * 2, q: 0.85 / (k * N) });
    L *= 0.71;
  }
  return out;
})();

const DETAIL = (() => {
  const r = rng(99), out = [];
  let L = 7;
  for (let i = 0; i < 10; i++) {
    const a = WIND + (r() - 0.5) * 3.2;
    const k = (Math.PI * 2) / L;
    out.push({ dx: Math.cos(a), dz: Math.sin(a), L, k, w: Math.sqrt(G * k), A: L * 0.0075, phase: r() * 6.283 });
    L *= 0.74;
  }
  return out;
})();

export const oceanU = {
  amp: uniform(1),       // sea state
  chopAmp: uniform(1),   // clamped amp for horizontal displacement (avoids loops)
  center: uniform(new THREE.Vector2()),
};

export function waveHeightCPU(x, z, t, amp) {
  let y = 0;
  for (const w of WAVES) y += w.A * amp * Math.sin(w.k * (w.dx * x + w.dz * z) - w.w * t + w.phase);
  return WATER_Y + y;
}

// ---------------------------------------------------------------------------------------------
// Polar grid: dense near the camera, sparse towards the horizon.
// ---------------------------------------------------------------------------------------------
function polarGrid(rings = 360, segs = 480, radius = 4200) {
  const count = 1 + rings * segs;
  const pos = new Float32Array(count * 3);
  let p = 3;
  for (let i = 1; i <= rings; i++) {
    const r = radius * Math.pow(i / rings, 2.7);
    for (let j = 0; j < segs; j++) {
      const a = (j / segs) * Math.PI * 2;
      pos[p++] = Math.cos(a) * r; pos[p++] = 0; pos[p++] = Math.sin(a) * r;
    }
  }
  const idx = [];
  for (let j = 0; j < segs; j++) idx.push(0, 1 + ((j + 1) % segs), 1 + j);
  for (let i = 0; i < rings - 1; i++) {
    const a0 = 1 + i * segs, b0 = 1 + (i + 1) * segs;
    for (let j = 0; j < segs; j++) {
      const j1 = (j + 1) % segs;
      idx.push(a0 + j, a0 + j1, b0 + j, a0 + j1, b0 + j1, b0 + j);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(count * 3).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  return g;
}

const sceneCopy = new THREE.FramebufferTexture();
sceneCopy.type = THREE.HalfFloatType;

export function createOcean() {
  const grid = attribute('position', 'vec3');
  const wx = grid.x.add(oceanU.center.x);
  const wz = grid.z.add(oceanU.center.y);
  const dist = length(grid.xz);
  const t = U.time;

  let dx = float(0), dy = float(0), dz = float(0);
  let nx = float(0), ny = float(1), nz = float(0);
  let jxx = float(1), jzz = float(1), jxz = float(0);

  for (const w of WAVES) {
    const fade = float(1).sub(smoothstep(w.L * 6, w.L * 30, dist));
    const A = oceanU.amp.mul(w.A).mul(fade);
    const H = oceanU.chopAmp.mul(w.q).mul(fade); // horizontal amplitude (Q*A)
    const f = wx.mul(w.k * w.dx).add(wz.mul(w.k * w.dz)).sub(t.mul(w.w)).add(w.phase);
    const S = sin(f), C = cos(f);
    dx = dx.add(H.mul(w.dx).mul(C));
    dz = dz.add(H.mul(w.dz).mul(C));
    dy = dy.add(A.mul(S));
    const WA = A.mul(w.k), QWA = H.mul(w.k);
    nx = nx.sub(WA.mul(C).mul(w.dx));
    nz = nz.sub(WA.mul(C).mul(w.dz));
    ny = ny.sub(QWA.mul(S));
    jxx = jxx.sub(QWA.mul(S).mul(w.dx * w.dx));
    jzz = jzz.sub(QWA.mul(S).mul(w.dz * w.dz));
    jxz = jxz.sub(QWA.mul(S).mul(w.dx * w.dz));
  }

  const displaced = vec3(wx.add(dx), dy.add(WATER_Y), wz.add(dz));
  const vWorld = varying(displaced, 'vOceanWorld');
  const vNormal = varying(vec3(nx, ny, nz), 'vOceanNormal');
  const vJac = varying(jxx.mul(jzz).sub(jxz.mul(jxz)), 'vOceanJac');
  const vHeight = varying(dy, 'vOceanHeight');

  const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, transparent: true, fog: false });
  mat.positionNode = displaced;

  mat.colorNode = Fn(() => {
    const toCam = cameraPosition.sub(vWorld);
    const d = length(toCam);
    const V = toCam.div(d);

    // fragment-level detail normals (analytic derivatives), faded with distance
    let ddx = float(0), ddz = float(0);
    for (const w of DETAIL) {
      const fade = float(1).sub(smoothstep(w.L * 12, w.L * 70, d));
      const f = vWorld.x.mul(w.k * w.dx).add(vWorld.z.mul(w.k * w.dz)).sub(t.mul(w.w)).add(w.phase);
      const g = cos(f).mul(w.A * w.k).mul(fade).mul(oceanU.amp.mul(0.6).add(0.4));
      ddx = ddx.add(g.mul(w.dx));
      ddz = ddz.add(g.mul(w.dz));
    }
    const N = normalize(vec3(vNormal.x.sub(ddx), vNormal.y, vNormal.z.sub(ddz))).toVar();
    const L = U.sunDir;
    const out = vec3(0).toVar();

    If(U.under.lessThan(0.5), () => {
      // ---------------- seen from above ----------------
      const Nf = normalize(mix(N, vec3(0, 1, 0), smoothstep(200, 2500, d))); // calm far normals (anti-shimmer)
      const R = reflect(V.negate(), Nf);
      const Rup = normalize(vec3(R.x, max(R.y, 0.01), R.z));
      const NdV = saturate(dot(Nf, V));
      const fres = float(0.02).add(pow(float(1).sub(NdV), 5).mul(0.98));
      const refl = skyColor(Rup, true);

      // screen-space refraction with Beer–Lambert absorption through the water column
      const ruv = clamp(screenUV.add(Nf.xz.mul(0.02).div(max(d.mul(0.05), 1))), 0.001, 0.999);
      const behind = viewportTexture(ruv, null, sceneCopy).rgb;
      const sceneZ = perspectiveDepthToViewZ(viewportDepthTexture(ruv).x, cameraNear, cameraFar);
      const thick = max(positionView.z.sub(sceneZ), 0).add(0.2);
      const trans = exp(vec3(0.3, 0.05, 0.034).mul(thick).negate());
      const scatter = mix(U.mid, U.shallow, 0.45).mul(U.sunIntensity.mul(0.9).add(0.1));
      const refr = behind.mul(trans).add(scatter.mul(float(1).sub(trans)));

      // subsurface glow on crests facing away from the sun
      const crest = saturate(vHeight.mul(0.35).add(0.35));
      const back = pow(saturate(dot(normalize(vec3(V.x.negate(), 0.2, V.z.negate())), vec3(L.x, 0, L.z).normalize())), 3);
      const sss = U.shallow.mul(U.sunColor).mul(crest.mul(back).mul(0.55).add(crest.mul(0.08))).mul(U.sunIntensity);

      // sun glints
      const spec = pow(max(dot(R, L), 0), 1100).mul(90).add(pow(max(dot(R, L), 0), 110).mul(1.2));

      // whitecaps from Gerstner Jacobian, broken up by a scrolling pattern
      const pat = texture(causticTex, vWorld.xz.mul(0.09).add(vec2(t.mul(0.01), 0))).r;
      const foamRaw = float(1).sub(smoothstep(0.12, 0.65, vJac)).mul(smoothstep(0.0, 0.3, vHeight));
      const foam = saturate(foamRaw.mul(1.6).sub(float(1).sub(pat).mul(0.7))).mul(float(1).sub(smoothstep(300, 900, d)));
      const foamCol = vec3(0.92, 0.95, 0.97).mul(U.sunIntensity.mul(saturate(dot(Nf, L)).mul(0.7).add(0.3)));

      let c = mix(refr.add(sss), refl, fres).add(U.sunColor.mul(spec).mul(U.sunIntensity).mul(float(1).sub(foam)));
      c = mix(c, foamCol, foam);
      const haze = float(1).sub(exp(d.mul(-0.00022)));
      out.assign(mix(c, skyColor(normalize(vec3(V.x.negate(), 0.015, V.z.negate())), false), haze));
    }).Else(() => {
      // ---------------- seen from below: Snell's window + total internal reflection ----------------
      const I = V.negate();
      const Nd = N.negate();
      const T = refract(I, Nd, 1.333);
      const tir = float(1).sub(smoothstep(0.0, 0.02, dot(T, T)));
      const cosI = saturate(dot(I.negate(), Nd));
      const edge = smoothstep(0.64, 0.8, float(1).sub(cosI.mul(cosI)).mul(1.777)); // brighten rim of the window
      const through = skyColor(normalize(T.add(vec3(0, 0.0001, 0))), true).mul(1.25).add(U.sunColor.mul(pow(max(dot(T, L), 0), 400).mul(30)));
      const reflUnder = underwaterColor(normalize(reflect(I, Nd))).mul(0.9);
      let c = mix(through.mul(float(1).sub(edge.mul(0.5))), reflUnder, tir);
      const fogAmt = float(1).sub(exp(d.mul(-0.021)));
      out.assign(mix(c, underwaterColor(I), fogAmt));
    });
    return out;
  })();

  const mesh = new THREE.Mesh(polarGrid(), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  return mesh;
}

// ---------------------------------------------------------------------------------------------
// Sky dome (switches to underwater volume colour when the camera dives).
// ---------------------------------------------------------------------------------------------
export function createSky() {
  const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
  mat.colorNode = Fn(() => {
    const dir = normalize(positionWorld.sub(cameraPosition));
    const out = vec3(0).toVar();
    If(U.under.lessThan(0.5), () => { out.assign(skyColor(dir, true)); }).Else(() => { out.assign(underwaterColor(dir)); });
    return out;
  })();
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(4600, 48, 24), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return mesh;
}

// ---------------------------------------------------------------------------------------------
// Seabed: displaced on the CPU once (static), shaded procedurally with caustics.
// ---------------------------------------------------------------------------------------------
export function seabedHeight(x, z) {
  return SEABED_BASE
    + 2.4 * Math.sin(x * 0.021 + 1.3) * Math.cos(z * 0.018)
    + 1.1 * Math.sin(x * 0.063 + z * 0.041)
    + 0.45 * Math.sin(z * 0.17 - x * 0.11)
    + 0.18 * Math.sin(x * 0.41 + z * 0.37);
}

export function createSeabed() {
  const size = 1800, segs = 360;
  const g = new THREE.PlaneGeometry(size, size, segs, segs);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, seabedHeight(p.getX(i), p.getZ(i)));
  g.computeVertexNormals();

  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  const xz = positionWorld.xz;
  const n1 = mx_noise_float(vec3(xz.x.mul(0.05), 0.0, xz.y.mul(0.05)));
  const n2 = mx_noise_float(vec3(xz.x.mul(0.8), 1.7, xz.y.mul(0.8)));
  const warp = n1.mul(6).add(mx_noise_float(vec3(xz.x.mul(0.2), 4.0, xz.y.mul(0.2))).mul(2));
  const ripple = sin(xz.x.mul(1.3).add(xz.y.mul(0.45)).add(warp)).mul(0.5).add(0.5);
  const ripple2 = sin(xz.x.mul(-0.5).add(xz.y.mul(2.1)).add(warp.mul(0.7))).mul(0.5).add(0.5);
  const height = pow(ripple, 1.5).mul(0.7).add(pow(ripple2, 2).mul(0.3)).add(n2.mul(0.15));
  const sand = mix(color(0xd8c9a2), color(0xb09c76), saturate(n1.mul(0.9).add(0.45)))
    .mul(float(0.9).add(height.mul(0.12)));
  // grains glitter where caustics hit
  const glitter = smoothstep(0.82, 0.95, mx_noise_float(vec3(xz.x.mul(40), U.time.mul(0.4), xz.y.mul(40))));
  mat.colorNode = sand;
  mat.normalNode = bumpMap(height, 0.4);
  const caus = causticLight();
  mat.emissiveNode = sand.mul(caus).add(caus.mul(glitter).mul(0.6));
  const mesh = new THREE.Mesh(g, mat);
  mesh.receiveShadow = true;
  return mesh;
}
