# Open Tuna — WebGPU ocean

Interactive, cinematic ocean scene: a GPU-simulated tuna school (breaching, hunted by sharks),
bioluminescent jellyfish bloom, procedural ocean/sky/seabed, GPU particles and a colour-graded
post stack. Built on **three.js r180 WebGPU renderer + TSL** (node shading language).

## Hard requirements (from the owner)

- **100% WebGPU.** No WebGL fallback. `main.js` refuses to run if `renderer.backend.isWebGPUBackend`
  is false. Do not add `forceWebGL` or a fallback path.
- **At least 200 tuna** swimming as a swarm (slider min is 200; default 700; max 4096).
- **Best optimization + best visual quality.** Simulation stays on the GPU; each creature system is
  one instanced draw. Measure fps before/after any visual addition.
- **Fully procedural ocean** (waves, sky, seabed, caustics, foam). Only creatures/reef come from GLB assets.
- Style target: cinematic, clear tropical turquoise water (Abzû-like), not murky/milky.

## Deploy

Live: **https://itipats.github.io/open-tuna/** — GitHub Pages serves `main` branch root as-is
(repo is public; `.nojekyll` disables Jekyll). Every push to `main` redeploys in ~1 min.
Keep all asset paths relative (`./file.glb`) — the site lives under the `/open-tuna/` subpath.

## Run

No build step, no npm dependencies. ES modules + import map (three from jsDelivr CDN, needs internet).

```sh
python -m http.server 8123      # must be served over HTTP; file:// cannot fetch the .glb files
# open http://127.0.0.1:8123
```

URL flags:
- `?free` — start without the cinematic director (free orbit camera).
- `?debug` — draws velocity arrows on tuna, a reef fish, sharks, turtles and whales, to verify every
  model faces its direction of travel.

Browser: current Chrome/Edge (WebGPU). The page shows an error panel if WebGPU is unavailable.

## Files

```
index.html          UI panel (sliders/toggles/buttons), loader, import map
src/main.js         bootstrap, asset loading/placement, post-processing, UI wiring, main loop
src/shared.js       global uniforms U, palette, baked caustic texture, sky, underwater colour, fog, IBL env
src/ocean.js        Gerstner ocean surface (polar grid), sky dome, seabed (+ CPU wave height query)
src/swarm.js        FishSwarm: compute-shader boids + breach state machine + instanced swim-wave rendering
src/particles.js    Splash (spray + foam, driven by tuna breach state), marine snow, bubble streams
src/jellies.js      procedural bioluminescent jellyfish bloom (generated geometry, GPU animated)
src/vegetation.js   procedural seagrass meadows (instanced blades, vertex sway)
src/creatures.js    whale flex shader, animated (skinned) model wrapper, SwimPath, Hunter (shark AI), scatterInstanced
src/models.js       GLTF loader (+ KHR_materials_pbrSpecularGlossiness plugin), bakeModel, axis canonicalisation, material conversion
src/director.js     cinematic camera: shot list, fade cuts, letterbox, shot choreography
*.glb               assets (Sketchfab exports) — see Assets
```

## Stage size

Everything lives in a compact play area so the action stays on screen (`STAGE = 42` m in `main.js`):
- Tuna goal wanders ±16/±14 m; boid box half-extent = `STAGE`; plus a hard radial wall at 1.2×STAGE
  in the compute shader (turns outward velocity back in). School footprint (`goalSpread`) scales with
  head-count: `clamp(6 + sqrt(n)·0.38, 10, 30)` m, so 4000 tuna don't crush together.
- Sharks: orbit 20 m around the school, lunge 1.9 s, leashed at 0.8×STAGE (slow to cruise + turn back).
- Whale loops: humpback 44×34 m, blue whale 62×50 m. The blue whale is predator slot 2 (tuna part around it).
- Jelly clusters within ~40 m, seagrass patches 22–77 m, coral ring 40–85 m, bubble vents 12–47 m.
- Orbit camera max distance 140 m.
Measured over 60 s with 4000 tuna: tuna ≤50 m from centre, sharks ≤35 m, whales on their loops.

## Architecture

### Global uniforms (`shared.js` → `U`)
`time, under (camera below water 0/1), sunDir, sunColor, sunIntensity, camDepth, deep/mid/shallow`
(tropical palette, linear), `causticStrength, fogDensity`. Everything reads these; `main.js` updates them per frame.
`WATER_Y = 0`, `SEABED_BASE = -24`.

### Ocean (`ocean.js`)
- 11 Gerstner waves (`WAVES`) displaced in the vertex shader on a camera-centred polar grid
  (dense near camera, 4.2 km radius). Waves fade out by distance vs wavelength (anti-alias).
- 10 extra fragment-only detail waves for normals. Whitecaps from the Gerstner Jacobian.
- Above water: sky reflection with Fresnel, screen-space refraction (`viewportTexture` into a
  **HalfFloat `FramebufferTexture`** — must match the rgba16float scene target) with Beer–Lambert
  absorption, subsurface crest glow, sun glints, distance haze.
- Below water: Snell's window (`refract`, IOR 1.333) + total internal reflection.
- `waveHeightCPU()` mirrors the GPU spectrum so the camera knows when it is under water.
  Camera is kept ≥0.35 m from the surface to avoid a half-in/half-out frame.
- Seabed: CPU-displaced plane (`seabedHeight`), procedural sand + `bumpMap` ripples, caustics + glitter as emissive.

### Caustics / light
- Caustic pattern baked once to a 512² texture on the CPU; sampled twice (different scale/drift),
  `min()` combined, with a small RGB split. `causticLight()` is added as emissive to every lit material.
- God rays: screen-space ray march (28 steps, jittered) in post, projecting samples up the sun
  direction onto blurred caustic mips; occluded by scene depth. Underwater only.
- IBL: `createUnderwaterEnv()` equirect float texture (bright surface above, turquoise walls, sand bounce).

### Fish school (`swarm.js` — `FishSwarm`)
- Storage buffers (`instancedArray`): `pos` (xyz + swim phase), `vel` (xyz + speed), `state` (breachers only).
- Compute boids: separation/alignment/cohesion, personal goal offsets, soft box, floor/ceiling,
  up to 3 predators (uniform vec4 xyz+radius), cursor-ray scare. Neighbour scan is exhaustive up to
  256 fish, above that a rotating strided sample of 256 (cost stays flat as count grows).
- Rendering: the skinned tuna GLB is **baked to a static bind pose** (`bakeModel`), canonicalised to
  forward=+Z, up=+Y, length 1, then drawn as ONE `InstancedMesh`. A thunniform travelling wave
  (amplitude ∝ tail distance^2.4) bends the body in `positionNode`; normals are rotated with the slope.
  Orientation from velocity (robust to vertical velocity during breaches).
- Breaching (only fish `idx < jumpers`, tuna uses 64): state machine in the compute shader
  `0 schooling → 1 rush to surface → 2 airborne (ballistic, g=9.81) → 3 re-entry → 0`.
  Runs trigger by hash per `jumpPeriod` slot with `jumpChance`, only when shallower than `jumpDepth`
  and within `jumpRadius` of the school goal (keeps action where the camera looks).
  Each surface crossing writes `state = (mode, x, z, time)`.
- Reef fish reuse `FishSwarm` (static mesh, smaller, no breaching).

### Particles (`particles.js`)
- `Splash`: `per` particles owned by each breaching fish. A compute pass respawns them when the
  owner's crossing time changes (pure GPU→GPU, no readback). 65% spray (camera sprites, ballistic,
  small sparkly droplets) and 35% foam (flat noisy `InstancedMesh` patches on the surface).
- Marine snow: 26k sprites, fully procedural (hash positions wrapped around the camera), brighter in light shafts.
- Bubbles: streams from seabed vents, wobble, grow while rising; rim/specular sprite shading.

### Jellyfish (`jellies.js`)
Generated geometry (lathe bell + oral-arm ribbons + tentacle strips, ~1.4k tris) with attributes
`part / along / jseed`. Vertex: pulse contraction, trailing tentacle waves, per-instance cluster
placement (4 clusters, `Vector4 xyz+radius`). Fragment: additive glow — Fresnel rim, radial canals,
rim band, travelling pulse band, tentacle sparkles, 5-colour palette; manual fog attenuation
(additive + scene fog would brighten with distance, so `fog:false`).

### Creatures (`creatures.js`)
- Humpback: static mesh + vertical fluke flex in the vertex shader.
- Blue whale, sharks, turtles: skinned GLBs with their own animation (`AnimationMixer`), wrapped so
  forward=+Z via `createAnimated` (+ `CONFIG` flip/yaw overrides).
- `Hunter` (sharks): cruise orbit → stalk → lunge (15 m/s) through the school → peel away. Limited
  turn rate, banking, animation speed follows swim speed. Predator radius is larger while lunging.
- `SwimPath`: smooth closed loops for whales/turtles.

### Post (`main.js`)
`pass(scene)` → chromatic aberration → + god rays → + bloom → `renderOutput` (ACES) → colour grade
(teal shadows / warm highlights, saturation, S-curve, vignette; different grade above/below water)
→ FXAA → grain, letterbox, fade. `buildPost()` rebuilds the graph when toggles change.

### Director (`director.js`)
Shots: Breach—surface, School, Hunt, Breach—below, Jelly bloom, Blue whale, Reef, Humpback.
Each shot: `dur`, optional `stiff` (follow stiffness), `enter/exit` (e.g. force school to surface,
boost jumps, teleport the shark near the school during the fade-in), `cam(t, pos, look)`.
Breach framing: `main.js` reads back the 64-entry breach state (1 KB) every 250 ms while the
director is active and biases `breachFocus` toward the latest breach.
User input (click, wheel, WASD) stops the director; the Cinematic button resumes it.

## Assets and per-model fixes

| File | Use | Notes |
|---|---|---|
| tuna_fish.glb | school | skinned; forward from `Head_`→`UpperTail_` bones |
| coral_fish.glb | reef school | **flip: true** (auto-detect picks the tail) |
| model_54a_-_caribbean_reef_shark.glb | 2 hunters | animated, correct as-is |
| model_50a_-_hawksbill_sea_turtle.glb | 2 turtles | **yaw: π/2** (flipper span > shell length fools axis detection); spec/gloss material |
| blue_whale_-_textured.glb | animated whale | **flip: true** |
| game-ready_humpback_whale.glb | flexing whale | **flip: true** |
| underwater_environment.glb | reef/rocks/wreck | 56 MB, 430k tris. Hidden meshes: `Plane049` (square sand slab), `Object1035`/`Object1040` (fake light-shaft cards → streak artifacts) |
| coral_piece.glb | 110 instanced corals | |
| starfish__sarcophyton_…glb | one hero soft coral | 800k tris — never scatter/instance it |
| prins_jellyfish.glb | **not used** | 30k-tri transparent; caused streaks and ~23 fps up close. Replaced by procedural bloom |

Orientation rule: if a creature swims backwards/sideways, fix it with `CONFIG` in `main.js`
(`flip` / `yaw`) and verify with `?debug` arrows — don't change the swim shaders.

## Gotchas (learned the hard way)

- Do **not** toggle `light.castShadow` at runtime in WebGPU — it throws `Cannot read properties of null (reading 'depthTexture')`
  every frame. The Shadows toggle uses `shadow.intensity = 0` + `shadow.autoUpdate = false` instead.
- Refraction copy texture must be `HalfFloatType` (scene target is rgba16float) or `copyFramebufferToTexture` errors.
- The ocean grid needs a `normal` attribute even though the shader computes normals (TSL warning otherwise).
- `hash()` seeds: add `uint(...)`, never raw JS numbers derived from nodes (`Math.floor(node)` is NaN).
- Additive materials must set `fog:false` and attenuate manually.
- Keep the camera away from exactly `y = wave height` (half-under frame looks broken).
- Environment model: new ugly rectangles/edges usually come from its baked helper meshes — check mesh names first.

## Performance reference (RTX-class desktop, 1360×780)

- Cinematic shots, 700 tuna + 600 reef fish + 520 jellies: ~75–90 fps.
- 3000 tuna: ~45–75 fps depending on view. 4096 tuna + 2048 reef (older build): ~51 fps.
- Biggest costs: shadow map pass (env casts shadows), jellies (~10 fps), environment mesh (~7 fps).
- Render-scale slider is the escape hatch for weaker GPUs.

## Testing

No test suite. Verification is done in a real browser with Puppeteer (`puppeteer-core` pointing at
installed Chrome with `--enable-unsafe-webgpu`, headful window moved off-screen): load page,
wait for `window.__ocean` + loader hidden, jump director shots via
`__ocean.director.shotIndex = n - 1; __ocean.director.next()`, screenshot, and collect console errors.
`window.__ocean` exposes camera, controls, swarms, sharks, turtles, director, renderer, scene and systems for this.

Before claiming a visual change works: screenshot the affected shots and check zero console errors.
