import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, pass, uniform, float, vec2, vec3, vec4, screenUV, screenCoordinate, sin, cos, fract, dot, exp, max, min,
  length, normalize, smoothstep, texture, getViewPosition, renderOutput, mix, pow, hash, uint, clamp, saturate, step, abs,
} from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';

import { U, WATER_Y, causticTex, setupFog, createUnderwaterEnv } from './shared.js';
import { createOcean, createSky, createSeabed, seabedHeight, waveHeightCPU, oceanU } from './ocean.js';
import { createLoader, bakeModel, canonicalize, guessAxes, toNodeMaterial, convertMaterials, simplifyGeometry } from './models.js';
import { FishSwarm } from './swarm.js';
import { createFlexingWhale, createAnimated, SwimPath, scatterInstanced, Hunter } from './creatures.js';
import { Splash, createMarineSnow, createBubbles } from './particles.js';
import { createJellyBloom } from './jellies.js';
import { createSeagrass } from './vegetation.js';
import { Director } from './director.js';
import { Story, flightTargets } from './story.js';
import { Timeline } from './timeline.js';
import { Layers } from './layers.js';
import { createWaterTentacles } from './tentacles.js';
import { BASE, IS_BUILD, PAGE, PROJECT } from './project.js';
import { DataHub } from './data.js';

// Per-model orientation overrides (flip = the artist's pivot/forward axis points the wrong way).
const CONFIG = {
  tuna: { max: 4096, count: 2000, flip: false },
  reef: { max: 2048, count: 600, flip: true }, // head detected at the tail end
  humpback: { flip: true },
  bluewhale: { flip: true, yaw: 0 },
  shark: { flip: false, yaw: 0 },
  turtle: { flip: false, yaw: Math.PI / 2 }, // flipper span is wider than the shell is long
};

// radius (m) of the play area around the reef; everything is kept inside it
const STAGE = 42;

// three r180 bug: a viewport (refraction) copy texture used inside a render target is a clone that
// shares its `image` with the original, so after a resize one of them sees the new size already set,
// never flags an update, and keeps its old GPU texture. Once the canvas is wider/taller than at load
// the copy is out of bounds and every frame is dropped (black screen after a resize or fullscreen,
// and in the editor viewport). Track each copy texture's size ourselves and force a reallocation.
const vtUpdateBefore = THREE.ViewportTextureNode.prototype.updateBefore;
const vtSize = new THREE.Vector2(), vtAllocated = new WeakMap();
THREE.ViewportTextureNode.prototype.updateBefore = function (frame) {
  const rt = frame.renderer.getRenderTarget();
  if (rt) vtSize.set(rt.width, rt.height); else frame.renderer.getDrawingBufferSize(vtSize);
  const tex = this.getTextureForReference(rt), key = `${vtSize.x}x${vtSize.y}`;
  if (vtAllocated.has(tex) && vtAllocated.get(tex) !== key) tex.needsUpdate = true;
  vtAllocated.set(tex, key);
  return vtUpdateBefore.call(this, frame);
};

const $ = (id) => document.getElementById(id);
const loaderEl = $('loader'), statusEl = $('status'), barEl = $('bar');
function fail(msg) { loaderEl.classList.add('error'); statusEl.textContent = msg; throw new Error(msg); }

async function main() {
  const params = new URLSearchParams(location.search);
  const LAB = !IS_BUILD && PAGE === 'play' && params.has('lab'); // playground panel + shot director instead of a story
  const EDIT = !IS_BUILD && PAGE === 'editor'; // editor.html: the timeline editor around the project (src/editor/)
  // the studio's pages need a project (?project=demo/thai-union | <slug>); without one, go to the studio home
  if (!IS_BUILD && !LAB && !PROJECT) { location.replace('./'); return; }
  let editor = null;
  document.documentElement.classList.add(LAB ? 'lab' : EDIT ? 'edit' : 'story');

  // ------------------------------------------------------------------ WebGPU only
  if (!navigator.gpu) fail('WebGPU is not available in this browser.\nUse a current Chrome / Edge (or Safari 26+, Firefox 141+ on Windows).');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) fail('No WebGPU adapter found. Check that hardware acceleration is enabled.');

  const renderer = new THREE.WebGPURenderer({ antialias: false, powerPreference: 'high-performance', forceWebGL: false });
  await renderer.init();
  if (!renderer.backend.isWebGPUBackend) fail('WebGPU backend failed to initialise (refusing WebGL fallback).');
  // resolution: device pixel ratio capped (retina at 2x was the main cost), then auto-scaled by fps
  const MAX_PR = Math.min(devicePixelRatio, 1.5);
  const AUTO = !params.has('noauto');
  let autoScale = 1;
  renderer.setPixelRatio(MAX_PR);
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  scene.environment = createUnderwaterEnv();
  scene.environmentIntensity = 0.7;
  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.2, 9000);
  camera.position.set(26, -10, 44);

  setupFog(scene);

  // ------------------------------------------------------------------ lights
  const sun = new THREE.DirectionalLight(0xffffff, 2.6);
  sun.castShadow = LAB; // story mode: no shadow pass (the tuna would be drawn twice); never toggle at runtime
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -80, right: 80, top: 80, bottom: -80, near: 1, far: 400 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.06;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0x8fe6f0, 0x2a3a30, 0.5);
  scene.add(hemi);

  // ------------------------------------------------------------------ procedural world
  const sky = createSky(), ocean = createOcean(), seabed = createSeabed();
  scene.add(sky, ocean, seabed);

  // ------------------------------------------------------------------ assets
  const manager = new THREE.LoadingManager();
  manager.onProgress = (url, done, total) => { barEl.style.width = `${(done / total) * 100}%`; statusEl.textContent = `Loading ${url.split('/').pop()}  (${done}/${total})`; };
  const loader = createLoader(manager);
  const files = {
    tuna: 'tuna_fish.glb', reef: 'coral_fish.glb', coral: 'coral_piece.glb', shark: 'model_54a_-_caribbean_reef_shark.glb',
    turtle: 'model_50a_-_hawksbill_sea_turtle.glb', blue: 'blue_whale_-_textured.glb', hump: 'game-ready_humpback_whale.glb',
  };
  // story.json as raw text (the editor fingerprints exactly what's on disk to detect outside changes)
  const storyText = LAB ? null : fetch(`./${BASE}story.json`, { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error(`story.json: HTTP ${r.status}`); return r.text(); });
  const G = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([k, f]) => [k, await loader.loadAsync(`./models/${f}`)])));
  const storyRaw = LAB ? null : await storyText;
  const timeline = LAB ? null : new Timeline(JSON.parse(storyRaw));
  if (timeline) timeline.sourceText = storyRaw;
  // live data (APIs / CMS) for {{bindings}} in layers and captions; re-synced when the story's sources change
  const data = new DataHub();
  let dataVersion = -1;
  const syncData = () => { if (timeline && timeline.version !== dataVersion) { dataVersion = timeline.version; data.sync(timeline.data.sources ?? []); } };
  syncData();
  statusEl.textContent = 'Preparing scene…';
  await new Promise((r) => setTimeout(r, 0));

  const floorY = seabedHeight(0, 0);
  const reefTop = floorY + 5;

  // --- tuna: bind pose baked, oriented from bones, one instanced draw call, can breach
  const tunaRoot = G.tuna.scene;
  tunaRoot.updateMatrixWorld(true);
  const bone = (...names) => { for (const n of names) { let f = null; tunaRoot.traverse((o) => { if (!f && o.isBone && o.name.startsWith(n)) f = o; }); if (f) return f; } return null; };
  const wpos = (b) => b.getWorldPosition(new THREE.Vector3());
  const tunaBaked = bakeModel(tunaRoot);
  let fwd, up;
  const head = bone('Head_'), tail = bone('UpperTail_', 'Spine.008', 'LowerTail_'), fin = bone('UpperFin_011', 'UpperFin'), spine = bone('Spine.002', 'Spine_');
  if (head && tail) {
    fwd = wpos(head).sub(wpos(tail));
    up = fin && spine ? wpos(fin).sub(wpos(spine)) : new THREE.Vector3(0, 1, 0);
  } else ({ forward: fwd, up } = guessAxes(tunaBaked.geometry));
  if (CONFIG.tuna.flip) fwd.negate();
  canonicalize(tunaBaked.geometry, fwd, up);
  if (!LAB) await simplifyGeometry(tunaBaked.geometry, 0.35); // 6k -> ~2k tris: 2000 tuna were ~12M tris
  const schoolY = -7;
  const tentacles = createWaterTentacles(); // the water 50 (story only); also defines the 0's hole
  const tuna = new FishSwarm({
    geometry: tunaBaked.geometry,
    materials: tunaBaked.materials.map((m) => toNodeMaterial(m, LAB ? { physical: true, iridescence: 0.55, clearcoat: 0.5, rim: 0.9, rimColor: new THREE.Color(0.35, 0.8, 0.9) } : { rim: 0.9, rimColor: new THREE.Color(0.35, 0.8, 0.9) })),
    maxCount: CONFIG.tuna.max, count: CONFIG.tuna.count,
    center: new THREE.Vector3(0, schoolY, 0), half: new THREE.Vector3(STAGE, 8, STAGE),
    size: [1.5, 2.3], speed: [3.2, 7.5], neighbour: 7, separation: 2.1,
    swim: { amp: 0.09, waveK: 3.0, freq: 1.5, base: 5.5 },
    weights: { sep: 5, ali: 1.6, coh: 0.8, goal: 1.3, bound: 7, pred: 55, ray: 40 }, seed: 1, jumpers: 256,
    targets: flightTargets(tentacles.userData, CONFIG.tuna.max),
  });
  tuna.u.floorY.value = reefTop + 2;
  tuna.u.ceilY.value = -0.9;
  // school footprint grows with the head-count so dense schools don't crush together
  const fitSchool = (n) => { const r = THREE.MathUtils.clamp(6 + Math.sqrt(n) * 0.38, 10, 30); tuna.u.goalSpread.value.set(r, 3, r); tuna.u.jumpRadius.value = Math.min(r, 14); };
  fitSchool(CONFIG.tuna.count);
  scene.add(tuna.mesh);
  const splash = new Splash(tuna, 110);
  scene.add(splash.mesh);

  // --- reef fish: static mesh, same GPU swarm system, smaller & twitchier
  const reefBaked = bakeModel(G.reef.scene);
  const ra = guessAxes(reefBaked.geometry, CONFIG.reef.flip);
  canonicalize(reefBaked.geometry, ra.forward, ra.up);
  const reef = new FishSwarm({
    geometry: reefBaked.geometry,
    materials: reefBaked.materials.map((m) => toNodeMaterial(m, { rim: 0.6 })),
    maxCount: CONFIG.reef.max, count: CONFIG.reef.count,
    center: new THREE.Vector3(0, reefTop - 1, 0), half: new THREE.Vector3(30, 5, 30),
    size: [0.2, 0.34], speed: [0.8, 2.6], neighbour: 2.2, separation: 0.45,
    swim: { amp: 0.14, waveK: 3.6, freq: 3.5, base: 8 },
    weights: { sep: 4, ali: 1.2, coh: 1.1, goal: 0.5, bound: 2, pred: 25, ray: 25 }, seed: 9,
  });
  reef.u.floorY.value = floorY + 1.2;
  reef.u.ceilY.value = reefTop + 6;
  reef.u.goalSpread.value.set(18, 2, 18);
  scene.add(reef.mesh);

  // --- jellyfish: a procedural bioluminescent bloom + a few photoreal hero jellies
  const bloomClusters = [
    new THREE.Vector4(-32, -8, 22, 16), new THREE.Vector4(34, -10, -16, 18), new THREE.Vector4(6, -6, -38, 14), new THREE.Vector4(-14, -7, -10, 34),
  ];
  const jellies = createJellyBloom({ count: 520, clusters: bloomClusters });
  scene.add(jellies);

  // --- whales
  const whaleStyle = { rim: 0.6, physical: true, clearcoat: 0.35 };
  const hump = createFlexingWhale(G.hump, { length: 14, flip: CONFIG.humpback.flip, amp: 0.045, speed: 0.8, style: whaleStyle });
  const humpPath = new SwimPath({ rx: 44, rz: 34, y: -6, yAmp: 1.5, speed: 3, phase: 1 });
  scene.add(hump);
  const blue = createAnimated(G.blue, { length: 26, flip: CONFIG.bluewhale.flip, yaw: CONFIG.bluewhale.yaw, timeScale: 0.6, style: whaleStyle });
  const bluePath = new SwimPath({ rx: 62, rz: 50, y: -14, yAmp: 2, speed: 3.6, phase: 3.5, dir: -1 });
  scene.add(blue);

  // --- sharks hunt the tuna school; turtles cruise the reef
  const schoolCenter = new THREE.Vector3();
  const sharks = [0, 1].map((i) => {
    const s = createAnimated(G.shark, { length: 3.4, flip: CONFIG.shark.flip, yaw: CONFIG.shark.yaw, clone: true, timeScale: 1.1, style: { rim: 0.7, physical: true, clearcoat: 0.3 } });
    scene.add(s);
    return new Hunter(s, { getPrey: () => schoolCenter, floorY: reefTop, seed: i, leash: STAGE });
  });
  const turtles = [0, 1].map((i) => {
    const t = createAnimated(G.turtle, { length: 1.3, flip: CONFIG.turtle.flip, yaw: CONFIG.turtle.yaw, clone: true, timeScale: 0.8, style: { rim: 0.6 } });
    scene.add(t);
    return { obj: t, path: new SwimPath({ center: new THREE.Vector3(i ? 15 : -10, 0, i ? -8 : 12), rx: 18, rz: 24, y: reefTop + 2 + i * 3, yAmp: 1.5, speed: 1.3, phase: i * 2 }) };
  });
  const animated = [blue, ...sharks.map((s) => s.obj), ...turtles.map((t) => t.obj)];

  // --- decoration: instanced coral, seagrass meadows, the photogrammetry soft coral
  const corals = scatterInstanced(G.coral, {
    count: 160, size: [2, 6],
    placer: (p) => { const a = Math.random() * Math.PI * 2, r = 14 + Math.random() * 70; p.set(Math.cos(a) * r, 0, Math.sin(a) * r); p.y = seabedHeight(p.x, p.z) - 0.3; },
  });
  scene.add(corals);
  const seagrass = createSeagrass({ count: LAB ? 30000 : 14000, heightAt: seabedHeight });
  scene.add(seagrass);

  // --- the water 50 (story only)
  tentacles.visible = false;
  if (!LAB) scene.add(tentacles);

  // --- particles
  const snow = createMarineSnow(LAB ? 26000 : 16000, 46);
  scene.add(snow);
  const vents = [];
  for (let k = 0; k < 14; k++) {
    const a = Math.random() * Math.PI * 2, r = 12 + Math.random() * 35;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    vents.push(new THREE.Vector3(x, seabedHeight(x, z) + 0.2, z));
  }
  const bubbles = createBubbles(vents, 200);
  scene.add(bubbles);

  // ------------------------------------------------------------------ post-processing
  const post = new THREE.PostProcessing(renderer);
  post.outputColorTransform = false;
  const scenePass = pass(scene, camera);
  const sceneColor = scenePass.getTextureNode('output');
  const sceneDepth = scenePass.getTextureNode('depth');
  const uCamWorld = uniform(new THREE.Matrix4()), uProjInv = uniform(new THREE.Matrix4()), uCamPos = uniform(new THREE.Vector3());
  const uFade = uniform(1), uLetterbox = uniform(0), uGodK = uniform(0.34);

  // Volumetric light shafts: march the view ray through the water, projecting each sample up the
  // sun direction onto the (blurred) caustic pattern. Occlusion comes from the scene depth.
  const godRays = Fn(() => {
    const res = vec3(0).toVar();
    If(U.under.greaterThan(0.5), () => {
      const vp = getViewPosition(screenUV, sceneDepth.x, uProjInv);
      const wp = uCamWorld.mul(vec4(vp, 1)).xyz;
      const toP = wp.sub(uCamPos);
      const rd = normalize(toP);
      const maxT = min(length(toP), 90);
      const STEPS = 28;
      const stepLen = maxT.div(STEPS);
      const jitter = fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715)).mul(52.9829189).fract().add(U.time.mul(0.61803)));
      const acc = float(0).toVar();
      Loop(STEPS, ({ i }) => {
        const t = float(i).add(jitter).mul(stepLen);
        const p = uCamPos.add(rd.mul(t));
        const depth = max(float(WATER_Y).sub(p.y), 0);
        const proj = p.xz.add(U.sunDir.xz.mul(depth.div(max(U.sunDir.y, 0.2))));
        const pat = texture(causticTex, proj.mul(0.03).add(vec2(U.time.mul(0.004), U.time.mul(0.003)))).level(4).r;
        const pat2 = texture(causticTex, proj.mul(0.017).add(vec2(U.time.mul(-0.003), U.time.mul(0.002)))).level(5).r;
        const shaft = pow(pat.mul(pat2).mul(4), 1.6);
        acc.addAssign(shaft.mul(exp(t.mul(-0.025))).mul(exp(depth.mul(-0.04))).mul(smoothstep(0.0, 0.5, depth)));
      });
      const phase = pow(max(dot(rd, U.sunDir), 0), 3).mul(1.6).add(0.3);
      res.assign(mix(U.shallow, vec3(0.75, 1.0, 0.95), 0.35).mul(U.sunColor).mul(acc).mul(stepLen).mul(phase).mul(U.sunIntensity).mul(uGodK));
    });
    return res;
  });

  // Sky god rays (above water): radial blur of the bright sky/sun toward the sun's screen position.
  // Fish and the sea write depth and occlude; the water 50 doesn't, so light streams through it.
  const uSunUV = uniform(new THREE.Vector2(0.5, 0.2)), uSunVis = uniform(0), uSkyRayK = uniform(0.6);
  const skyRays = Fn(() => {
    const res = vec3(0).toVar();
    If(U.under.lessThan(0.5).and(uSunVis.greaterThan(0.001)), () => {
      const N = 24;
      const delta = uSunUV.sub(screenUV).div(N);
      const jitter = fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715)).mul(52.9829189));
      const suv = screenUV.add(delta.mul(jitter)).toVar();
      const acc = vec3(0).toVar(), w = float(1).toVar();
      Loop(N, () => {
        suv.addAssign(delta);
        const c = min(sceneColor.sample(suv).rgb, vec3(2.5));
        const open = step(0.99999, sceneDepth.sample(suv).x);
        const lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
        acc.addAssign(c.mul(smoothstep(0.9, 2.2, lum).mul(open)).mul(w));
        w.mulAssign(0.965);
      });
      res.assign(acc.div(N).mul(uSunVis).mul(uSkyRayK).mul(vec3(1.0, 0.8, 0.5)));
    });
    return res;
  });

  // Colour grade in display space: teal shadows / warm highlights underwater, a clean warm
  // tropical grade above; filmic contrast, saturation, vignette.
  const grade = Fn(([c]) => {
    const lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    // gentle black point for richer depth
    const shadowTint = mix(vec3(0.0, 0.035, 0.05), vec3(0.01, 0.02, 0.035), float(1).sub(U.under));
    const hiTint = mix(vec3(1.03, 1.0, 0.95), vec3(1.0, 1.02, 0.98), U.under);
    let g = c.mul(hiTint).add(shadowTint.mul(pow(float(1).sub(lum), 3)));
    g = mix(vec3(lum), g, mix(1.12, 1.18, U.under));
    const s = g.mul(g).mul(float(3).sub(g.mul(2)));
    g = mix(g, s, 0.28);
    const v = float(1).sub(smoothstep(0.3, 0.95, length(screenUV.sub(0.5).mul(vec2(1.2, 1)))).mul(mix(0.28, 0.5, U.under)));
    return saturate(g.mul(v));
  });

  const opts = { godRays: true, bloom: true };
  let bloomNode = null, bloomStrength = 0.28;
  function buildPost() {
    const wob = vec2(sin(screenUV.y.mul(38).add(U.time.mul(2.1))), cos(screenUV.x.mul(31).add(U.time.mul(1.6)))).mul(0.0009).mul(U.under);
    const dc = screenUV.sub(0.5);
    const caK = mix(0.0012, 0.0035, U.under);
    const suv = screenUV.add(wob);
    let col = vec3(sceneColor.sample(suv.add(dc.mul(caK))).r, sceneColor.sample(suv).g, sceneColor.sample(suv.sub(dc.mul(caK))).b);
    if (opts.godRays) col = col.add(godRays()).add(skyRays());
    bloomNode = opts.bloom ? bloom(vec4(col, 1), bloomStrength, 0.45, 0.9) : null;
    if (bloomNode) col = col.add(bloomNode.rgb);
    const mapped = renderOutput(vec4(col, 1));
    const aa = fxaa(vec4(grade(mapped.rgb), 1));
    const grain = hash(uint(screenCoordinate.x).add(uint(screenCoordinate.y).mul(uint(4099))).add(uint(fract(U.time.mul(0.37)).mul(99991)))).sub(0.5).mul(0.018);
    const lb = step(uLetterbox, screenUV.y).mul(step(uLetterbox, float(1).sub(screenUV.y)));
    post.outputNode = vec4(aa.rgb.add(grain).mul(uFade).mul(lb), 1);
    post.needsUpdate = true;
  }
  buildPost();

  // ------------------------------------------------------------------ controls & interaction
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.maxDistance = 140;
  controls.target.set(0, schoolY, 0);

  const keys = new Set();
  const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  addEventListener('keydown', (e) => { if (!typing(e) && !e.ctrlKey && !e.metaKey) { keys.add(e.code); if (/Key[WASDQE]/.test(e.code)) director.stop(); } });
  addEventListener('keyup', (e) => keys.delete(e.code));

  const pointer = new THREE.Vector2(9, 9);
  let pointerIn = false;
  addEventListener('pointermove', (e) => {
    const r = renderer.domElement.getBoundingClientRect();
    pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    pointerIn = !EDIT || e.target === renderer.domElement; // editor: only over the viewport
  });
  document.addEventListener('pointerleave', () => { pointerIn = false; });
  renderer.domElement.addEventListener('pointerdown', () => director.stop());
  renderer.domElement.addEventListener('wheel', () => director.stop(), { passive: true });
  const raycaster = new THREE.Raycaster();

  // school choreography: long cycle between mid-water and the surface
  const school = { forceSurface: 0, jumpBoost: 0 };
  function schoolGoal(t, out) {
    const surf = Math.max(school.forceSurface, THREE.MathUtils.smoothstep(Math.sin(t * 0.07), 0.1, 0.6));
    const y = THREE.MathUtils.lerp(-10 + Math.sin(t * 0.11) * 2, -2.6, surf);
    return out.set(Math.cos(t * 0.045) * 16, y, Math.sin(t * 0.063) * 14);
  }

  // breach auto-framing: read back the 64-entry breach state (1 KB) a few times per second
  const breachFocus = new THREE.Vector3(), breachTarget = new THREE.Vector3();
  let breachBusy = false;
  setInterval(async () => {
    if (breachBusy || !director.active) return;
    breachBusy = true;
    try {
      const S = new Float32Array(await renderer.getArrayBufferAsync(tuna.state.value));
      // bias toward the most recent breach, anchored on the school centre
      let best = -1, bt = -1e9;
      for (let i = 0; i < S.length; i += 4) if (S[i + 3] > bt) { bt = S[i + 3]; best = i; }
      const g = tuna.u.goal.value;
      if (best >= 0 && t - bt < 3) breachTarget.set((S[best + 1] + g.x) / 2, g.y, (S[best + 2] + g.z) / 2);
      else breachTarget.set(g.x, g.y, g.z);
    } finally { breachBusy = false; }
  }, 250);

  // ------------------------------------------------------------------ cinematic director
  const director = new Director({
    camera, controls, uFade, uLetterbox, school, tuna, breachFocus, sharks, blue, hump, turtles, bloomClusters, reefTop,
    onChange: (on) => { $('cine').classList.toggle('on', on); $('cine').textContent = on ? 'Cinematic ● ON' : 'Cinematic'; },
  });

  // how much the tuna react to the cursor / predators (story parameters; lab mode: full)
  const fishReact = { cursor: 1, predators: 1 };
  // story parameters a timeline curve can animate (see PARAMS in story.js)
  const applyParam = {
    sun: (deg, az) => setSun(deg, az),
    'post.exposure': (v) => { renderer.toneMappingExposure = v; },
    'post.bloom': (v) => { bloomStrength = v; if (bloomNode) bloomNode.strength.value = v; },
    'post.skyRays': (v) => { uSkyRayK.value = v; },
    'post.underRays': (v) => { uGodK.value = v; },
    'sea.state': (v) => { oceanU.amp.value = v; oceanU.chopAmp.value = Math.min(v, 1.1); },
    'water.clarity': (v) => { U.fogDensity.value = THREE.MathUtils.lerp(0.03, 0.006, v); },
    'school.cursor': (v) => { fishReact.cursor = v; },
    'school.predators': (v) => { fishReact.predators = v; },
  };
  // what story path tracks can steer, with their own behaviour to hand back to and a natural top speed (m/s)
  const actors = {
    bluewhale: { obj: blue, swim: bluePath, speed: 5 }, humpback: { obj: hump, swim: humpPath, speed: 4.5 },
    shark1: { obj: sharks[0].obj, hunter: sharks[0], speed: 9 }, shark2: { obj: sharks[1].obj, hunter: sharks[1], speed: 9 },
    turtle1: { obj: turtles[0].obj, swim: turtles[0].path, speed: 2.2 }, turtle2: { obj: turtles[1].obj, swim: turtles[1].path, speed: 2.2 },
  };
  const story = LAB ? null : new Story({ tuna, tentacles, timeline, apply: applyParam, captionLayer: $('captions'), actors, data });
  const layers = story ? new Layers({ timeline, root: $('captions'), scene, data }) : null; // images / video / HTML / iframes
  // page length grows with the story (meta.scrollPerSecond vh per second of story)
  // (realDuration: stretch regions repeated once per CMS item make the site longer than the story)
  let scrollFor = -1;
  const fitScroll = () => {
    if (!story) return;
    const d = timeline.realDuration ?? timeline.duration;
    if (d === scrollFor) return;
    scrollFor = d;
    $('scrollspace').style.height = `${Math.round(d * timeline.meta.scrollPerSecond)}vh`;
  };
  fitScroll();

  let camTween = null;
  const presets = {
    reef: () => [new THREE.Vector3(30, reefTop + 4, 38), new THREE.Vector3(0, reefTop - 2, 0)],
    school: () => [tuna.u.goal.value.clone().add(new THREE.Vector3(18, 3, 18)), tuna.u.goal.value.clone()],
    surface: () => [new THREE.Vector3(tuna.u.goal.value.x + 20, -2.2, tuna.u.goal.value.z + 20), new THREE.Vector3(tuna.u.goal.value.x, 1.5, tuna.u.goal.value.z)],
    aerial: () => [new THREE.Vector3(tuna.u.goal.value.x + 40, 12, tuna.u.goal.value.z + 50), new THREE.Vector3(tuna.u.goal.value.x, 0, tuna.u.goal.value.z)],
  };
  document.querySelectorAll('[data-cam]').forEach((b) => b.addEventListener('click', () => {
    director.stop();
    const [p, t] = presets[b.dataset.cam]();
    camTween = { p0: camera.position.clone(), t0: controls.target.clone(), p, t, k: 0 };
  }));
  $('cine').addEventListener('click', () => (director.active ? director.stop() : director.start()));
  $('breach').addEventListener('click', () => { school.jumpBoost = 6; school.forceSurface = 1; setTimeout(() => { school.forceSurface = 0; }, 9000); });

  // ------------------------------------------------------------------ UI
  let renderScale = 1;
  const ui = {
    tuna: [$('tuna'), $('vTuna'), CONFIG.tuna.count, (v) => { tuna.setCount(v); fitSchool(v); }, (v) => v],
    reef: [$('reef'), $('vReef'), LAB ? CONFIG.reef.count : 400, (v) => reef.setCount(v), (v) => v],
    jelly: [$('jelly'), $('vJelly'), LAB ? 360 : 220, (v) => { jellies.count = v; }, (v) => v],
    sea: [$('sea'), $('vSea'), 0.45, (v) => { oceanU.amp.value = v; oceanU.chopAmp.value = Math.min(v, 1.1); }, (v) => v.toFixed(2)],
    clarity: [$('clarity'), $('vClarity'), 0.7, (v) => { U.fogDensity.value = THREE.MathUtils.lerp(0.03, 0.006, v); }, (v) => `${Math.round(v * 100)}%`],
    sun: [$('sun'), $('vSun'), 55, (v) => setSun(v), (v) => `${v}°`],
    scale: [$('scale'), $('vScale'), 1, (v) => { renderScale = v; onResize(); }, (v) => `${Math.round(v * 100)}%`],
  };
  for (const [el, label, init, apply, fmt] of Object.values(ui)) {
    el.value = init; label.textContent = fmt(+init); apply(+init);
    el.addEventListener('input', () => { apply(+el.value); label.textContent = fmt(+el.value); });
  }
  $('godrays').addEventListener('change', (e) => { opts.godRays = e.target.checked; buildPost(); });
  $('bloom').addEventListener('change', (e) => { opts.bloom = e.target.checked; buildPost(); });
  // toggling castShadow at runtime invalidates the shadow node; fade + freeze the map instead
  $('shadows').addEventListener('change', (e) => { sun.shadow.intensity = e.target.checked ? 1 : 0; sun.shadow.autoUpdate = e.target.checked; sun.shadow.needsUpdate = true; });
  $('panelHead').addEventListener('click', () => $('panel').classList.toggle('collapsed'));
  const setTunaCount = (n) => { tuna.setCount(n); fitSchool(n); };
  if (timeline?.data.settings.tunaCount) setTunaCount(timeline.data.settings.tunaCount);

  function setSun(deg, az = 0.9) {
    const el = THREE.MathUtils.degToRad(deg);
    U.sunDir.value.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();
    const warm = 1 - THREE.MathUtils.smoothstep(Math.sin(el), 0.05, 0.5);
    U.sunColor.value.setRGB(1, THREE.MathUtils.lerp(0.96, 0.62, warm), THREE.MathUtils.lerp(0.9, 0.38, warm));
    U.sunIntensity.value = THREE.MathUtils.lerp(0.35, 1, THREE.MathUtils.smoothstep(Math.sin(el), 0.02, 0.45));
    sun.color.copy(U.sunColor.value);
    sun.intensity = 2.8 * U.sunIntensity.value;
    hemi.intensity = 0.15 + 0.4 * U.sunIntensity.value;
    scene.environmentIntensity = 0.2 + 0.5 * U.sunIntensity.value;
    jellies.userData.glow.value = THREE.MathUtils.lerp(2.2, 1, U.sunIntensity.value);
  }

  // render size = the window, or the editor's viewport
  function onResize() {
    const { w, h } = editor ? editor.viewSize() : { w: innerWidth, h: innerHeight };
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (story) { story.cam.aspect = w / h; story.cam.updateProjectionMatrix(); }
    renderer.setPixelRatio(MAX_PR * renderScale * autoScale);
    renderer.setSize(w, h);
  }
  addEventListener('resize', onResize);

  // editor hooks: hidden objects (outliner), simulation speed, one-shot frame capture
  const hidden = new Set();
  let timeScale = 1, captureCb = null, frameHook = null;
  const fpsInfo = { fps: 60, res: 1 };

  window.__ocean = { camera, controls, tuna, reef, hump, blue, sharks, turtles, presets, director, school, renderer, scene, seagrass, snow, bubbles, jellies, splash, sun, opts, buildPost, story, tentacles, timeline, layers, data };

  if (EDIT) {
    const { Editor } = await import('./editor/editor.js');
    editor = new Editor({
      renderer, scene, camera, controls, story, timeline, layers, data, tuna, opts, buildPost, onResize, hidden, fpsInfo, setTunaCount,
      objects: [
        { group: 'World', name: 'Sky', obj: sky }, { group: 'World', name: 'Ocean surface', obj: ocean }, { group: 'World', name: 'Seabed', obj: seabed },
        { group: 'World', name: 'Corals', obj: corals }, { group: 'World', name: 'Seagrass', obj: seagrass },
        { group: 'Life', name: 'Tuna school', obj: tuna.mesh }, { group: 'Life', name: 'Reef fish', obj: reef.mesh },
        { group: 'Life', name: 'Sharks', obj: sharks.map((s) => s.obj) }, { group: 'Life', name: 'Turtles', obj: turtles.map((tt) => tt.obj) },
        { group: 'Life', name: 'Blue whale', obj: blue }, { group: 'Life', name: 'Humpback', obj: hump }, { group: 'Life', name: 'Jellyfish', obj: jellies },
        { group: 'Water 50', name: 'Water tentacles', obj: tentacles },
        { group: 'Particles', name: 'Splashes', obj: splash.mesh }, { group: 'Particles', name: 'Marine snow', obj: snow }, { group: 'Particles', name: 'Bubbles', obj: bubbles },
      ],
      setTimeScale: (v) => { timeScale = v; },
      capture: () => new Promise((res) => { captureCb = res; }),
      onFrame: (fn) => { frameHook = fn; }, // called right after each frame is rendered (the review-video recorder)
    });
    window.__ocean.editor = editor;
    onResize();
  }

  // ?debug: velocity arrows (true travel direction) to verify each model faces forward
  const debug = params.has('debug');
  const arrows = [];
  if (debug) {
    for (const o of [...sharks.map((s) => s.obj), ...turtles.map((t) => t.obj), blue, hump]) {
      const a = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 4, 0xff2060, 1, 0.5);
      o.add(a);
    }
    var rArrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 0.8, 0xffee00, 0.2, 0.1); scene.add(rArrow);
    for (let k = 0; k < 6; k++) { const a = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 5, 0xffee00, 1.2, 0.6); scene.add(a); arrows.push(a); }
    setInterval(async () => {
      const P = new Float32Array(await renderer.getArrayBufferAsync(tuna.pos.value));
      const Vv = new Float32Array(await renderer.getArrayBufferAsync(tuna.vel.value));
      arrows.forEach((a, k) => {
        const i = 100 + k * 50;
        a.position.set(P[i * 4], P[i * 4 + 1], P[i * 4 + 2]);
        a.setDirection(new THREE.Vector3(Vv[i * 4], Vv[i * 4 + 1], Vv[i * 4 + 2]).normalize());
      });
      window.__tunaDbg = arrows.map((a) => a.position.toArray());
      const RP = new Float32Array(await renderer.getArrayBufferAsync(reef.pos.value));
      const RV = new Float32Array(await renderer.getArrayBufferAsync(reef.vel.value));
      rArrow.position.set(RP[40], RP[41], RP[42]);
      rArrow.setDirection(new THREE.Vector3(RV[40], RV[41], RV[42]).normalize());
      window.__reefDbg = [rArrow.position.toArray(), [RV[40], RV[41], RV[42]]];
    }, 100);
  }

  // ------------------------------------------------------------------ warm-up
  statusEl.textContent = 'Compiling shaders…';
  // compile the (still invisible) story water too, or it hitches the moment it appears
  tentacles.visible = true;
  // ... and the GPU layers (their shaders differ per effect set), once their images are in
  if (layers) { layers.sync(); await layers.ready(3000); layers.group.children.forEach((m) => { m.visible = true; }); }
  await renderer.compileAsync(scene, camera);
  tentacles.visible = false;
  if (layers) layers.group.children.forEach((m) => { m.visible = false; });
  loaderEl.classList.add('hidden');
  if (LAB && !params.has('free')) director.start();
  // ?t=42 (seconds) or ?p=0.7 (progress) opens the story at that point (the editor's "Open site" links here)
  if (story && !EDIT && (params.has('t') || params.has('p'))) {
    const p0 = THREE.MathUtils.clamp(params.has('t') ? (+params.get('t') || 0) / timeline.realDuration : +params.get('p') || 0, 0, 1);
    story.p = p0;
    scrollTo(0, p0 * (document.documentElement.scrollHeight - innerHeight));
  }

  // dynamic resolution: drop 15% after ~1 s under 45 fps, creep back up after ~3 s above 58 fps
  let slow = 0, fast = 0, samples = 0;
  function adaptResolution(fps) {
    if (!AUTO || ++samples < 6) return;
    if (fps < 45) { slow++; fast = 0; } else if (fps > 58) { fast++; slow = 0; } else slow = fast = 0;
    if (slow >= 2 && autoScale > 0.5) { autoScale = Math.max(0.5, autoScale * 0.85); slow = 0; onResize(); }
    if (fast >= 6 && autoScale < 1) { autoScale = Math.min(1, autoScale * 1.08); fast = 0; onResize(); }
  }

  // ------------------------------------------------------------------ loop
  let last = performance.now(), t = 0, camY0 = null;
  let fpsFrames = 0, fpsTime = 0;
  const tmpV = new THREE.Vector3(), fwdV = new THREE.Vector3(), rightV = new THREE.Vector3();

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const rdt = Math.min((now - last) / 1000, 0.05); // real frame time
    const dt = rdt * timeScale; // simulation time (the editor can slow / freeze it)
    last = now;
    t += dt;
    U.time.value = t;

    // school & predators
    if (!story) schoolGoal(t, tuna.u.goal.value);
    schoolCenter.copy(tuna.u.goal.value);
    breachFocus.lerp(breachTarget.lengthSq() ? breachTarget : tuna.u.goal.value, 1 - Math.exp(-dt * 0.8));
    reef.u.goal.value.set(Math.cos(t * 0.03 + 2) * 12, reefTop + 1, Math.sin(t * 0.04) * 12);
    school.jumpBoost = Math.max(0, school.jumpBoost - dt);
    const nearSurface = tuna.u.goal.value.y > -4.5;
    tuna.u.jumpChance.value = school.jumpBoost > 0 ? 0.55 : nearSurface ? 0.14 : 0.03;

    // a school on a story path obeys it: it ignores predators and the cursor
    const obey = 1 - (story?.schoolControl ?? 0), predK = fishReact.predators * obey;
    sharks.forEach((s, i) => { s.update(dt); tuna.setPredator(i, s.obj.position, Math.max(0.01, (s.lunging ? 16 : 9) * predK)); reef.setPredator(i, s.obj.position, 6); });
    tuna.setPredator(2, blue.position, Math.max(0.01, 14 * predK)); // tuna part around the blue whale
    humpPath.step(hump, dt);
    bluePath.step(blue, dt);
    turtles.forEach((tt) => tt.path.step(tt.obj, dt));
    for (const a of animated) a.userData.mixer.update(dt);

    // camera: the story's shot camera, the lab director, or a free orbit / fly camera
    if (editor) editor.preUpdate(rdt);
    syncData();
    if (story) { story.update(dt, t); fitScroll(); }
    if (story && !editor?.sceneView) {
      camera.position.copy(story.cam.position);
      camera.quaternion.copy(story.cam.quaternion);
      if (camera.fov !== story.cam.fov) { camera.fov = story.cam.fov; camera.updateProjectionMatrix(); }
    } else if (!story && director.active) director.update(dt, t);
    else {
      if (camTween) {
        camTween.k = Math.min(1, camTween.k + dt / 2.2);
        const e = camTween.k * camTween.k * (3 - 2 * camTween.k);
        camera.position.lerpVectors(camTween.p0, camTween.p, e);
        controls.target.lerpVectors(camTween.t0, camTween.t, e);
        if (camTween.k >= 1) camTween = null;
      }
      if (keys.size) {
        camera.getWorldDirection(fwdV);
        rightV.crossVectors(fwdV, camera.up).normalize();
        const sp = (keys.has('ShiftLeft') ? 40 : 12) * dt;
        tmpV.set(0, 0, 0);
        if (keys.has('KeyW')) tmpV.add(fwdV); if (keys.has('KeyS')) tmpV.sub(fwdV);
        if (keys.has('KeyD')) tmpV.add(rightV); if (keys.has('KeyA')) tmpV.sub(rightV);
        if (keys.has('KeyE')) tmpV.y += 1; if (keys.has('KeyQ')) tmpV.y -= 1;
        tmpV.multiplyScalar(EDIT ? (keys.has('ShiftLeft') ? 40 : 12) * rdt : sp); // editor flies at real speed even when time is slowed
        camera.position.add(tmpV); controls.target.add(tmpV);
      }
      controls.update();
    }
    const minY = seabedHeight(camera.position.x, camera.position.z) + 1;
    if (camera.position.y < minY) camera.position.y = minY;

    // water line: keep the camera out of a ±0.35 m band around the surface, but push it *through* the band in
    // the direction it's moving (pushing back to the side it came from made crossing need a hard drag)
    const h = waveHeightCPU(camera.position.x, camera.position.z, t, oceanU.amp.value);
    if (Math.abs(camera.position.y - h) < 0.35) {
      const wasAbove = camY0 === null ? camera.position.y > h : camY0 > h;
      const dy = camY0 === null ? 0 : camera.position.y - camY0;
      const above = dy < -1e-4 ? false : dy > 1e-4 ? true : wasAbove;
      camera.position.y = h + (above ? 0.35 : -0.35);
    }
    camY0 = camera.position.y;
    U.under.value = camera.position.y < h ? 1 : 0;
    // underwater-only systems are skipped entirely once the story camera is above the sea
    const showUnder = LAB || U.under.value > 0.5;
    seagrass.visible = jellies.visible = bubbles.visible = snow.visible = showUnder;
    reef.mesh.visible = showUnder && reef.count > 0;
    U.camDepth.value = Math.max(0, h - camera.position.y);
    oceanU.center.value.set(camera.position.x, camera.position.z);

    // sun & shadow frustum follow the action
    sun.target.position.set(camera.position.x * 0.6, floorY, camera.position.z * 0.6);
    sun.position.copy(sun.target.position).addScaledVector(U.sunDir.value, 200);

    // cursor ray
    if (pointerIn && $('scare').checked && !director.active) {
      raycaster.setFromCamera(pointer, camera);
      tuna.u.rayO.value.copy(raycaster.ray.origin); tuna.u.rayD.value.copy(raycaster.ray.direction); tuna.u.rayR.value = 7 * fishReact.cursor * obey;
      reef.u.rayO.value.copy(raycaster.ray.origin); reef.u.rayD.value.copy(raycaster.ray.direction); reef.u.rayR.value = 3;
    } else { tuna.u.rayR.value = 0; reef.u.rayR.value = 0; }

    // above the sea the school is only glimpsed through the surface: draw the first 800 (all leapers are < 256)
    tuna.mesh.count = story && U.under.value < 0.5 ? Math.min(tuna.count, 800) : tuna.count;
    if (layers) layers.update(story.x, camera, story.cam);
    if (editor) editor.postUpdate(rdt);
    for (const o of hidden) o.visible = false; // editor outliner
    tuna.update(renderer, dt);
    splash.step(renderer, dt);
    if (reef.mesh.visible) reef.update(renderer, dt);

    // post uniforms
    camera.updateMatrixWorld();
    uCamWorld.value.copy(camera.matrixWorld);
    uProjInv.value.copy(camera.projectionMatrixInverse);
    uCamPos.value.copy(camera.position);
    const sunNdc = tmpV.copy(camera.position).addScaledVector(U.sunDir.value, 4000).project(camera);
    const facing = camera.getWorldDirection(fwdV).dot(U.sunDir.value);
    uSunUV.value.set(sunNdc.x * 0.5 + 0.5, 0.5 - sunNdc.y * 0.5);
    uSunVis.value = facing > 0 ? THREE.MathUtils.smoothstep(facing, 0.2, 0.6) * (1 - THREE.MathUtils.smoothstep(Math.hypot(sunNdc.x, sunNdc.y), 1.2, 2.2)) : 0;

    post.render();
    if (captureCb) { const cb = captureCb; captureCb = null; renderer.domElement.toBlob(cb, 'image/png'); }
    frameHook?.(renderer.domElement);

    fpsFrames++; fpsTime += rdt;
    if (fpsTime > 0.5) {
      const fps = fpsFrames / fpsTime;
      adaptResolution(fps);
      fpsInfo.fps = fps; fpsInfo.res = MAX_PR * renderScale * autoScale;
      $('fps').textContent = `${Math.round(fps)} fps · ${tuna.count} tuna · ${Math.round(MAX_PR * renderScale * autoScale * 100)}% res`;
      fpsFrames = 0; fpsTime = 0;
    }
  });
}

main().catch((e) => { console.error(e); if (!loaderEl.classList.contains('error')) fail(`Error: ${e.message}`); });
