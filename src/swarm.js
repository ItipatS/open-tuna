// GPU fish school: boids simulated in a WebGPU compute shader (storage buffers never leave the GPU),
// rendered as ONE instanced draw with a procedural swim cycle in the vertex shader.
// Optional breaching: a subset of fish can rush the surface, fly ballistically and splash back in;
// every surface crossing is written to `state` so the splash particle system can react on the GPU.
import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, uniform, uint, float, vec3, vec4, instancedArray, instanceIndex, hash, attribute,
  normalLocal, normalize, cross, dot, length, max, clamp, pow, sin, cos, mix, smoothstep, select,
  inverseSqrt, abs, sign, floor, fract, sqrt,
} from 'three/tsl';
import { U, WATER_Y } from './shared.js';

const MAX_PREDATORS = 3;

export class FishSwarm {
  constructor({ geometry, materials, maxCount, count, center, half, size = [1, 1], speed = [2, 6],
    swim = { amp: 0.1, waveK: 3.2, freq: 1.2, base: 4 }, neighbour = 6, separation = 1.6,
    weights = { sep: 3.0, ali: 1.4, coh: 0.9, goal: 1.2, bound: 5, pred: 30, ray: 26 }, seed = 0, jumpers = 0,
    targets = null }) {
    this.maxCount = maxCount;
    this.jumpers = jumpers;
    this.pos = instancedArray(maxCount, 'vec4'); // xyz + swim phase
    this.vel = instancedArray(maxCount, 'vec4'); // xyz + speed
    this.state = instancedArray(Math.max(jumpers, 1), 'vec4'); // mode, crossX, crossZ, crossTime
    // scripted leaps: targets = { launch, land } Float32Array(maxCount*4) each.
    // launch = (x, y, z, w): w < 0 -> plain schooling; 10 <= w < 11 -> "hoop" group; 20 <= w < 21 -> "free"
    // group; fract(w) = loop phase. land = (x, y, z, apexY). Each fish loops: school, then a ballistic
    // leap launch -> land (apexY high) on its own period, easing in from wherever it was schooling.
    this.formation = !!targets;
    if (targets) {
      this.launch = instancedArray(targets.launch, 'vec4');
      this.land = instancedArray(targets.land, 'vec4');
      this.origin = instancedArray(maxCount, 'vec4'); // last schooling position
    }
    this.u = {
      count: uniform(count, 'uint'),
      samples: uniform(Math.min(count, 256), 'uint'),
      stride: uniform(1, 'uint'),
      offset: uniform(0, 'uint'),
      dt: uniform(0.016),
      center: uniform(center.clone()),
      half: uniform(half.clone()),
      goal: uniform(center.clone()),
      goalSpread: uniform(half.clone().multiplyScalar(0.35)),
      neighR2: uniform(neighbour * neighbour),
      sepR2: uniform(separation * separation),
      minSpeed: uniform(speed[0]),
      maxSpeed: uniform(speed[1]),
      wSep: uniform(weights.sep), wAli: uniform(weights.ali), wCoh: uniform(weights.coh),
      wGoal: uniform(weights.goal), wBound: uniform(weights.bound), wPred: uniform(weights.pred), wRay: uniform(weights.ray),
      preds: Array.from({ length: MAX_PREDATORS }, () => uniform(new THREE.Vector4(0, -9999, 0, 0))), // xyz, radius
      rayO: uniform(new THREE.Vector3()), rayD: uniform(new THREE.Vector3(0, -1, 0)), rayR: uniform(0),
      floorY: uniform(-30), ceilY: uniform(-2),
      swimAmp: uniform(swim.amp), waveK: uniform(swim.waveK), freq: uniform(swim.freq), baseFreq: uniform(swim.base),
      sizeMin: uniform(size[0]), sizeMax: uniform(size[1]),
      // breaching
      jumpChance: uniform(0.12), // probability per fish per period
      jumpPeriod: uniform(4.0),
      jumpDepth: uniform(9.0), // only fish shallower than this start a run
      jumpSpeed: uniform(12.5),
      jumpRadius: uniform(14), // only fish near the school centre breach (keeps the action framed)
      // formation (scroll-scrubbed): form 0 = all schooling, 1 = every fish holding its target
      hoop: uniform(0), free: uniform(0), leapPeriod: uniform(14), // group gates (0/1) + mean loop period (s)
    };
    this.frame = 0;
    this._buildCompute(seed);
    this._buildMesh(geometry, materials, seed);
    this.setCount(count);
    this.needsInit = true;
  }

  _buildCompute(seed) {
    const u = this.u, P = this.pos, Vb = this.vel, S = this.state, JUMPERS = this.jumpers;

    this.initNode = Fn(() => {
      const i = instanceIndex;
      const r = vec3(hash(i.add(uint(seed + 11))), hash(i.add(uint(seed + 7919))), hash(i.add(uint(seed + 104729)))).sub(0.5).mul(2);
      const p = u.center.add(r.mul(u.half).mul(0.8));
      const dir = normalize(vec3(r.z.add(0.001), r.y.mul(0.1), r.x.negate()));
      P.element(i).assign(vec4(p, hash(i.add(uint(seed + 3))).mul(6.283)));
      Vb.element(i).assign(vec4(dir.mul(u.minSpeed.add(u.maxSpeed).mul(0.5)), 1));
      if (JUMPERS) If(i.lessThan(uint(JUMPERS)), () => { S.element(i).assign(vec4(0, 0, 0, -100)); });
    })().compute(this.maxCount);

    const FORM = this.formation;
    const LA = this.launch, LD = this.land, OR = this.origin;

    this.updateNode = Fn(() => {
      const idx = instanceIndex;

      // Scripted flights are pure functions of (launch point, s), so scrubbing the scroll rewinds
      // exactly. The launch point is wherever the fish was schooling when s left 0.
      const finish = (pos, dir) => {
        const Pi = P.element(idx), Vi = Vb.element(idx);
        if (JUMPERS) {
          // surface crossings feed the splash system (same contract as breaching)
          If(idx.lessThan(uint(JUMPERS)), () => {
            const St = S.element(idx);
            St.x.assign(0);
            const oldY = Pi.y;
            If(oldY.lessThan(WATER_Y).and(pos.y.greaterThanEqual(WATER_Y)).or(oldY.greaterThanEqual(WATER_Y).and(pos.y.lessThan(WATER_Y))), () => {
              St.assign(vec4(0, pos.x, pos.z, U.time));
            });
          });
        }
        const phase = Pi.w.add(u.dt.mul(u.maxSpeed.mul(u.freq).add(u.baseFreq))).mod(628.3185);
        Pi.assign(vec4(pos, phase));
        Vi.assign(vec4(dir.mul(u.maxSpeed), u.maxSpeed));
      };

      // ballistic leap launch -> land, apex at land.w; eases in from the schooling position
      const leap = (A, B, s) => {
        const O = OR.element(idx).xyz;
        const y0 = mix(A.y, B.y, s);
        const hgt = B.w.sub(max(A.y, B.y)).mul(4);
        const arc = vec3(mix(A.x, B.x, s), y0.add(hgt.mul(s).mul(float(1).sub(s))), mix(A.z, B.z, s));
        const dArc = vec3(B.x.sub(A.x), B.y.sub(A.y).add(hgt.mul(float(1).sub(s.mul(2)))), B.z.sub(A.z));
        const blend = smoothstep(0, 0.2, s);
        const dir = normalize(mix(arc.sub(O).add(vec3(0, 0.0001, 0)), dArc, blend).add(vec3(0.0001, 0, 0)));
        finish(mix(O, arc, blend), dir);
      };

      const simulate = () => {
        const Pi = P.element(idx), Vi = Vb.element(idx);
        const pos = Pi.xyz.toVar(), vel = Vi.xyz.toVar();
        const mode = float(0).toVar();
        const clampSpeed = float(1).toVar();

        if (JUMPERS) {
          If(idx.lessThan(uint(JUMPERS)), () => {
            const St = S.element(idx);
            mode.assign(St.x);
            // ---- schooling -> start a surface run
            If(mode.equal(0), () => {
              const slot = uint(floor(U.time.div(u.jumpPeriod)));
              const r = hash(idx.mul(uint(7919)).add(slot.mul(uint(104729))).add(uint(seed)));
              const nearGoal = length(pos.xz.sub(u.goal.xz)).lessThan(u.jumpRadius);
              If(r.lessThan(u.jumpChance).and(pos.y.greaterThan(float(WATER_Y).sub(u.jumpDepth))).and(U.time.sub(St.w).greaterThan(u.jumpPeriod)).and(nearGoal), () => {
                mode.assign(1);
              });
            });
            // ---- rushing up
            If(mode.equal(1), () => {
              const flat = normalize(vec3(vel.x, 0, vel.z).add(vec3(0.0001, 0, 0)));
              const desired = normalize(flat.mul(0.75).add(vec3(0, 1, 0))).mul(u.jumpSpeed);
              vel.assign(mix(vel, desired, clamp(u.dt.mul(3.5), 0, 1)));
              clampSpeed.assign(0);
              If(pos.y.greaterThan(WATER_Y), () => {
                mode.assign(2);
                St.assign(vec4(2, pos.x, pos.z, U.time));
              });
            });
            // ---- airborne (ballistic)
            If(mode.equal(2), () => {
              vel.y.subAssign(u.dt.mul(9.81));
              clampSpeed.assign(0);
              If(pos.y.lessThan(WATER_Y).and(vel.y.lessThan(0)), () => {
                mode.assign(3);
                St.assign(vec4(3, pos.x, pos.z, U.time));
              });
            });
            // ---- re-entry: dive back under, then rejoin
            If(mode.equal(3), () => {
              vel.y.subAssign(u.dt.mul(4));
              clampSpeed.assign(0);
              If(U.time.sub(St.w).greaterThan(0.9), () => { mode.assign(0); });
            });
            St.x.assign(mode);
          });
        }

        If(mode.equal(0), () => {
          const sep = vec3(0).toVar(), ali = vec3(0).toVar(), coh = vec3(0).toVar(), n = float(0).toVar();

          // Neighbour scan: exhaustive for small schools, rotating strided subset for large ones.
          Loop({ start: uint(0), end: u.samples, type: 'uint', condition: '<' }, ({ i }) => {
            const j0 = i.mul(u.stride).add(u.offset).add(idx).toVar();
            If(j0.greaterThanEqual(u.count), () => { j0.subAssign(u.count); });
            If(j0.greaterThanEqual(u.count), () => { j0.subAssign(u.count); });
            If(j0.notEqual(idx), () => {
              const op = P.element(j0).xyz;
              const d = op.sub(pos);
              const d2 = dot(d, d);
              If(d2.lessThan(u.neighR2), () => {
                ali.addAssign(Vb.element(j0).xyz);
                coh.addAssign(op);
                n.addAssign(1);
                If(d2.lessThan(u.sepR2), () => { sep.subAssign(d.div(d2.add(0.05))); });
              });
            });
          });

          const steer = sep.mul(u.wSep).toVar();
          If(n.greaterThan(0), () => {
            steer.addAssign(ali.div(n).sub(vel).mul(u.wAli));
            steer.addAssign(coh.div(n).sub(pos).mul(u.wCoh));
          });

          // wandering goal (each fish has a personal offset -> school keeps volume)
          const off = vec3(hash(idx.add(uint(seed + 31))), hash(idx.add(uint(seed + 57))), hash(idx.add(uint(seed + 89)))).sub(0.5).mul(2).mul(u.goalSpread);
          const toGoal = u.goal.add(off).sub(pos);
          steer.addAssign(normalize(toGoal).mul(u.wGoal).mul(smoothstep(0, 25, length(toGoal)).add(0.25)));

          // soft box bounds
          const rel = pos.sub(u.center).div(u.half);
          steer.subAssign(sign(rel).mul(max(abs(rel).sub(0.85), 0)).mul(u.wBound).mul(u.maxSpeed));
          // floor and surface
          steer.y.addAssign(float(1).sub(smoothstep(0, 5, pos.y.sub(u.floorY))).mul(u.wBound).mul(2));
          steer.y.subAssign(float(1).sub(smoothstep(0, 3, u.ceilY.sub(pos.y))).mul(u.wBound).mul(3));

          // predators
          for (const pr of u.preds) {
            const dp = pos.sub(pr.xyz);
            const dl = length(dp);
            steer.addAssign(dp.div(dl.add(0.001)).mul(float(1).sub(smoothstep(0, pr.w, dl))).mul(u.wPred));
          }

          // cursor ray: flee from the closest point on the ray
          const w = pos.sub(u.rayO);
          const cp = u.rayO.add(u.rayD.mul(max(dot(w, u.rayD), 0)));
          const dr = pos.sub(cp);
          const drl = length(dr);
          steer.addAssign(dr.div(drl.add(0.001)).mul(float(1).sub(smoothstep(0, max(u.rayR, 0.001), drl))).mul(u.wRay).mul(select(u.rayR.greaterThan(0), 1, 0)));

          vel.addAssign(steer.mul(u.dt));
          vel.y.mulAssign(float(1).sub(u.dt.mul(1.2))); // fish prefer level swimming
        });

        const sp = length(vel);
        If(clampSpeed.greaterThan(0), () => {
          // ease back into the speed band (smooth after a breach)
          const target = clamp(sp, u.minSpeed, u.maxSpeed);
          vel.assign(vel.div(max(sp, 0.0001)).mul(mix(sp, target, clamp(u.dt.mul(4), 0, 1))));
        });
        // hard stage wall: past 1.2x the box radius, turn the horizontal velocity back inward
        If(mode.equal(0), () => {
          const rxz = pos.xz.sub(u.center.xz);
          const rl = length(rxz);
          If(rl.greaterThan(u.half.x.mul(1.2)), () => {
            const n = rxz.div(rl);
            const vn = dot(vel.xz, n);
            If(vn.greaterThan(0), () => { vel.x.subAssign(n.x.mul(vn).mul(1.6)); vel.z.subAssign(n.y.mul(vn).mul(1.6)); });
          });
        });
        pos.addAssign(vel.mul(u.dt));

        const spd = clamp(length(vel), u.minSpeed, u.maxSpeed);
        let phase = Pi.w.add(u.dt.mul(spd.mul(u.freq).add(u.baseFreq)));
        phase = select(phase.greaterThan(628.3185), phase.sub(628.3185), phase);
        Pi.assign(vec4(pos, phase));
        Vi.assign(vec4(vel, spd));
        if (FORM) OR.element(idx).assign(vec4(pos, 0));
      };

      If(idx.lessThan(u.count), () => {
        if (!FORM) return simulate();
        const A = LA.element(idx), B = LD.element(idx);
        const grp = floor(A.w.div(10));
        const on = grp.equal(1).and(u.hoop.greaterThan(0.5)).or(grp.equal(2).and(u.free.greaterThan(0.5)));
        // flight time of a real ballistic arc to that apex (+20% for the ease-in), per-fish period
        const air = sqrt(max(B.w.sub(max(A.y, B.y)), 0.5).mul(8 / 9.81)).mul(1.2);
        const period = u.leapPeriod.mul(hash(idx.add(uint(seed + 4099))).mul(0.9).add(0.6));
        const tl = fract(U.time.div(period).add(fract(A.w))).mul(period);
        If(A.w.greaterThanEqual(10).and(on).and(tl.lessThan(air)), () => {
          leap(A, B, tl.div(air));
        }).Else(simulate);
      });
    })().compute(this.maxCount);
  }

  _swimPosition(seed) {
    const u = this.u;
    const P = this.pos.toAttribute();
    const V = this.vel.toAttribute();
    return Fn(() => {
      const p = attribute('position', 'vec3');
      const nrm = attribute('normal', 'vec3');
      const scale = mix(u.sizeMin, u.sizeMax, hash(instanceIndex.add(uint(seed + 501))));

      // swim: travelling wave, amplitude growing toward the tail (thunniform)
      const t = clamp(float(0.5).sub(p.z), 0, 1);
      const env = pow(t, 2.4).add(0.04);
      const speedK = clamp(V.w.div(u.maxSpeed), 0.3, 1);
      const amp = u.swimAmp.mul(speedK.mul(0.6).add(0.4));
      const arg = P.w.sub(t.mul(u.waveK));
      const s = sin(arg), c = cos(arg);
      const lat = amp.mul(env).mul(s);
      const dLat = amp.mul(pow(t, 1.4).mul(2.4).mul(s).sub(env.mul(u.waveK).mul(c)));
      const bent = vec3(p.x.add(lat), p.y, p.z);

      // rotate the normal with the local body slope
      const m = dLat.negate();
      const ca = inverseSqrt(m.mul(m).add(1));
      const sa = m.mul(ca);
      const n2 = vec3(nrm.x.mul(ca).add(nrm.z.mul(sa)), nrm.y, nrm.z.mul(ca).sub(nrm.x.mul(sa)));

      // orient along velocity (robust when pointing straight up during a breach)
      const fwd = normalize(V.xyz.add(vec3(0, 0, 0.00001)));
      const right = normalize(cross(vec3(0, 1, 0), fwd).add(vec3(0.00001, 0, 0)));
      const up = cross(fwd, right);

      normalLocal.assign(normalize(right.mul(n2.x).add(up.mul(n2.y)).add(fwd.mul(n2.z))));
      return P.xyz.add(right.mul(bent.x).add(up.mul(bent.y)).add(fwd.mul(bent.z)).mul(scale));
    })();
  }

  _buildMesh(geometry, materials, seed) {
    for (const m of materials) m.positionNode = this._swimPosition(seed);
    this.mesh = new THREE.InstancedMesh(geometry, materials.length === 1 ? materials[0] : materials, this.maxCount);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = false;
  }

  setCount(n) {
    n = Math.max(0, Math.min(this.maxCount, Math.round(n)));
    this.count = n;
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    this.u.count.value = n;
    const samples = Math.min(n, 256);
    this.u.samples.value = Math.max(samples - 1, 0);
    this.u.stride.value = Math.max(1, Math.floor(n / Math.max(samples, 1)));
  }

  setPredator(i, position, radius) {
    this.u.preds[i].value.set(position.x, position.y, position.z, radius);
  }

  update(renderer, dt) {
    if (this.needsInit) { renderer.compute(this.initNode); this.needsInit = false; }
    if (this.count === 0) return;
    this.u.dt.value = Math.min(dt, 1 / 30);
    this.frame++;
    this.u.offset.value = this.u.stride.value > 1 ? (this.frame * 7) % this.u.stride.value : 1;
    renderer.compute(this.updateNode);
  }
}
