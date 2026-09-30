// Asset loading + preparation helpers: spec/gloss material support, skinned-pose baking,
// canonical orientation (forward = +Z, up = +Y, length = 1) and node-material conversion.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { materialColor, vec3, float, pow, saturate, abs, dot, normalView, positionViewDirection } from 'three/tsl';
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import { causticLight, U } from './shared.js';

// three.js dropped KHR_materials_pbrSpecularGlossiness; several of these Sketchfab exports use it.
class SpecGlossPlugin {
  constructor(parser) { this.parser = parser; this.name = 'KHR_materials_pbrSpecularGlossiness'; }
  extendMaterialParams(materialIndex, params) {
    const def = this.parser.json.materials[materialIndex];
    const ext = def.extensions && def.extensions[this.name];
    if (!ext) return Promise.resolve();
    const pending = [];
    params.color = new THREE.Color(1, 1, 1);
    params.opacity = 1;
    if (Array.isArray(ext.diffuseFactor)) {
      const f = ext.diffuseFactor;
      params.color.setRGB(f[0], f[1], f[2], THREE.LinearSRGBColorSpace);
      params.opacity = f[3];
    }
    if (ext.diffuseTexture !== undefined) pending.push(this.parser.assignTexture(params, 'map', ext.diffuseTexture, THREE.SRGBColorSpace));
    const gloss = ext.glossinessFactor !== undefined ? ext.glossinessFactor : 1;
    params.roughness = THREE.MathUtils.clamp(1 - gloss, 0.25, 1);
    params.metalness = 0;
    return Promise.all(pending);
  }
}

export function createLoader(manager) {
  const loader = new GLTFLoader(manager);
  loader.register((parser) => new SpecGlossPlugin(parser));
  return loader;
}

// ---------------------------------------------------------------------------------------------
// Bake every mesh under `root` (including skinned meshes in their current pose) into a single
// world-space geometry with one group per source mesh. Only position/normal/uv are kept.
// ---------------------------------------------------------------------------------------------
export function bakeModel(root) {
  root.updateMatrixWorld(true);
  const geos = [], mats = [];
  const skinM = new THREE.Matrix4(), boneM = new THREE.Matrix4(), full = new THREE.Matrix4();
  const nMat = new THREE.Matrix3(), v = new THREE.Vector3(), n = new THREE.Vector3();

  root.traverse((o) => {
    if (!o.isMesh || !o.geometry.attributes.position) return;
    const src = o.geometry;
    const pos = src.attributes.position, nor = src.attributes.normal, uv = src.attributes.uv;
    const count = pos.count;
    const P = new Float32Array(count * 3), N = new Float32Array(count * 3), UV = new Float32Array(count * 2);
    const skinned = o.isSkinnedMesh && src.attributes.skinIndex && src.attributes.skinWeight;
    let boneMatrices = null;
    if (skinned) { o.skeleton.update(); boneMatrices = o.skeleton.boneMatrices; }
    else { full.copy(o.matrixWorld); nMat.getNormalMatrix(full); }

    for (let i = 0; i < count; i++) {
      if (skinned) {
        const e = skinM.elements; e.fill(0);
        for (let k = 0; k < 4; k++) {
          const w = src.attributes.skinWeight.getComponent(i, k);
          if (w === 0) continue;
          boneM.fromArray(boneMatrices, src.attributes.skinIndex.getComponent(i, k) * 16);
          for (let q = 0; q < 16; q++) e[q] += w * boneM.elements[q];
        }
        full.multiplyMatrices(o.matrixWorld, o.bindMatrixInverse).multiply(skinM).multiply(o.bindMatrix);
        nMat.getNormalMatrix(full);
      }
      v.fromBufferAttribute(pos, i).applyMatrix4(full);
      P[i * 3] = v.x; P[i * 3 + 1] = v.y; P[i * 3 + 2] = v.z;
      if (nor) { n.fromBufferAttribute(nor, i).applyMatrix3(nMat).normalize(); } else n.set(0, 1, 0);
      N[i * 3] = n.x; N[i * 3 + 1] = n.y; N[i * 3 + 2] = n.z;
      if (uv) { UV[i * 2] = uv.getX(i); UV[i * 2 + 1] = uv.getY(i); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(UV, 2));
    if (src.index) g.setIndex(new THREE.BufferAttribute(src.index.array.slice(), 1));
    else g.setIndex([...Array(count).keys()]);
    // Nudge the det<0 (mirrored) case so winding stays correct
    if (full.determinant() < 0) {
      const ix = g.index.array;
      for (let t = 0; t < ix.length; t += 3) { const a = ix[t + 1]; ix[t + 1] = ix[t + 2]; ix[t + 2] = a; }
    }
    geos.push(g);
    mats.push(Array.isArray(o.material) ? o.material[0] : o.material);
  });

  const geometry = mergeGeometries(geos, true);
  return { geometry, materials: mats };
}

// Reduce triangles per material group (meshoptimizer); vertices/UVs are kept, seams locked.
export async function simplifyGeometry(geometry, ratio, error = 0.01) {
  await MeshoptSimplifier.ready;
  const pos = geometry.attributes.position.array, src = geometry.index.array;
  const groups = geometry.groups.length ? geometry.groups : [{ start: 0, count: src.length, materialIndex: 0 }];
  const out = [], kept = [];
  for (const g of groups) {
    const idx = new Uint32Array(src.subarray(g.start, g.start + g.count));
    const [res] = MeshoptSimplifier.simplify(idx, pos, 3, Math.max(3, Math.floor((idx.length * ratio) / 3) * 3), error, ['LockBorder']);
    kept.push({ start: out.length, count: res.length, materialIndex: g.materialIndex });
    for (const v of res) out.push(v);
  }
  geometry.setIndex(out);
  geometry.clearGroups();
  for (const g of kept) geometry.addGroup(g.start, g.count, g.materialIndex);
  return geometry;
}

// Longest horizontal axis = forward, world Y = up. Sign is guessed (thicker end = head) and can
// be overridden with `flip`.
export function guessAxes(geometry, flip = false) {
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox, size = bb.getSize(new THREE.Vector3()), c = bb.getCenter(new THREE.Vector3());
  const alongX = size.x >= size.z;
  const p = geometry.attributes.position;
  let front = 0, back = 0, nf = 0, nb = 0;
  for (let i = 0; i < p.count; i++) {
    const a = alongX ? (p.getX(i) - c.x) / (size.x * 0.5) : (p.getZ(i) - c.z) / (size.z * 0.5);
    const lat = Math.abs(alongX ? p.getZ(i) - c.z : p.getX(i) - c.x);
    const h = Math.abs(p.getY(i) - c.y);
    const s = lat + h * 0.5;
    if (a > 0.45) { front = Math.max(front, s); nf++; } else if (a < -0.45) { back = Math.max(back, s); nb++; }
  }
  let sign = front >= back ? 1 : -1;
  if (flip) sign = -sign;
  const forward = alongX ? new THREE.Vector3(sign, 0, 0) : new THREE.Vector3(0, 0, sign);
  return { forward, up: new THREE.Vector3(0, 1, 0) };
}

// Rotate so forward -> +Z, up -> +Y; centre; scale to unit length along Z.
export function canonicalize(geometry, forward, up) {
  const f = forward.clone().normalize();
  const u = up.clone().sub(f.clone().multiplyScalar(up.dot(f))).normalize();
  const r = new THREE.Vector3().crossVectors(u, f).normalize();
  const m = new THREE.Matrix4().makeBasis(r, u, f).transpose();
  geometry.applyMatrix4(m);
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox, c = bb.getCenter(new THREE.Vector3());
  const len = bb.max.z - bb.min.z;
  geometry.translate(-c.x, -c.y, -c.z);
  geometry.scale(1 / len, 1 / len, 1 / len);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

// ---------------------------------------------------------------------------------------------
// Material conversion: standard -> node material, with underwater caustics added as emission.
// ---------------------------------------------------------------------------------------------
const KEYS = ['name', 'color', 'map', 'alphaMap', 'aoMap', 'aoMapIntensity', 'normalMap', 'normalMapType', 'normalScale',
  'roughness', 'roughnessMap', 'metalness', 'metalnessMap', 'emissive', 'emissiveMap', 'emissiveIntensity',
  'transparent', 'opacity', 'alphaTest', 'side', 'depthWrite', 'vertexColors', 'flatShading', 'bumpMap', 'bumpScale'];

export function toNodeMaterial(src, { caustics = true, physical = false, iridescence = 0, clearcoat = 0, rim = 0, rimColor = null, sheen = 0 } = {}) {
  let dst;
  if (src.isMeshBasicMaterial) dst = new THREE.MeshBasicNodeMaterial();
  else if (physical) dst = new THREE.MeshPhysicalNodeMaterial();
  else dst = new THREE.MeshStandardNodeMaterial();
  for (const k of KEYS) {
    if (src[k] === undefined || !(k in dst)) continue;
    const val = src[k];
    if (val && val.isColor) dst[k].copy(val);
    else if (val && val.isVector2) dst[k].copy(val);
    else dst[k] = val;
  }
  if (physical) {
    dst.iridescence = iridescence;
    dst.iridescenceIOR = 1.35;
    dst.iridescenceThicknessRange = [180, 620];
    dst.clearcoat = clearcoat;
    dst.clearcoatRoughness = 0.18;
    if (sheen) { dst.sheen = sheen; dst.sheenColor = new THREE.Color(0x9fe8ff); dst.sheenRoughness = 0.35; }
  }
  if (dst.isMeshStandardNodeMaterial) {
    let e = caustics ? materialColor.rgb.mul(causticLight()) : vec3(0);
    if (rim) {
      // back-scatter rim: separates silhouettes from the water like in underwater cinematography
      const fres = pow(float(1).sub(saturate(abs(dot(normalView, positionViewDirection)))), 3);
      e = e.add((rimColor ? vec3(rimColor.r, rimColor.g, rimColor.b) : U.shallow).mul(fres).mul(rim).mul(U.sunIntensity.mul(0.8).add(0.2)));
    }
    dst.emissiveNode = e;
  }
  return dst;
}

export function convertMaterials(root, opts) {
  const cache = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const conv = (m) => { if (!cache.has(m)) cache.set(m, toNodeMaterial(m, opts)); return cache.get(m); };
    o.material = Array.isArray(o.material) ? o.material.map(conv) : conv(o.material);
  });
}
