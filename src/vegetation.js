// Procedural seagrass meadows: tapered blades, instanced, bent by the current in the vertex
// shader and lit with fake translucency + caustics.
import * as THREE from 'three/webgpu';
import {
  Fn, uint, float, vec3, attribute, instanceIndex, instancedArray, hash, sin, cos, pow, mix, normalLocal,
  normalize, dot, saturate, positionWorld, cameraPosition, color, smoothstep,
} from 'three/tsl';
import { U } from './shared.js';
import { causticLight } from './shared.js';

function bladeGeometry(segs = 7) {
  const P = [], N = [], A = [], idx = [];
  for (let k = 0; k <= segs; k++) {
    const a = k / segs;
    const w = 0.045 * (1 - a * 0.85);
    P.push(-w, a, 0, w, a, 0); N.push(0, 0, 1, 0, 0, 1); A.push(a, a);
  }
  for (let k = 0; k < segs; k++) { const b = k * 2; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('along', new THREE.Float32BufferAttribute(A, 1));
  g.setIndex(idx);
  return g;
}

export function createSeagrass({ count = 26000, heightAt, avoid }) {
  // meadow placement: clustered patches on the sand
  const data = new Float32Array(count * 4);
  const patches = [];
  for (let k = 0; k < 22; k++) {
    const a = Math.random() * Math.PI * 2, r = 30 + Math.random() * 120;
    patches.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, s: 6 + Math.random() * 14 });
  }
  let n = 0;
  while (n < count) {
    const p = patches[(Math.random() * patches.length) | 0];
    const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * p.s;
    const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
    if (avoid && avoid(x, z)) continue;
    const edge = 1 - r / p.s;
    data.set([x, heightAt(x, z) - 0.05, z, (0.5 + Math.random() * 1.3) * (0.45 + 0.55 * edge)], n * 4);
    n++;
  }
  const buf = instancedArray(data, 'vec4');
  const inst = buf.toAttribute();
  const along = attribute('along', 'float');

  const mat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.6 });
  const i = instanceIndex;
  const yaw = hash(i.add(uint(7))).mul(6.283);
  mat.positionNode = Fn(() => {
    const p = attribute('position', 'vec3');
    const h = inst.w;
    const cy = cos(yaw), sy = sin(yaw);
    const local = vec3(p.x.mul(cy), p.y.mul(h), p.x.mul(sy));
    const t = U.time;
    const surge = sin(t.mul(0.9).add(inst.x.mul(0.09)).add(inst.z.mul(0.07))).mul(0.45).add(0.25);
    const flutter = sin(t.mul(2.6).add(hash(i.add(uint(3))).mul(20)).add(p.y.mul(3))).mul(0.08);
    const bend = pow(along, 1.7).mul(h);
    const disp = vec3(surge.add(flutter).mul(0.8), 0, surge.mul(0.6).sub(flutter)).mul(bend);
    const len = local.add(disp);
    // keep blade length roughly constant when bent
    const drop = pow(along, 2).mul(h).mul(surge.mul(surge).mul(0.25));
    normalLocal.assign(vec3(sy.negate(), 0.2, cy));
    return inst.xyz.add(vec3(len.x, len.y.sub(drop), len.z));
  })();
  const base = color(0x1f5a3a), tip = color(0x9ccf6a);
  const tint = mix(base, tip, pow(along, 0.8)).mul(hash(i.add(uint(19))).mul(0.4).add(0.8));
  mat.colorNode = tint;
  const V = normalize(cameraPosition.sub(positionWorld));
  const back = pow(saturate(dot(V.negate(), U.sunDir)), 3).mul(0.9).add(0.12);
  mat.emissiveNode = tint.mul(causticLight()).mul(0.6).add(tip.mul(back).mul(along).mul(0.35).mul(U.sunIntensity)).mul(smoothstep(0.0, 0.2, along).mul(0.7).add(0.3));

  const mesh = new THREE.InstancedMesh(bladeGeometry(), mat, count);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  return mesh;
}
