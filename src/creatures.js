// Non-schooling creatures: GPU-animated jellyfish bloom, procedurally flexing whale,
// skinned/animated models following smooth swim paths, and instanced reef decoration.
import * as THREE from 'three/webgpu';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import {
  Fn, uniform, uint, float, vec3, instanceIndex, hash, attribute, normalLocal, sin, cos, mix, smoothstep,
  normalize, pow, clamp, inverseSqrt, materialColor, dot, positionViewDirection, normalView, saturate, color,
} from 'three/tsl';
import { U } from './shared.js';
import { bakeModel, canonicalize, guessAxes, toNodeMaterial, convertMaterials } from './models.js';

// ---------------------------------------------------------------------------------------------
export function createJellyfish(gltf, { count = 40, center, extent }) {
  const { geometry, materials } = bakeModel(gltf.scene);
  // jellyfish: up is +Y, normalise to unit height, bell top at +0.5
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox, c = bb.getCenter(new THREE.Vector3()), h = bb.max.y - bb.min.y;
  geometry.translate(-c.x, -c.y, -c.z);
  geometry.scale(1 / h, 1 / h, 1 / h);

  const uCenter = uniform(center.clone()), uExtent = uniform(extent.clone());
  const posNode = Fn(() => {
    const p = attribute('position', 'vec3');
    const nrm = attribute('normal', 'vec3');
    const i = instanceIndex;
    const h1 = hash(i.add(uint(3))), h2 = hash(i.add(uint(17))), h3 = hash(i.add(uint(41))), h4 = hash(i.add(uint(97)));
    const t = U.time;
    const pulse = sin(t.mul(mix(1.3, 2.1, h4)).add(h1.mul(40)));
    const bell = smoothstep(-0.05, 0.3, p.y);
    const sway = sin(t.mul(1.1).add(p.y.mul(5)).add(h2.mul(20))).mul(0.05).mul(float(1).sub(bell));
    const q = vec3(
      p.x.mul(float(1).add(pulse.mul(0.1).mul(bell))).add(sway),
      p.y.mul(float(1).sub(pulse.mul(0.05))).add(pulse.mul(0.03)),
      p.z.mul(float(1).add(pulse.mul(0.1).mul(bell))).add(sway.mul(0.7)),
    );
    const yaw = h3.mul(6.283);
    const cy = cos(yaw), sy = sin(yaw);
    const rot = (v) => vec3(v.x.mul(cy).add(v.z.mul(sy)), v.y, v.z.mul(cy).sub(v.x.mul(sy)));
    const scale = mix(0.7, 1.8, h2);
    const drift = vec3(sin(t.mul(0.05).add(h1.mul(30))).mul(4), sin(t.mul(0.12).add(h3.mul(20))).mul(3), cos(t.mul(0.04).add(h2.mul(30))).mul(4));
    const base = uCenter.add(vec3(h1, h2, h3).sub(0.5).mul(uExtent)).add(drift);
    normalLocal.assign(rot(nrm));
    return base.add(rot(q).mul(scale));
  })();

  const mats = materials.map((m) => {
    const nm = toNodeMaterial(m);
    nm.positionNode = posNode;
    nm.transparent = true;
    nm.depthWrite = false;
    nm.side = THREE.DoubleSide;
    nm.opacity = Math.min(nm.opacity ?? 1, 0.75);
    const rim = pow(float(1).sub(saturate(dot(normalView, positionViewDirection).abs())), 2.5);
    nm.emissiveNode = materialColor.rgb.mul(0.25).add(color(0x7fd8ff).mul(rim).mul(0.6));
    return nm;
  });
  const mesh = new THREE.InstancedMesh(geometry, mats.length === 1 ? mats[0] : mats, count);
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  return mesh;
}

// ---------------------------------------------------------------------------------------------
// Static model with a procedural *vertical* fluke stroke (cetaceans flex up/down).
export function createFlexingWhale(gltf, { length = 14, flip = false, amp = 0.05, speed = 0.9, style = {} }) {
  const { geometry, materials } = bakeModel(gltf.scene);
  const axes = guessAxes(geometry, flip);
  canonicalize(geometry, axes.forward, axes.up);
  const uPhase = uniform(0);
  const posNode = Fn(() => {
    const p = attribute('position', 'vec3');
    const nrm = attribute('normal', 'vec3');
    const t = clamp(float(0.5).sub(p.z), 0, 1);
    const env = pow(t, 2.2);
    const arg = U.time.mul(speed).sub(t.mul(2.6));
    const s = sin(arg), c = cos(arg);
    const off = env.mul(s).mul(amp);
    const d = pow(t, 1.2).mul(2.2).mul(s).sub(env.mul(2.6).mul(c)).mul(amp).negate();
    const ca = inverseSqrt(d.mul(d).add(1)), sa = d.mul(ca);
    normalLocal.assign(vec3(nrm.x, nrm.y.mul(ca).add(nrm.z.mul(sa)), nrm.z.mul(ca).sub(nrm.y.mul(sa))));
    return vec3(p.x, p.y.add(off), p.z);
  })();
  const mats = materials.map((m) => { const nm = toNodeMaterial(m, style); nm.positionNode = posNode; return nm; });
  const mesh = new THREE.Mesh(geometry, mats.length === 1 ? mats[0] : mats);
  mesh.scale.setScalar(length);
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  const group = new THREE.Group();
  group.add(mesh);
  group.userData.phaseUniform = uPhase;
  return group;
}

// ---------------------------------------------------------------------------------------------
// Animated (skinned) model wrapped so that its forward axis is +Z and its length is `length`.
export function createAnimated(gltf, { length = 3, flip = false, yaw = 0, timeScale = 1, clone = false, style = {} }) {
  const scene = clone ? SkeletonUtils.clone(gltf.scene) : gltf.scene;
  const { geometry } = bakeModel(scene);
  const axes = guessAxes(geometry, flip);
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox, c = bb.getCenter(new THREE.Vector3());
  const len = Math.abs(axes.forward.x) > 0.5 ? bb.max.x - bb.min.x : bb.max.z - bb.min.z;
  geometry.dispose();

  const inner = new THREE.Group();
  inner.add(scene);
  scene.position.sub(c);
  const pivot = new THREE.Group();
  pivot.add(inner);
  pivot.rotation.y = Math.atan2(axes.forward.x, axes.forward.z) * -1 + yaw;
  pivot.scale.setScalar(length / len);
  const outer = new THREE.Group();
  outer.add(pivot);

  convertMaterials(scene, style);
  scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });

  const mixer = new THREE.AnimationMixer(scene);
  if (gltf.animations.length) {
    const a = mixer.clipAction(gltf.animations[0]);
    a.timeScale = timeScale;
    a.play();
    a.time = Math.random() * gltf.animations[0].duration;
  }
  outer.userData.mixer = mixer;
  return outer;
}

// Smooth closed swim path (Lissajous-ish ellipse) with look-ahead orientation.
export class SwimPath {
  constructor({ center = new THREE.Vector3(), rx = 30, rz = 20, y = -15, yAmp = 3, speed = 3, phase = 0, dir = 1 }) {
    Object.assign(this, { center, rx, rz, y, yAmp, speed, dir });
    this.theta = phase;
    this.perimeter = Math.PI * (3 * (rx + rz) - Math.sqrt((3 * rx + rz) * (rx + 3 * rz)));
  }
  at(theta, out) {
    return out.set(this.center.x + Math.cos(theta) * this.rx, this.y + Math.sin(theta * 2 + 0.7) * this.yAmp, this.center.z + Math.sin(theta) * this.rz);
  }
  step(obj, dt) {
    this.theta += this.dir * (this.speed / this.perimeter) * Math.PI * 2 * dt;
    this.at(this.theta, obj.position);
    const ahead = this.at(this.theta + this.dir * 0.02, new THREE.Vector3());
    const behind = this.at(this.theta - this.dir * 0.02, new THREE.Vector3());
    obj.lookAt(ahead);
    // bank into the turn
    const t1 = ahead.clone().sub(obj.position), t0 = obj.position.clone().sub(behind);
    const turn = t0.x * t1.z - t0.z * t1.x;
    obj.rotateZ(THREE.MathUtils.clamp(turn * 8, -0.35, 0.35));
  }
}

// ---------------------------------------------------------------------------------------------
// Instanced static decoration placed on the seabed.
export function scatterInstanced(gltf, { count, placer, size = [1, 2], upright = true }) {
  const { geometry, materials } = bakeModel(gltf.scene);
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox, s = bb.getSize(new THREE.Vector3()), c = bb.getCenter(new THREE.Vector3());
  const norm = 1 / Math.max(s.x, s.y, s.z);
  geometry.translate(-c.x, -bb.min.y, -c.z);
  geometry.scale(norm, norm, norm);
  const mats = materials.map((m) => toNodeMaterial(m));
  const mesh = new THREE.InstancedMesh(geometry, mats.length === 1 ? mats[0] : mats, count);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), e = new THREE.Euler();
  for (let i = 0; i < count; i++) {
    placer(p, i);
    e.set(upright ? (Math.random() - 0.5) * 0.25 : Math.random() * 6.28, Math.random() * Math.PI * 2, upright ? (Math.random() - 0.5) * 0.25 : 0);
    q.setFromEuler(e);
    sc.setScalar(THREE.MathUtils.lerp(size[0], size[1], Math.random()));
    mesh.setMatrixAt(i, m4.compose(p, q, sc));
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.computeBoundingSphere();
  return mesh;
}

// ---------------------------------------------------------------------------------------------
// Shark hunting AI: cruise circles around the school, stalk in, then a fast lunge straight
// through it (the tuna scatter via the predator uniforms), then peel away and repeat.
export class Hunter {
  constructor(obj, { getPrey, cruise = 4.2, stalk = 6.5, lunge = 15, turn = 1.1, floorY = -20, seed = 0 }) {
    Object.assign(this, { obj, getPrey, cruise, stalkSpeed: stalk, lungeSpeed: lunge, turn, floorY });
    this.dir = new THREE.Vector3(Math.cos(seed * 3), 0, Math.sin(seed * 3));
    this.speed = cruise;
    this.state = 'cruise';
    this.timer = 6 + seed * 5 + Math.random() * 4;
    this.orbit = seed * 3;
    this.orbitDir = seed % 2 ? -1 : 1;
    this.aim = new THREE.Vector3();
    this.lock = new THREE.Vector3();
    this.yawRate = 0;
    const prey = getPrey();
    obj.position.set(prey.x + 35 * Math.cos(this.orbit), prey.y - 3, prey.z + 35 * Math.sin(this.orbit));
  }
  get lunging() { return this.state === 'lunge'; }
  update(dt) {
    const prey = this.getPrey(), p = this.obj.position;
    let target = this.cruise, turn = this.turn;
    this.timer -= dt;
    if (this.state === 'cruise') {
      this.orbit += this.orbitDir * dt * 0.12;
      this.aim.set(prey.x + Math.cos(this.orbit) * 30, prey.y - 3 + Math.sin(this.orbit * 2) * 2, prey.z + Math.sin(this.orbit) * 30);
      if (this.timer < 0) { this.state = 'stalk'; this.timer = 3.5; }
    } else if (this.state === 'stalk') {
      target = this.stalkSpeed;
      const away = p.clone().sub(prey).setY(0).normalize();
      this.aim.copy(prey).addScaledVector(away, 12);
      this.aim.y = prey.y - 1;
      if (this.timer < 0 || p.distanceTo(this.aim) < 5) {
        this.state = 'lunge'; this.timer = 2.8;
        this.lock.copy(prey).addScaledVector(prey.clone().sub(p).normalize(), 18);
      }
    } else if (this.state === 'lunge') {
      target = this.lungeSpeed; turn = this.turn * 0.6;
      this.aim.copy(this.lock);
      if (this.timer < 0) { this.state = 'cruise'; this.timer = 9 + Math.random() * 8; this.orbit = Math.atan2(p.z - prey.z, p.x - prey.x); this.orbitDir *= -1; }
    }
    // steer with a limited turn rate
    const want = this.aim.clone().sub(p).normalize();
    const ang = this.dir.angleTo(want);
    const prevYaw = Math.atan2(this.dir.x, this.dir.z);
    if (ang > 1e-4) {
      const k = Math.min(1, (turn * dt) / ang);
      this.dir.lerp(want, k).normalize();
    }
    this.dir.y = THREE.MathUtils.clamp(this.dir.y, -0.35, 0.35);
    this.dir.normalize();
    let dy = Math.atan2(this.dir.x, this.dir.z) - prevYaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.yawRate = THREE.MathUtils.lerp(this.yawRate, dy / Math.max(dt, 1e-4), 0.08);
    this.speed = THREE.MathUtils.lerp(this.speed, target, 1 - Math.exp(-dt * (this.state === 'lunge' ? 3 : 1)));
    p.addScaledVector(this.dir, this.speed * dt);
    p.y = THREE.MathUtils.clamp(p.y, this.floorY + 2, -1.8);
    this.obj.lookAt(p.clone().add(this.dir));
    this.obj.rotateZ(THREE.MathUtils.clamp(-this.yawRate * 0.35, -0.5, 0.5));
    const mixer = this.obj.userData.mixer;
    if (mixer) mixer.timeScale = 0.55 + this.speed / 7;
  }
}
