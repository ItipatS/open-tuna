// Global uniforms and shared procedural shading (sky, caustics, fog, image-based light).
import * as THREE from 'three/webgpu';
import {
  uniform, vec2, vec3, float, texture, max, min, pow, dot, mix, smoothstep, exp, saturate,
  normalize, positionWorld, cameraPosition, normalWorld, mx_noise_float, fog,
} from 'three/tsl';

export const WATER_Y = 0;
export const SEABED_BASE = -24;

export const U = {
  time: uniform(0),
  under: uniform(0), // 1 when the camera is below the surface
  sunDir: uniform(new THREE.Vector3(0.3, 0.8, 0.4).normalize()),
  sunColor: uniform(new THREE.Color(1, 0.95, 0.88)),
  sunIntensity: uniform(1),
  camDepth: uniform(0), // metres below the surface (>= 0)
  // tropical palette (linear)
  deep: uniform(new THREE.Color(0.0, 0.022, 0.06)),
  mid: uniform(new THREE.Color(0.0, 0.1, 0.17)),
  shallow: uniform(new THREE.Color(0.02, 0.36, 0.46)),
  causticStrength: uniform(2.1),
  fogDensity: uniform(0.0105),
};

// ---------------------------------------------------------------------------------------------
// Caustics: tileable caustic pattern baked once on the CPU, sampled twice at different scales /
// drift directions and combined with min() for an animated look.
// ---------------------------------------------------------------------------------------------
function bakeCausticTexture(size = 512) {
  const data = new Uint8Array(size * size * 4);
  const TAU = Math.PI * 2, inten = 0.005, t = 17.3;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x / size) * TAU - 250, py = (y / size) * TAU - 250;
      let ix = px, iy = py, c = 1;
      for (let n = 0; n < 5; n++) {
        const tt = t * (1 - 3.5 / (n + 1));
        const nx = px + Math.cos(tt - ix) + Math.sin(tt + iy);
        const ny = py + Math.sin(tt - iy) + Math.cos(tt + ix);
        ix = nx; iy = ny;
        c += 1 / Math.hypot(px / (Math.sin(ix + tt) / inten), py / (Math.cos(iy + tt) / inten));
      }
      c /= 5;
      c = 1.17 - Math.pow(c, 1.4);
      const v = Math.min(1, Math.pow(Math.abs(c), 8));
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v * 255; data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}
export const causticTex = bakeCausticTexture();

// Caustic light arriving at a world position (projected up the sun direction to the surface).
export function causticLight(wp = positionWorld, nrm = normalWorld) {
  const depth = max(float(WATER_Y).sub(wp.y), 0);
  const proj = wp.xz.add(U.sunDir.xz.mul(depth.div(max(U.sunDir.y, 0.15))));
  const t = U.time;
  const uvA = proj.mul(0.055).add(vec2(t.mul(0.011), t.mul(0.007)));
  const uvB = vec2(proj.x.mul(0.043).sub(proj.y.mul(0.028)), proj.x.mul(0.028).add(proj.y.mul(0.043))).add(vec2(t.mul(-0.009), t.mul(0.012)));
  const ab = vec2(0.004, 0.0); // chromatic split
  const r = min(texture(causticTex, uvA.add(ab)).r, texture(causticTex, uvB.add(ab)).r);
  const g = min(texture(causticTex, uvA).r, texture(causticTex, uvB).r);
  const b = min(texture(causticTex, uvA.sub(ab)).r, texture(causticTex, uvB.sub(ab)).r);
  const underMask = smoothstep(0.0, 0.6, depth);
  const fade = exp(depth.mul(-0.03));
  const facing = saturate(nrm.y.mul(0.75).add(0.25));
  return vec3(r, g, b).mul(U.sunColor).mul(U.sunIntensity).mul(U.causticStrength).mul(underMask).mul(fade).mul(facing);
}

// ---------------------------------------------------------------------------------------------
// Procedural sky: gradient + sun disc/halo + fbm clouds. `dir` must be normalised.
// ---------------------------------------------------------------------------------------------
export function skyColor(dir, withClouds = true) {
  const y = max(dir.y, 0);
  const zenith = vec3(0.04, 0.2, 0.66);
  const horizon = vec3(0.46, 0.68, 0.88);
  const warm = U.sunColor.mul(0.5);
  const lowSun = float(1).sub(smoothstep(0.05, 0.45, U.sunDir.y));
  const hor = mix(horizon, horizon.mul(0.6).add(warm), lowSun.mul(0.7));
  let col = mix(hor, zenith, pow(y, 0.5)).mul(mix(1.0, 0.55, lowSun));
  const s = max(dot(dir, U.sunDir), 0);
  if (withClouds) {
    const cuv = dir.xz.div(y.add(0.12)).mul(0.9).add(vec2(U.time.mul(0.004), U.time.mul(0.002)));
    const n = mx_noise_float(vec3(cuv.x, cuv.y, U.time.mul(0.01))).mul(0.6)
      .add(mx_noise_float(vec3(cuv.x.mul(2.3), cuv.y.mul(2.3), 3.1)).mul(0.3))
      .add(mx_noise_float(vec3(cuv.x.mul(5.1), cuv.y.mul(5.1), 7.7)).mul(0.12));
    const cloud = smoothstep(0.12, 0.6, n).mul(smoothstep(0.02, 0.2, y));
    const cloudCol = mix(vec3(1.0, 0.99, 0.97), U.sunColor, 0.3).mul(mix(0.7, 1.2, pow(s, 3)));
    col = mix(col, cloudCol, cloud.mul(0.8));
  }
  col = col.add(U.sunColor.mul(pow(s, 6).mul(0.14).add(pow(s, 64).mul(0.4)).add(smoothstep(0.9993, 0.9997, s).mul(40))));
  const below = saturate(dir.y.mul(-6));
  return mix(col, hor.mul(0.5), below).mul(U.sunIntensity.mul(0.8).add(0.2));
}

// Colour of water in a given view direction, as seen from `depth` metres below the surface.
export function underwaterColor(dir, depth = U.camDepth) {
  const up = smoothstep(-0.8, 0.95, dir.y);
  const base = mix(U.deep, mix(U.mid, U.shallow, smoothstep(0.2, 1.0, dir.y)), up);
  const sunGlow = pow(max(dot(dir, U.sunDir), 0), 10).mul(0.7);
  return base.add(U.shallow.mul(U.sunColor).mul(sunGlow)).mul(exp(depth.mul(-0.03))).mul(U.sunIntensity.mul(0.85).add(0.15));
}

// Scene-wide fog: clear turquoise water fog below the surface, a light haze above.
export function setupFog(scene) {
  const toFrag = positionWorld.sub(cameraPosition);
  const dist = toFrag.length();
  const dir = normalize(toFrag);
  const fragDepth = max(float(WATER_Y).sub(positionWorld.y), 0);
  const fogCol = mix(
    skyColor(vec3(dir.x, max(dir.y, 0.02), dir.z).normalize(), false),
    underwaterColor(dir, mix(U.camDepth, fragDepth, 0.5)),
    U.under,
  );
  const underFactor = float(1).sub(exp(dist.mul(U.fogDensity).negate()));
  const airFactor = float(1).sub(exp(dist.mul(-0.00022)));
  scene.fogNode = fog(fogCol, mix(airFactor, underFactor, U.under));
}

// ---------------------------------------------------------------------------------------------
// Underwater image-based light (equirect, linear HDR): bright surface above, turquoise walls,
// sandy bounce below. Gives silver fish and wet rock real reflections.
// ---------------------------------------------------------------------------------------------
export function createUnderwaterEnv() {
  const W = 256, H = 128;
  const data = new Float32Array(W * H * 4);
  const c = (hex) => new THREE.Color(hex);
  const top = c(0xb8f4ff).multiplyScalar(1.3), hi = c(0x2aa8c0).multiplyScalar(0.5), hor = c(0x0a4a5e).multiplyScalar(0.3);
  const low = c(0x042432).multiplyScalar(0.2), sand = c(0x6a664e).multiplyScalar(0.2);
  const tmp = new THREE.Color();
  for (let y = 0; y < H; y++) {
    const v = 1 - (y + 0.5) / H; // 1 = up
    const e = v * 2 - 1;
    for (let x = 0; x < W; x++) {
      if (e > 0.6) tmp.copy(hi).lerp(top, THREE.MathUtils.smoothstep(e, 0.6, 1));
      else if (e > 0) tmp.copy(hor).lerp(hi, THREE.MathUtils.smoothstep(e, 0, 0.6));
      else if (e > -0.5) tmp.copy(low).lerp(hor, THREE.MathUtils.smoothstep(e, -0.5, 0));
      else tmp.copy(sand).lerp(low, THREE.MathUtils.smoothstep(e, -1, -0.5));
      const i = (y * W + x) * 4;
      data[i] = tmp.r; data[i + 1] = tmp.g; data[i + 2] = tmp.b; data[i + 3] = 1;
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}
