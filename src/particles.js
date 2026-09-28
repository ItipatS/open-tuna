// GPU particle systems. All simulation happens on the GPU (compute or purely procedural in the
// vertex stage); each system is a single instanced sprite draw.
import * as THREE from 'three/webgpu';
import {
  Fn, If, uniform, uint, float, vec2, vec3, vec4, instancedArray, instanceIndex, hash, uv, sin, cos, fract,
  mix, smoothstep, pow, max, exp, length, texture, cameraPosition, saturate, clamp, attribute, mx_noise_float,
} from 'three/tsl';
import { U, WATER_Y, causticTex } from './shared.js';

const rand3 = (i, a, b, c) => vec3(hash(i.add(uint(a))), hash(i.add(uint(b))), hash(i.add(uint(c))));

// ---------------------------------------------------------------------------------------------
// Splash: every breaching fish owns `per` particles. When its surface-crossing timestamp changes
// the particles respawn there: ~65% spray droplets (ballistic), ~35% foam that spreads and fades.
// ---------------------------------------------------------------------------------------------
export class Splash {
  constructor(swarm, per = 180) {
    const jumpers = swarm.jumpers;
    const N = jumpers * per;
    this.N = N;
    const P = instancedArray(N, 'vec4'); // xyz, life (1 -> 0)
    const V = instancedArray(N, 'vec4'); // xyz, birth time (matches owner's crossing time)
    const S = swarm.state;
    this.dt = uniform(0.016);
    const dt = this.dt;

    this.init = Fn(() => {
      P.element(instanceIndex).assign(vec4(0, -999, 0, 0));
      V.element(instanceIndex).assign(vec4(0, 0, 0, -100));
    })().compute(N);

    this.update = Fn(() => {
      const i = instanceIndex;
      const owner = i.div(uint(per));
      const local = i.mod(uint(per));
      const st = S.element(owner);
      const Pi = P.element(i), Vi = V.element(i);
      const isFoam = local.lessThan(uint(Math.floor(per * 0.35)));
      If(st.w.greaterThan(Vi.w.add(0.001)), () => {
        // respawn at the crossing point
        const seed = i.mul(uint(3)).add(uint(st.w.mul(61.0)).mul(uint(7919)));
        const r = rand3(seed, 1, 7, 13);
        const a = hash(seed.add(uint(977))).mul(6.2832);
        const rr = r.x;
        const dir = vec2(cos(a), sin(a));
        const entry = st.x.equal(3); // re-entry splashes are bigger
        const power = select3(entry, 1.35, 1.0);
        If(isFoam, () => {
          Pi.assign(vec4(st.y.add(dir.x.mul(rr.mul(0.6))), WATER_Y + 0.06, st.z.add(dir.y.mul(rr.mul(0.6))), 1));
          Vi.assign(vec4(dir.x.mul(rr.mul(1.8).add(0.6)).mul(power), 0, dir.y.mul(rr.mul(1.8).add(0.6)).mul(power), st.w));
        }).Else(() => {
          const up = r.y.mul(5.5).add(2.5).mul(power);
          const out = r.z.mul(2.8).add(0.4).mul(power);
          Pi.assign(vec4(st.y.add(dir.x.mul(0.25)), WATER_Y + 0.1, st.z.add(dir.y.mul(0.25)), 1));
          Vi.assign(vec4(dir.x.mul(out), up, dir.y.mul(out), st.w));
        });
      }).Else(() => {
        If(Pi.w.greaterThan(0), () => {
          If(isFoam, () => {
            const v = Vi.xyz.mul(exp(dt.mul(-1.6)));
            Vi.xyz.assign(v);
            Pi.xyz.assign(Pi.xyz.add(v.mul(dt)));
            Pi.w.assign(Pi.w.sub(dt.mul(0.28)));
          }).Else(() => {
            const v = Vi.xyz.add(vec3(0, -9.81, 0).mul(dt)).mul(exp(dt.mul(-0.4)));
            Vi.xyz.assign(v);
            const np = Pi.xyz.add(v.mul(dt));
            Pi.xyz.assign(np);
            Pi.w.assign(select3(np.y.lessThan(WATER_Y), 0, Pi.w.sub(dt.mul(0.5))));
          });
        });
      });
    })().compute(N);

    const pa = P.toAttribute();
    const life = saturate(pa.w);
    const isFoamR = instanceIndex.mod(uint(per)).lessThan(uint(Math.floor(per * 0.35)));
    const sz = hash(instanceIndex.add(uint(71))).mul(0.8).add(0.4);
    const lit = U.sunIntensity.mul(0.8).add(0.25);

    // spray droplets: camera-facing sprites
    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
    mat.positionNode = pa.xyz;
    mat.scaleNode = isFoamR.select(float(0), sz.mul(sz).mul(0.055).mul(life.mul(0.4).add(0.6)));
    const d = length(uv().sub(0.5)).mul(2);
    // droplet: bright specular core with a thin refractive rim
    const core = smoothstep(0.55, 0.0, d);
    const rimD = smoothstep(1.0, 0.8, d).mul(smoothstep(0.5, 0.8, d));
    mat.colorNode = vec3(0.9, 0.97, 1.0).mul(lit).mul(core.mul(1.8).add(0.6));
    mat.opacityNode = core.mul(0.85).add(rimD.mul(0.5)).mul(life).mul(isFoamR.select(0, 1));
    this.mesh = new THREE.Sprite(mat);
    this.mesh.count = N;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12;

    // foam: flat noisy patches lying on the water
    const fmat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const grow = mix(2.4, 0.8, life).mul(sz);
    const lp = attribute('position', 'vec3');
    fmat.positionNode = isFoamR.select(pa.xyz.add(lp.mul(grow)), vec3(0, -9999, 0));
    const fuv = uv().sub(0.5).mul(2);
    const fd = length(fuv);
    const n = mx_noise_float(vec3(fuv.mul(3.5), hash(instanceIndex).mul(50))).mul(0.5).add(0.5);
    const lace = smoothstep(0.45, 0.75, n).mul(smoothstep(1.0, 0.4, fd));
    fmat.colorNode = vec3(0.9, 0.96, 0.98).mul(lit);
    fmat.opacityNode = lace.mul(pow(life, 1.3)).mul(0.75);
    const plane = new THREE.PlaneGeometry(1, 1);
    plane.rotateX(-Math.PI / 2);
    this.foam = new THREE.InstancedMesh(plane, fmat, N);
    this.foam.frustumCulled = false;
    this.foam.renderOrder = 11;
    this.mesh.add(this.foam);
    this.needsInit = true;
  }
  step(renderer, dt) {
    if (this.needsInit) { renderer.compute(this.init); this.needsInit = false; }
    this.dt.value = Math.min(dt, 1 / 30);
    renderer.compute(this.update);
  }
}

// small helper: select for float constants on a bool node
function select3(cond, a, b) { return cond.select(float(a), float(b)); }

// ---------------------------------------------------------------------------------------------
// Marine snow / plankton: purely procedural, wraps around the camera (no buffers, no CPU).
// Motes inside light shafts glow brighter.
// ---------------------------------------------------------------------------------------------
export function createMarineSnow(count = 24000, box = 46) {
  const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const i = instanceIndex;
  const base = rand3(i, 1, 2, 3).mul(box);
  const drift = vec3(sin(U.time.mul(0.1).add(hash(i.add(uint(9))).mul(40))).mul(0.6), U.time.mul(-0.12).mul(hash(i.add(uint(5))).add(0.3)), U.time.mul(0.18));
  const rel = fractV(base.add(drift).sub(cameraPosition).div(box)).sub(0.5).mul(box);
  const wp = cameraPosition.add(rel);
  mat.positionNode = wp;
  const big = hash(i.add(uint(17))).greaterThan(0.93);
  mat.scaleNode = big.select(float(0.09), hash(i.add(uint(23))).mul(0.035).add(0.012));
  const d = length(uv().sub(0.5)).mul(2);
  const dist = length(rel);
  const fade = smoothstep(box * 0.5, box * 0.3, dist).mul(smoothstep(0.3, 1.5, dist));
  // light shaft brightness: project up the sun to the surface, sample the blurred caustic pattern
  const depth = max(float(WATER_Y).sub(wp.y), 0);
  const proj = wp.xz.add(U.sunDir.xz.mul(depth.div(max(U.sunDir.y, 0.2))));
  const shaft = texture(causticTex, proj.mul(0.03).add(vec2(U.time.mul(0.004), U.time.mul(0.003)))).level(4).r;
  const lightK = shaft.mul(2.2).add(0.18).mul(exp(depth.mul(-0.04)));
  const tint = big.select(vec3(0.6, 1.0, 0.9), vec3(0.8, 0.95, 1.0));
  mat.colorNode = tint.mul(lightK).mul(U.sunIntensity.mul(0.8).add(0.2));
  mat.opacityNode = smoothstep(1, 0, d).mul(fade).mul(U.under).mul(0.55).mul(wp.y.lessThan(WATER_Y).select(1, 0));
  mat.fog = false;
  const s = new THREE.Sprite(mat);
  s.count = count;
  s.frustumCulled = false;
  s.renderOrder = 20;
  return s;
}
const fractV = (v) => vec3(fract(v.x), fract(v.y), fract(v.z));

// ---------------------------------------------------------------------------------------------
// Bubble streams rising from vents on the seabed, wobbling and growing as pressure drops.
// ---------------------------------------------------------------------------------------------
export function createBubbles(vents, perVent = 220) {
  const N = vents.length * perVent;
  const arr = new Float32Array(vents.length * 4);
  vents.forEach((v, k) => arr.set([v.x, v.y, v.z, 0.6 + Math.random() * 0.8], k * 4));
  const ventBuf = instancedArray(arr, 'vec4');
  const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
  const i = instanceIndex;
  const vent = ventBuf.element(i.div(uint(perVent)));
  const h = hash(i.add(uint(3)));
  const height = float(WATER_Y).sub(vent.y);
  const riseT = height.div(vent.w.mul(1.6));
  const t = fract(U.time.div(riseT).add(h));
  const y = vent.y.add(t.mul(height));
  const wob = U.time.mul(hash(i.add(uint(11))).mul(3).add(3)).add(h.mul(30));
  const spread = t.mul(1.2).add(0.1);
  const wp = vec3(vent.x.add(sin(wob).mul(0.12)).add(hash(i.add(uint(5))).sub(0.5).mul(spread)), y, vent.z.add(cos(wob.mul(1.3)).mul(0.12)).add(hash(i.add(uint(7))).sub(0.5).mul(spread)));
  mat.positionNode = wp;
  mat.scaleNode = hash(i.add(uint(13))).mul(0.07).add(0.03).mul(t.mul(1.6).add(0.6));
  const q = uv().sub(0.5).mul(2);
  const d = length(q);
  const rim = smoothstep(0.62, 0.95, d).mul(smoothstep(1.0, 0.95, d));
  const spec = smoothstep(0.35, 0.0, length(q.sub(vec2(-0.3, 0.3))));
  const body = smoothstep(1.0, 0.9, d).mul(0.12);
  mat.colorNode = mix(U.shallow.mul(1.6), vec3(1.0), rim.add(spec)).mul(U.sunIntensity.mul(0.7).add(0.3)).add(spec.mul(1.5));
  mat.opacityNode = rim.mul(0.8).add(spec).add(body).mul(smoothstep(0.0, 0.05, t)).mul(smoothstep(1.0, 0.96, t)).mul(U.under.mul(0.7).add(0.3));
  const s = new THREE.Sprite(mat);
  s.count = N;
  s.frustumCulled = false;
  s.renderOrder = 11;
  return s;
}
