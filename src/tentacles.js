// The "50" drawn by tentacles of water. Several translucent water tubes rise from the sea, braided
// around each other like a vortex, then unfurl; their tips fly along the strokes of a monoline "50"
// and draw it, while two extra tentacles curl beside it. Thin golden threads spiral around the
// water here and there. Driven by one scroll value `form` (0..1) -> scrubbing back rewinds.
//
// Paths are built on the CPU each frame (Catmull-Rom final shapes, vortex braid, blend, sway,
// parallel-transport frames) and uploaded as a small float texture (SEG x tentacles*3 rows:
// position+radius, normal+arc length, binormal). The GPU draws them as instanced tubes.
import * as THREE from 'three/webgpu';
import {
  Fn, uniform, float, vec2, vec3, vec4, ivec2, int, attribute, instanceIndex, textureLoad, varying, normalize,
  cameraPosition, dot, max, pow, mix, smoothstep, saturate, clamp, screenUV, viewportTexture, texture, reflect,
  cameraViewMatrix, sin, cos, fract, hash, uint, uv, length,
} from 'three/tsl';
import { U, WATER_Y, causticTex, skyColor } from './shared.js';

const SEG = 256; // samples along each tentacle
const { clamp: clampJS, lerp } = THREE.MathUtils;
const ease = (k) => k * k * (3 - 2 * k);
const range = (x, a, b) => clampJS((x - a) / (b - a), 0, 1);

// ---------------------------------------------------------------------------------------------
// Monoline "50" (world metres; bottom y≈2, top y≈24, x -19..19, strokes at z=0) + stems to the sea.
// ---------------------------------------------------------------------------------------------
const V3 = (x, y, z = 0) => new THREE.Vector3(x, y, z);
const ellipse = (cx, cy, rx, ry, a0, a1, n) => Array.from({ length: n }, (_, k) => {
  const a = a0 + ((a1 - a0) * k) / (n - 1);
  return V3(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
});
const ZERO = { cx: 11, cy: 13, rx: 7.6, ry: 10.8 };

function tentacleDefs() {
  const z = ZERO;
  return [
    { // 5: top bar (right -> left) + upright
      stroke: 1.75,
      pts: [V3(-4, -1.5, -13), V3(-3, 9, -12), V3(-2.5, 19, -8), V3(-2.8, 23.2, -3), V3(-3.5, 24),
        V3(-10, 24.1), V3(-16.5, 24), V3(-17.5, 21), V3(-17.6, 17), V3(-17.4, 13.8)],
      strokeFrom: 4,
    },
    { // 5: bowl
      stroke: 1.75,
      pts: [V3(-15, -1.5, -13), V3(-16.5, 6, -11), V3(-17.5, 11, -5), V3(-17.4, 13.8), V3(-12.5, 15.6),
        V3(-6.5, 14.4), V3(-3.2, 9.6), V3(-4.2, 4.6), V3(-9.5, 2.1), V3(-15, 2.6), V3(-18.4, 5.6)],
      strokeFrom: 3,
    },
    { // 0: left half, top -> bottom (counter-clockwise)
      stroke: 1.75,
      pts: [V3(9, -1.5, -14), V3(9.5, 10, -12), V3(10.5, 20, -7), V3(10.9, 23.3, -2.5),
        ...ellipse(z.cx, z.cy, z.rx, z.ry, Math.PI / 2 - 0.12, Math.PI * 1.5 + 0.22, 12)],
      strokeFrom: 4,
    },
    { // 0: right half, bottom -> top (counter-clockwise, closes the loop)
      stroke: 1.75,
      pts: [V3(13, -1.5, -10), V3(12.5, 0.2, -6), V3(11.8, 1.6, -2),
        ...ellipse(z.cx, z.cy, z.rx, z.ry, -Math.PI / 2 - 0.05, Math.PI / 2 + 0.3, 12)],
      strokeFrom: 3,
    },
    { // decorative: curls up on the left
      stroke: 0, root: 2.1, tip: 0.45,
      pts: [V3(-28, -1.5, 4), V3(-29, 7, 4), V3(-27, 14, 3), V3(-23.5, 18.5, 3), V3(-20.5, 17.5, 5), V3(-21.5, 14.5, 6.5)],
    },
    { // decorative: curls up on the right
      stroke: 0, root: 2.1, tip: 0.45,
      pts: [V3(28, -1.5, 3), V3(29.5, 9, 3), V3(28, 17, 2), V3(24.5, 21.5, 2.5), V3(21.5, 20, 4.5), V3(22.5, 17, 6)],
    },
  ];
}

export function createWaterTentacles() {
  const defs = tentacleDefs();
  const T = defs.length;
  // final shapes: arc-length resampled Catmull-Rom
  for (const d of defs) {
    const curve = new THREE.CatmullRomCurve3(d.pts, false, 'centripetal');
    d.final = curve.getSpacedPoints(SEG - 1);
    d.len = curve.getLength();
    if (d.stroke) {
      const stem = new THREE.CatmullRomCurve3(d.pts.slice(0, d.strokeFrom + 1), false, 'centripetal').getLength();
      d.stemFrac = stem / d.len;
    }
  }
  defs.forEach((d, i) => { d.theta = (i / T) * Math.PI * 2; d.delay = [0, 0.05, 0.02, 0.08, 0.1, 0.12][i] ?? 0; });

  const data = new Float32Array(SEG * T * 3 * 4);
  const tex = new THREE.DataTexture(data, SEG, T * 3, THREE.RGBAFormat, THREE.FloatType);
  tex.needsUpdate = true;
  const u = { visible: uniform(0) };

  // ---- CPU path update
  const P = Array.from({ length: SEG }, () => new THREE.Vector3());
  const tan = new THREE.Vector3(), nrm = new THREE.Vector3(), bin = new THREE.Vector3(), tmp = new THREE.Vector3();
  function update(form, t) {
    const m = ease(range(form, 0.36, 0.72)); // braid -> final shape
    const settle = ease(range(form, 0.86, 1)); // once drawn, the stems retract up into the letters
    const sway = 1 - 0.82 * m;
    defs.forEach((d, i) => {
      // growth: rise ~20 m as a braid, then keep growing so the tip draws the stroke
      const gv = Math.min(1, 20 / d.len);
      const g = gv * ease(range(form, d.delay, 0.38)) + (1 - gv) * ease(range(form, 0.42 + d.delay * 0.3, 0.9));
      for (let k = 0; k < SEG; k++) {
        const s = k / (SEG - 1), sm = s * d.len;
        // vortex braid: all tentacles twist around one rising axis
        const h = sm * 0.85, rr = 4.2 + Math.min(sm, 30) * 0.22;
        const a = d.theta + h * 0.23 - t * 0.7;
        const bx = Math.cos(a) * rr, by = h - 1.5, bz = -4 + Math.sin(a) * rr;
        const f = d.final[k];
        P[k].set(lerp(bx, f.x, m), lerp(by, f.y, m), lerp(bz, f.z, m));
        // living sway, zero at the root
        const w = Math.min(1, sm / 8) * sway;
        P[k].x += Math.sin(t * 0.9 + s * 6 + i * 1.7) * 0.9 * w;
        P[k].y += Math.sin(t * 0.7 + s * 5 + i * 2.3) * 0.5 * w;
        P[k].z += Math.cos(t * 0.8 + s * 4 + i) * 0.9 * w;
        // after forming: a gentle breathing so the letters feel alive
        P[k].y += Math.sin(t * 1.1 + s * 9 + i) * 0.12 * m;
      }
      // parallel-transport frames + radius profile
      for (let k = 0; k < SEG; k++) {
        tan.subVectors(P[Math.min(k + 1, SEG - 1)], P[Math.max(k - 1, 0)]).normalize();
        if (k === 0) { nrm.set(0, 0, 1).cross(tan); if (nrm.lengthSq() < 1e-4) nrm.set(1, 0, 0); nrm.normalize(); }
        else nrm.addScaledVector(tan, -nrm.dot(tan)).normalize();
        bin.crossVectors(tan, nrm);
        const s = k / (SEG - 1), sm = s * d.len;
        let r;
        if (d.stroke) {
          const inStem = 1 - range(s, d.stemFrac - 0.04, d.stemFrac + 0.02);
          r = lerp(d.stroke, lerp(1.25, 2.0, 1 - Math.min(1, s / d.stemFrac)), inStem);
          r *= Math.sqrt(clampJS(((s - settle * (d.stemFrac + 0.01)) * d.len) / 2.2, 0, 1)); // rounded tail
        } else r = lerp(d.root, d.tip, Math.pow(s, 0.8));
        r *= lerp(0.72, 1, m);
        const tipK = clampJS(((g - s) * d.len) / 2.2, 0, 1); // rounded, travelling tip
        r *= Math.sqrt(tipK) * (s <= g ? 1 : 0);
        const o = ((i * 3) * SEG + k) * 4, o1 = ((i * 3 + 1) * SEG + k) * 4, o2 = ((i * 3 + 2) * SEG + k) * 4;
        data[o] = P[k].x; data[o + 1] = P[k].y; data[o + 2] = P[k].z; data[o + 3] = r;
        data[o1] = nrm.x; data[o1 + 1] = nrm.y; data[o1 + 2] = nrm.z; data[o1 + 3] = sm;
        data[o2] = bin.x; data[o2 + 1] = bin.y; data[o2 + 2] = bin.z; data[o2 + 3] = g;
      }
    });
    tex.needsUpdate = true;
  }

  // ---- tube geometry: attribute `tube` = (column 0..SEG-1, angle 0..2π)
  const makeTube = (radial) => {
    const pos = [], idx = [];
    for (let k = 0; k < SEG; k++) for (let j = 0; j <= radial; j++) pos.push(k, (j / radial) * Math.PI * 2, 0);
    for (let k = 0; k < SEG - 1; k++) for (let j = 0; j < radial; j++) {
      const a = k * (radial + 1) + j, b = a + radial + 1;
      idx.push(a, a + 1, b, a + 1, b + 1, b); // outward-facing (angle runs N -> B)
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length), 3));
    g.setIndex(idx);
    return g;
  };
  const row = (i, r, k) => textureLoad(tex, ivec2(k, i.mul(3).add(r)));

  const group = new THREE.Group();
  const sceneCopy = new THREE.FramebufferTexture();
  sceneCopy.type = THREE.HalfFloatType;

  // ---- water tubes
  {
    const lp = attribute('position', 'vec3');
    const k = int(lp.x), ang = lp.y;
    const i = int(instanceIndex);
    const A = row(i, 0, k), Nn = row(i, 1, k), Bn = row(i, 2, k);
    const dir = Nn.xyz.mul(cos(ang)).add(Bn.xyz.mul(sin(ang)));
    const wp = A.xyz.add(dir.mul(A.w));
    const vN = varying(dir), vW = varying(wp), vS = varying(Nn.w), vA = varying(ang), vR = varying(A.w);
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, fog: false });
    mat.positionNode = wp;
    mat.colorNode = Fn(() => {
      const N = normalize(vN);
      const V = normalize(cameraPosition.sub(vW));
      const NdV = saturate(dot(N, V));
      const fres = pow(float(1).sub(NdV), 2.2);
      const lit = U.sunIntensity.mul(0.8).add(0.25);
      // see-through water: refract what's behind, tinted
      const nv = cameraViewMatrix.mul(vec4(N, 0)).xyz;
      const behind = viewportTexture(clamp(screenUV.sub(nv.xy.mul(vec2(0.05, -0.05))), 0.001, 0.999), null, sceneCopy).rgb;
      // deep, clear blue body: the scene behind shows through, absorbed toward blue
      const body = behind.mul(vec3(0.16, 0.46, 0.7)).add(vec3(0.01, 0.1, 0.22).mul(lit));
      let c = mix(body, vec3(0.05, 0.32, 0.55).mul(lit), fres.mul(0.5));
      // caustic light flowing up the tentacle (bright cyan veins, like light inside water)
      const cuv = vec2(vA.mul(0.32), vS.mul(0.09).sub(U.time.mul(0.45)));
      const cz = texture(causticTex, cuv).r, cz2 = texture(causticTex, cuv.mul(1.7).add(vec2(0.3, U.time.mul(0.12)))).r;
      c = c.add(vec3(0.45, 0.92, 1.0).mul(pow(saturate(cz.mul(cz2).mul(2.2)), 3)).mul(0.45).mul(lit));
      // glowing edges + a touch of sky reflection + sun glint
      c = c.add(vec3(0.4, 0.88, 1.0).mul(pow(fres, 1.6)).mul(0.85).mul(lit));
      const R = reflect(V.negate(), N);
      c = mix(c, skyColor(normalize(vec3(R.x, max(R.y, 0.02), R.z)), false), fres.mul(0.18));
      c = c.add(U.sunColor.mul(pow(max(dot(R, U.sunDir), 0), 90).mul(2.2)).mul(U.sunIntensity));
      return c;
    })();
    mat.opacityNode = smoothstep(0.0, 0.05, vR).mul(u.visible);
    const mesh = new THREE.InstancedMesh(makeTube(22), mat, T);
    mesh.frustumCulled = false;
    mesh.renderOrder = 13;
    group.add(mesh);
  }

  // ---- golden threads: thin helices around the water, visible only in travelling stretches
  {
    const TH = 2;
    const lp = attribute('position', 'vec3');
    const k = int(lp.x), ang = lp.y;
    const ti = int(instanceIndex.div(uint(TH)));
    const which = float(instanceIndex.mod(uint(TH)));
    const A = row(ti, 0, k), Nn = row(ti, 1, k), Bn = row(ti, 2, k);
    const phi = Nn.w.mul(0.42).add(U.time.mul(1.3)).add(which.mul(3.1416)).add(float(ti).mul(1.3));
    const around = Nn.xyz.mul(cos(phi)).add(Bn.xyz.mul(sin(phi)));
    const centre = A.xyz.add(around.mul(A.w.mul(1.12)));
    const dir = Nn.xyz.mul(cos(ang)).add(Bn.xyz.mul(sin(ang)));
    const rad = float(0.1).mul(smoothstep(0.1, 0.4, A.w));
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, fog: false, depthWrite: false });
    mat.positionNode = centre.add(dir.mul(rad));
    // glimpses: bright stretches that travel along the tentacle
    const vis = varying(smoothstep(0.35, 0.75, sin(Nn.w.mul(0.16).sub(U.time.mul(0.9)).add(which.mul(2.1)).add(float(ti).mul(0.7)))));
    mat.colorNode = vec3(1.0, 0.62, 0.16).mul(2.2);
    mat.opacityNode = vis.mul(u.visible);
    const mesh = new THREE.InstancedMesh(makeTube(6), mat, T * TH);
    mesh.frustumCulled = false;
    mesh.renderOrder = 14;
    group.add(mesh);
  }

  // ---- churning foam where each tentacle leaves the sea
  {
    const PER = 420;
    const i = int(instanceIndex.div(uint(PER)));
    const h = hash(instanceIndex.add(uint(17))), h2 = hash(instanceIndex.add(uint(29))), h3 = hash(instanceIndex.add(uint(41)));
    const root = row(i, 0, int(10));
    const on = smoothstep(0.2, 0.6, root.w);
    const life = fract(U.time.mul(h.mul(0.3).add(0.25)).add(h2));
    const a = h3.mul(6.2832).add(U.time.mul(0.8));
    const r = root.w.add(0.2).add(life.mul(2.2));
    const wp = vec3(root.x.add(cos(a).mul(r)), float(WATER_Y + 0.1).add(life.mul(float(1).sub(life)).mul(h.mul(1.6))), root.z.add(sin(a).mul(r)));
    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, fog: false });
    mat.positionNode = wp;
    mat.scaleNode = h2.mul(0.5).add(0.35).mul(on);
    const d = length(uv().sub(0.5)).mul(2);
    mat.colorNode = vec3(0.9, 0.97, 1.0).mul(U.sunIntensity.mul(0.8).add(0.3));
    mat.opacityNode = smoothstep(1, 0.2, d).mul(float(1).sub(life)).mul(0.55).mul(on).mul(u.visible);
    const s = new THREE.Sprite(mat);
    s.count = T * PER;
    s.frustumCulled = false;
    s.renderOrder = 12;
    group.add(s);
  }

  group.userData.u = u;
  group.userData.update = update;
  // for the tuna that leap through the 0
  group.userData.hole = new THREE.Vector3(ZERO.cx, ZERO.cy, 0);
  group.userData.holeSize = new THREE.Vector2((ZERO.rx - 1.75) * 2, (ZERO.ry - 1.75) * 2);
  group.userData.center = new THREE.Vector3(0, 13, 0);
  return group;
}
