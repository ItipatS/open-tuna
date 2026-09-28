// Cinematic camera director: a looping shot list with fade cuts, letterboxing and smoothed
// follow cameras. Some shots also choreograph the action (force the school up, trigger a hunt).
import * as THREE from 'three/webgpu';

const V = () => new THREE.Vector3();

export class Director {
  constructor(ctx) {
    this.ctx = ctx;
    this.active = false;
    this.shotIndex = -1;
    this.shotTime = 0;
    this.fade = 0; // 0..1 cut transition
    this.pos = V(); this.look = V();
    this.wantPos = V(); this.wantLook = V();
    this.snap = true;
    const { tuna, sharks, blue, hump, turtles, bloomClusters, reefTop, school, breachFocus } = ctx;
    const goal = () => tuna.u.goal.value;
    const fwdOf = (o) => new THREE.Vector3(0, 0, 1).applyQuaternion(o.quaternion);

    this.shots = [
      {
        name: 'Breach — surface', dur: 13,
        enter: () => { school.forceSurface = 1; school.jumpBoost = 13; },
        exit: () => { school.forceSurface = 0; },
        cam: (t, p, l) => {
          const g = breachFocus;
          const a = 0.6 + t * 0.03;
          p.set(g.x + Math.cos(a) * 16, 1.3, g.z + Math.sin(a) * 16);
          l.set(g.x, 1.6, g.z);
        },
      },
      {
        name: 'School', dur: 12,
        cam: (t, p, l) => {
          const g = goal();
          const a = t * 0.12 + 1.3;
          p.set(g.x + Math.cos(a) * 17, Math.min(g.y + 2 + Math.sin(t * 0.3), -3), g.z + Math.sin(a) * 17);
          l.copy(g);
        },
      },
      {
        name: 'Hunt', dur: 11, stiff: 7,
        enter: () => {
          // start the hunt close to the school (hidden by the fade-in)
          const s = sharks[0], g = goal(), a = Math.random() * Math.PI * 2;
          s.obj.position.set(g.x + Math.cos(a) * 26, g.y - 2, g.z + Math.sin(a) * 26);
          s.dir.set(-Math.cos(a), 0, -Math.sin(a));
          s.state = 'stalk'; s.timer = 1.5;
        },
        cam: (t, p, l) => {
          const s = sharks[0].obj, f = fwdOf(s);
          const side = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0)).normalize();
          p.copy(s.position).addScaledVector(f, -8).addScaledVector(side, 3.5).add(new THREE.Vector3(0, 1.8, 0));
          l.copy(s.position).addScaledVector(f, 9);
        },
      },
      {
        name: 'Breach — below', dur: 12,
        enter: () => { school.forceSurface = 1; school.jumpBoost = 12; },
        exit: () => { school.forceSurface = 0; },
        cam: (t, p, l) => {
          const g = breachFocus;
          p.set(g.x + 11 - t * 0.3, -6.5, g.z + 9);
          l.set(g.x, -1.2, g.z);
        },
      },
      {
        name: 'Jelly bloom', dur: 12,
        cam: (t, p, l) => {
          const c = bloomClusters[0];
          p.set(c.x - 22 + t * 1.6, c.y + 1 + Math.sin(t * 0.2), c.z + 16 - t * 0.6);
          l.set(c.x, c.y - 1, c.z);
        },
      },
      {
        name: 'Blue whale', dur: 12,
        cam: (t, p, l) => {
          const f = fwdOf(blue);
          const side = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0)).normalize();
          p.copy(blue.position).addScaledVector(f, 30 - t * 1.2).addScaledVector(side, 22).add(new THREE.Vector3(0, -4, 0));
          l.copy(blue.position);
        },
      },
      {
        name: 'Reef', dur: 12,
        cam: (t, p, l) => {
          const tt = turtles[0].obj;
          const a = t * 0.06;
          p.set(tt.position.x + Math.cos(a) * 9, reefTop + 3 + t * 0.15, tt.position.z + Math.sin(a) * 9);
          l.copy(tt.position);
        },
      },
      {
        name: 'Humpback', dur: 10,
        cam: (t, p, l) => {
          const f = fwdOf(hump);
          p.copy(hump.position).addScaledVector(f, 24).add(new THREE.Vector3(6, -5, 0));
          l.copy(hump.position).addScaledVector(f, 4);
        },
      },
    ];
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.ctx.controls.enabled = false;
    this.shotIndex = -1;
    this.next(true);
    this.ctx.onChange?.(true);
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.shots[this.shotIndex]?.exit?.();
    this.ctx.controls.enabled = true;
    this.ctx.controls.target.copy(this.look);
    this.ctx.uFade.value = 1;
    this.ctx.uLetterbox.value = 0;
    this.ctx.onChange?.(false);
  }

  next(immediate = false) {
    this.shots[this.shotIndex]?.exit?.();
    this.shotIndex = (this.shotIndex + 1) % this.shots.length;
    this.shotTime = 0;
    this.shots[this.shotIndex].enter?.();
    this.snap = true;
    if (immediate) this.fade = 0;
  }

  update(dt) {
    const { camera, uFade, uLetterbox } = this.ctx;
    const shot = this.shots[this.shotIndex];
    this.shotTime += dt;
    shot.cam(this.shotTime, this.wantPos, this.wantLook);
    if (this.snap) { this.pos.copy(this.wantPos); this.look.copy(this.wantLook); this.snap = false; }
    const k = 1 - Math.exp(-dt * (shot.stiff || 2.2));
    this.pos.lerp(this.wantPos, k);
    this.look.lerp(this.wantLook, 1 - Math.exp(-dt * (shot.stiff || 3.5)));
    camera.position.copy(this.pos);
    camera.lookAt(this.look);

    // fade in at the head, fade out at the tail of every shot
    const fin = Math.min(1, this.shotTime / 0.7), fout = Math.min(1, (shot.dur - this.shotTime) / 0.45);
    uFade.value = Math.max(0, Math.min(fin, fout));
    uLetterbox.value += (0.1 - uLetterbox.value) * (1 - Math.exp(-dt * 3));
    if (this.shotTime >= shot.dur) this.next();
  }
}
