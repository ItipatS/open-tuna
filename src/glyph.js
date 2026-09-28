// The "50": a sculpture of golden water. A 2D signed distance field of the text (CPU EDT, baked
// once) is extruded and ray-marched inside a box; the surface flows with animated noise, refracts
// the scene behind it (screen-space), tints gold by absorption and reflects the sky. It rises out of
// the sea trailing liquid tendrils (smooth-min capsules) and drips.
import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, Break, Discard, uniform, uniformArray, float, int, vec2, vec3, vec4, texture, positionWorld, cameraPosition,
  normalize, length, max, min, abs, dot, reflect, refract, pow, exp, mix, smoothstep, saturate, clamp, screenUV,
  viewportTexture, mx_noise_float, cameraViewMatrix, uv, instanceIndex, hash, uint, fract, sin, cos, instancedArray,
} from 'three/tsl';
import { U, WATER_Y, skyColor, causticTex } from './shared.js';

const GW = 512, GH = 320;

// Felzenszwalb & Huttenlocher squared Euclidean distance transform
function edt(feature, W, H) {
  const INF = 1e20, g = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) g[i] = feature[i] ? 0 : INF;
  const n = Math.max(W, H), f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  const dt = (len) => {
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
  };
  for (let x = 0; x < W; x++) { for (let y = 0; y < H; y++) f[y] = g[y * W + x]; dt(H); for (let y = 0; y < H; y++) g[y * W + x] = d[y]; }
  for (let y = 0; y < H; y++) { for (let x = 0; x < W; x++) f[x] = g[y * W + x]; dt(W); for (let x = 0; x < W; x++) g[y * W + x] = d[x]; }
  return g;
}

// Bake the text SDF. Row 0 = bottom (world +y up). Returns world-space helpers too.
export function bakeGlyph({ text = '50', width = 40, bottom = 1.8, thick = 5 } = {}) {
  const cv = document.createElement('canvas');
  cv.width = GW * 2; cv.height = GH * 2;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  const font = '900 560px "Arial Black", "Helvetica Neue", Arial, sans-serif';
  g.font = font;
  g.fillText(text, GW, GH + 30);
  const img = g.getImageData(0, 0, GW * 2, GH * 2).data;
  const inside = new Uint8Array(GW * GH);
  let x0 = GW, x1 = 0, y0 = GH, y1 = 0;
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
    const cy = GH * 2 - 1 - j * 2; // flip: row 0 at the bottom
    if (img[(cy * GW * 2 + i * 2) * 4 + 3] > 127) {
      inside[j * GW + i] = 1;
      x0 = Math.min(x0, i); x1 = Math.max(x1, i); y0 = Math.min(y0, j); y1 = Math.max(y1, j);
    }
  }
  const dOut = edt(inside, GW, GH), dIn = edt(inside.map((b) => 1 - b), GW, GH);
  const px = width / (x1 - x0); // metres per SDF texel
  const sdf = new Float32Array(GW * GH);
  const half = new Uint16Array(GW * GH);
  for (let i = 0; i < GW * GH; i++) {
    sdf[i] = (Math.sqrt(dOut[i]) - Math.sqrt(dIn[i])) * px;
    half[i] = THREE.DataUtils.toHalfFloat(sdf[i]);
  }
  const tex = new THREE.DataTexture(half, GW, GH, THREE.RedFormat, THREE.HalfFloatType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;

  // world placement: glyph bbox centre, resting with its bottom at `bottom`
  const height = (y1 - y0) * px;
  const center = new THREE.Vector3(0, bottom + height / 2, 0);
  const texSize = new THREE.Vector2(GW * px, GH * px);
  const bxc = (x0 + x1) / 2, byc = (y0 + y1) / 2;
  const toWorld = (i, j) => new THREE.Vector3(center.x + (i - bxc) * px, center.y + (j - byc) * px, 0);
  const at = (i, j) => sdf[Math.max(0, Math.min(GH - 1, j)) * GW + Math.max(0, Math.min(GW - 1, i))];

  // hole of the "0": centre of the second character's advance box, measured on the canvas
  const w5 = g.measureText(text[0]).width, wAll = g.measureText(text).width;
  const hi = Math.round((GW * 2 - wAll) / 4 + w5 / 2 + (wAll - w5) / 4), hj = Math.round(byc);
  let hl = 0, hr = 0, hu = 0, hd = 0;
  while (at(hi - hl, hj) > 0 && hl < 200) hl++;
  while (at(hi + hr, hj) > 0 && hr < 200) hr++;
  while (at(hi, hj + hu) > 0 && hu < 200) hu++;
  while (at(hi, hj - hd) > 0 && hd < 200) hd++;
  const hole = toWorld(hi + (hr - hl) / 2, hj + (hu - hd) / 2);
  const holeSize = new THREE.Vector2((hl + hr) * px, (hu + hd) * px);

  // tendril anchors: columns whose lowest filled texel is near the glyph bottom
  const anchors = [];
  for (let k = 0; k < 9; k++) {
    const i = Math.round(x0 + (x1 - x0) * (0.06 + 0.88 * k / 8));
    let j = y0; while (j < y1 && !inside[j * GW + i]) j++;
    if (j - y0 < (y1 - y0) * 0.08) anchors.push(toWorld(i, j).x);
  }

  // points well inside the letters (for fish swimming inside the water)
  const insidePoints = (n, margin = 1.5) => {
    const pts = [];
    while (pts.length < n) {
      const i = x0 + Math.floor(Math.random() * (x1 - x0)), j = y0 + Math.floor(Math.random() * (y1 - y0));
      if (at(i, j) < -margin) pts.push(toWorld(i, j).setZ((Math.random() - 0.5) * (thick - 2 * margin)));
    }
    return pts;
  };

  return { tex, px, texSize, center, height, width, thick, hole, holeSize, anchors, insidePoints };
}

const sceneCopy = new THREE.FramebufferTexture();
sceneCopy.type = THREE.HalfFloatType;

export function createWaterGlyph(G) {
  const u = {
    lift: uniform(-(G.height + 4)), // y offset of the glyph (rises from under the sea to 0)
    tendril: uniform(0), // radius scale of the liquid columns joining it to the sea
    glow: uniform(1),
  };
  const halfT = G.thick / 2, R = 0.9;
  const margin = 2.5;
  const boxMin = new THREE.Vector3(G.center.x - G.width / 2 - margin, -2.5, -halfT - margin);
  const boxMax = new THREE.Vector3(G.center.x + G.width / 2 + margin, G.center.y + G.height / 2 + margin, halfT + margin);
  const bMin = uniform(boxMin), bMax = uniform(boxMax);
  const anchors = uniformArray(G.anchors.length ? G.anchors : [0], 'float');
  const NA = Math.max(G.anchors.length, 1);
  const gBottom = G.center.y - G.height / 2;

  const smin = (a, b, k) => {
    const h = clamp(float(0.5).add(b.sub(a).mul(0.5).div(k)), 0, 1);
    return mix(b, a, h).sub(k.mul(h).mul(float(1).sub(h)));
  };

  const map = Fn(([p]) => {
    const q = p.sub(vec3(G.center.x, float(G.center.y).add(u.lift), G.center.z));
    const tuv = q.xy.div(vec2(G.texSize.x, G.texSize.y)).add(0.5);
    const d2 = texture(G.tex, tuv).level(0).r;
    const w = vec2(d2.add(R * 0.4), abs(q.z).sub(halfT - R));
    let sd = min(max(w.x, w.y), 0).add(length(max(w, vec2(0)))).sub(R);
    // flowing water surface
    const flow = mx_noise_float(p.mul(0.32).add(vec3(0, U.time.mul(-0.55), U.time.mul(0.18))));
    sd = sd.add(flow.mul(0.32));
    // liquid columns tying the rising glyph to the sea
    const top = float(gBottom).add(u.lift).add(1.2);
    const res = sd.toVar();
    Loop(NA, ({ i }) => {
      const ax = anchors.element(i);
      const py = clamp(p.y, -4, top);
      const t = saturate(p.y.add(4).div(max(top.add(4), 0.01)));
      const rad = u.tendril.mul(mix(2.4, 1.1, sin(t.mul(3.1416)))).mul(float(0.8).add(fract(ax.mul(0.37)).mul(0.5)));
      const off = float(1).sub(smoothstep(0, 0.05, u.tendril)).mul(50); // no columns at all once detached
      const cap = length(p.sub(vec3(ax.add(sin(p.y.mul(0.4).add(U.time)).mul(0.35)), py, 0))).sub(rad).add(off);
      res.assign(smin(res, cap, float(2.2)));
    });
    return res;
  });

  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, fog: false, depthWrite: false });
  mat.colorNode = Fn(() => {
    const ro = cameraPosition;
    const rd = normalize(positionWorld.sub(ro));
    // slab intersection with the bounding box
    const inv = vec3(1).div(rd);
    const t0 = bMin.sub(ro).mul(inv), t1 = bMax.sub(ro).mul(inv);
    const tmin = min(t0, t1), tmax = max(t0, t1);
    const tn = max(max(max(tmin.x, tmin.y), tmin.z), 0);
    const tf = min(min(tmax.x, tmax.y), tmax.z);
    const t = tn.toVar(), hit = float(0).toVar();
    Loop(80, () => {
      const d = map(ro.add(rd.mul(t)));
      If(d.lessThan(0.015), () => { hit.assign(1); Break(); });
      t.addAssign(max(d.mul(0.8), 0.02));
      If(t.greaterThan(tf), () => { Break(); });
    });
    If(hit.lessThan(0.5), () => { Discard(); });

    const p = ro.add(rd.mul(t));
    If(p.y.lessThan(WATER_Y - 0.2), () => { Discard(); }); // the sea hides what's below it
    const e = 0.06;
    const n = normalize(
      vec3(1, -1, -1).mul(map(p.add(vec3(e, -e, -e))))
        .add(vec3(-1, -1, 1).mul(map(p.add(vec3(-e, -e, e)))))
        .add(vec3(-1, 1, -1).mul(map(p.add(vec3(-e, e, -e)))))
        .add(vec3(1, 1, 1).mul(map(p.add(vec3(e, e, e))))),
    );
    const V = rd.negate();
    const NdV = saturate(dot(n, V));
    const fres = float(0.04).add(pow(float(1).sub(NdV), 5).mul(0.96));
    const Rv = reflect(rd, n);
    const refl = skyColor(normalize(vec3(Rv.x, max(Rv.y, 0.02), Rv.z)), true);

    // screen-space refraction; thickness from a short inward march
    const Tr = refract(rd, n, 1 / 1.33);
    const tIn = float(0.3).toVar();
    Loop(10, () => {
      const d = map(p.add(Tr.mul(tIn)));
      If(d.greaterThan(0), () => { Break(); });
      tIn.addAssign(max(d.negate().mul(0.9), 0.25));
    });
    const nv = cameraViewMatrix.mul(vec4(n, 0)).xyz;
    const ruv = clamp(screenUV.sub(nv.xy.mul(vec2(0.035, -0.035)).mul(min(tIn, 6).mul(0.35).add(0.4))), 0.001, 0.999);
    const behind = viewportTexture(ruv, null, sceneCopy).rgb;
    const gold = vec3(1.0, 0.68, 0.22);
    const trans = exp(vec3(0.012, 0.045, 0.13).mul(tIn).negate());
    const lit = U.sunIntensity.mul(0.8).add(0.2);
    const scatter = gold.mul(U.sunColor).mul(0.35).mul(lit);
    let col = behind.mul(trans).add(scatter.mul(float(1).sub(trans)));

    // caustic veins inside the water, sun glints and a hot golden rim
    const cz = texture(causticTex, p.xy.mul(0.06).add(vec2(U.time.mul(0.02), U.time.mul(-0.035)))).r;
    const cz2 = texture(causticTex, p.zy.mul(0.09).add(p.x.mul(0.013)).add(vec2(U.time.mul(-0.015), U.time.mul(0.02)))).r;
    col = col.add(gold.mul(pow(cz.mul(cz2).mul(3.2), 2.2)).mul(0.9).mul(lit));
    const L = U.sunDir;
    const spec = pow(max(dot(Rv, L), 0), 600).mul(60).add(pow(max(dot(Rv, L), 0), 40).mul(0.9));
    const rim = pow(float(1).sub(NdV), 3).mul(1.6);
    const back = pow(saturate(dot(V.negate(), L)), 4).mul(1.4); // sun behind: glowing translucence
    col = mix(col, refl, fres.mul(0.85));
    col = col.add(U.sunColor.mul(spec).mul(U.sunIntensity));
    col = col.add(gold.mul(rim.add(back.mul(float(1).sub(trans.g)))).mul(lit).mul(u.glow));
    return col;
  })();

  const size = boxMax.clone().sub(boxMin);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), mat);
  mesh.position.copy(boxMin).add(boxMax).multiplyScalar(0.5);
  mesh.frustumCulled = false;
  mesh.renderOrder = 14;
  mesh.userData.u = u;
  return mesh;
}

// Water dripping off the glyph: procedural sprites, emitted from inside the letters and falling
// under gravity; amount follows `drip` (strong while rising, a trickle once it hovers).
export function createGlyphDrips(G, count = 7000) {
  const pts = G.insidePoints(count, 0.2);
  const arr = new Float32Array(count * 4);
  pts.forEach((p, k) => arr.set([p.x, p.y, p.z, Math.random()], k * 4));
  const buf = instancedArray(arr, 'vec4');
  const u = { lift: uniform(0), drip: uniform(0) };
  const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
  const i = instanceIndex;
  const src = buf.element(i);
  const life = 1.3;
  const age = fract(U.time.div(life).add(src.w)).mul(life);
  const drift = vec2(hash(i.add(uint(7))).sub(0.5), hash(i.add(uint(13))).sub(0.5)).mul(age).mul(0.8);
  const y = src.y.add(u.lift).sub(age.mul(age).mul(4.9));
  const wp = vec3(src.x.add(drift.x), y, src.z.add(drift.y));
  mat.positionNode = wp;
  const on = hash(i.add(uint(29))).lessThan(u.drip).and(y.greaterThan(WATER_Y)).select(1, 0);
  mat.scaleNode = hash(i.add(uint(41))).mul(0.07).add(0.035).mul(on);
  const d = length(uv().sub(0.5)).mul(2);
  const core = smoothstep(0.6, 0.0, d);
  mat.colorNode = mix(vec3(1.0, 0.85, 0.5), vec3(1.0), core).mul(U.sunIntensity.mul(0.9).add(0.3)).mul(core.mul(1.5).add(0.5));
  mat.opacityNode = core.mul(0.8).add(smoothstep(1, 0.8, d).mul(0.3)).mul(on).mul(smoothstep(0, 0.15, age));
  const s = new THREE.Sprite(mat);
  s.count = count;
  s.frustumCulled = false;
  s.renderOrder = 13;
  s.userData.u = u;
  return s;
}
