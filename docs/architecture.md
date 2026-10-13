# Runtime architecture

three.js r180, `WebGPURenderer` + TSL node materials, ES modules from jsDelivr via the import map in `index.html`
(`three`, `three/webgpu`, `three/tsl`, `three/addons/`, `meshoptimizer/simplifier`). No build.

## Boot (`src/main.js`)

1. Mode from the page: `play.html` → `story` (or `lab` with `?lab`), `editor.html` → `edit`
   (`window.OPEN_TUNA_PAGE`), set as a class on `<html>`. A built site (`window.OPEN_TUNA_BUILD`) is always `story`.
   `src/project.js` picks the project from `?project=` (`demo/<id>` → `demos/<id>/`, `<slug>` → `projects/<slug>/`;
   `BASE`, `assetURL`). Without one the page goes to the studio home. See [projects-build-data.md](projects-build-data.md).
2. WebGPU only: an error panel if there is no adapter or no WebGPU backend.
3. Scene: sky, ocean, seabed (procedural) → GLBs (`models/`) loaded in parallel with the project's `story.json` (fetched as raw text: the
   editor fingerprints it).
4. Systems: tuna `FishSwarm` (leap targets from `flightTargets()`), `Splash`, reef fish swarm, jellies, whales
   (`createFlexingWhale`, `createAnimated` + `SwimPath`), sharks (`Hunter`), turtles, corals, seagrass, the water 50
   (`createWaterTentacles`), marine snow, bubbles.
5. Post-processing graph (`buildPost`), controls, the lab UI.
6. Story mode: a `DataHub` (`src/data.js`, the story's `sources`), then `Story` (with `applyParam` setters + `actors`)
   and `Layers`, both resolving `{{bindings}}` through it. Edit mode: dynamically imports the editor.
7. Warm-up: the water 50 and the GPU layers are made visible during `renderer.compileAsync` so their first
   appearance doesn't hitch.

## Main loop order (matters)

```
sim time t += dt·timeScale                     (editor can slow / freeze; rdt = real frame time)
lab-only school goal · predators (sharks update → tuna.setPredator, scaled by fish-reaction params × path control)
humpPath / bluePath / turtles step · animation mixers
editor.preUpdate(rdt)                          (playhead → story.forceP; site-play scroll / auto-play)
syncData()                                     (timeline changed → DataHub.sync(sources): refetch what changed)
story.update(dt, t)                            → site time xr = p·realDuration → unwarp → story time x + stretch item
                                                 (DataHub.setItem: {{item…}}), then camera pose, sun, params, school goal, water 50, leap gates,
                                                 creature paths (override what the creatures did above), captions
render camera ← story.cam  (unless the editor's Scene view: orbit / fly camera)
seabed / waterline clamps (the waterline band pushes the camera *through* the surface)
underwater-only systems hidden above water (seagrass, jellies, bubbles, snow, reef fish)
cursor ray → swarm scare (× school.cursor param × path control)
tuna.mesh.count = 800 above water
layers.update(story.x, camera, story.cam) · editor.postUpdate · editor-hidden objects
tuna.update · splash.step · reef.update        (compute passes)
post uniforms (camera matrices, sun screen position) · post.render()
fps → adaptive resolution
```

## Global uniforms (`src/shared.js` → `U`)

The global uniforms are `time, under, sunDir, sunColor, sunIntensity, camDepth, deep / mid / shallow` (palette),
`causticStrength` and `fogDensity`. `WATER_Y = 0`, `SEABED_BASE = -24`. `setSun(elevationDeg, azimuthRad)` in
main.js sets the sun direction, colour and intensity plus the light, hemisphere and environment. The story calls it
every frame from the `sun.*` params.

## Stage

Everything stays in a compact area (`STAGE = 42` m):
- The tuna boid box is ±42 with a hard radial wall at 1.2×. The school spread is `clamp(6 + √n·0.38, 10, 30)`.
- Sharks orbit about 20 m around the school and are leashed at 0.8×STAGE.
- Whale loops: humpback 44×34 m, blue whale 62×50 m.
- Corals sit at r 14–84 m.
- The water 50 is at z = 0, x −19..19, y 2..24. Its "0" is an ellipse centred at (11, 13), rx 7.6, ry 10.8.
- The tuna leap band is z 10–64.

## Fish school (`src/swarm.js` — `FishSwarm`)

- **Buffers** (`instancedArray`): `pos` (xyz + swim phase), `vel`, `state` (jumpers: mode, crossing x/z, time),
  and with leap targets also `launch`, `land` and `origin` (last schooling position; `w` = committed leap cycle).
- **Boids** in compute: separation / alignment / cohesion, personal goal offsets (`goalSpread`), soft box,
  floor / ceiling, 3 predators (vec4 xyz + radius), and a cursor ray. The neighbour scan is exhaustive up to 256
  fish, then a rotating strided sample of 256.
- **Leap cycle** (story mode; `launch.w`: 10..11 = hoop group, 20..21 = free group, fract = phase). Each fish
  cycles on its own period (10.5–22 s):
  1. a fixed 4.5–5.5 s **underwater run-up**, a quadratic curve from its schooling origin to the launch point;
  2. a **ballistic arc** to `land` (real-gravity air time for the apex).

  A cycle only runs if it *started* while the group was on: `hoopWin` / `freeWin` = (on since, off since) in sim
  time, set by `Story` → `gate()`. The fish also commits in the first 0.25 s only if it is within 32 m of its
  launch point. That's why no fish pops into the air when scrolling in. Surface crossings write `state` → splashes.
- **Breaching** state machine for natural surface jumps (`jumpers` = first 256): schooling → rush → airborne →
  re-entry.
- **Rendering:** the tuna GLB is baked to its bind pose, canonicalised (+Z forward, length 1), and in story mode
  simplified to ~2.1k triangles (meshoptimizer). It is one `InstancedMesh` with a thunniform travelling wave in
  `positionNode`.
- **Path control:** while a school path is active, `Story` raises `wGoal` to 6 and caps `goalSpread` at 9, then
  restores both. main.js zeroes predator and cursor reactions using `story.schoolControl`.

## The water 50 (`src/tentacles.js`)

- **Tentacles:** 4 stroke tentacles (two for the 5, two for the 0) plus 2 decorative curls. Each is stem control
  points from the sea plus stroke points (centripetal Catmull-Rom, arc-length resampled to 256 points).
- **`update(form, t)` on the CPU** each visible frame:
  - a braid helix lerped toward the final shapes,
  - sway and breathing,
  - parallel-transport frames and a radius profile,
  - a growing rounded tip,
  - the stems retracting at the end.

  The result goes into an RGBA32F `DataTexture`.
- **Drawing:** instanced tubes read that texture with `textureLoad`. **The winding must face outward.** Shading:
  screen-space refraction absorbed toward blue, dim caustic veins, a cyan Fresnel rim, sky reflection, and sun
  glint.
- **Extras:** gold thread helices visible only in travelling stretches (glimpses), and root foam sprites.
- `form` comes from the `tentacles.form` clip and visibility from `tentacles.fade`.

## Ocean (`src/ocean.js`)

- **Surface:** Gerstner waves on a camera-centred polar grid (11 waves), plus 12 irregular fragment-only ripple
  waves. `waveHeightCPU` mirrors it for the waterline.
- **From above** (stylised, clear water): refraction of what's below with per-channel Beer–Lambert absorption over
  the view-ray thickness, so red dies first and depth reads turquoise. On top of that: the body colour as
  in-scatter, Fresnel sky reflection, crest glow, a sun sheen plus star glints, and foam made from two caustic
  samples at unrelated scales.
- **From below:** a widened, soft Snell's window (eta 1.18) with a bright rim, and a turquoise rippled mirror outside
  it.

## Creatures (`src/creatures.js`)

- **Humpback:** a flexing static mesh. **Blue whale, sharks, turtles:** skinned GLBs through `createAnimated`
  (+Z forward, length normalised, materials converted, `AnimationMixer`).
- **`SwimPath`** gives whales and turtles a closed loop. `anchor(pos, forward)` re-centres the loop at the
  creature's position after a story path lets go, then drifts home over about 30 s.
- **`Hunter`** (sharks) cycles cruise → stalk → lunge (15 m/s) → peel away. `release(forward)` resumes it after a
  path.
- **Story paths:** `Story.drive` keeps its own position, velocity and heading for the creature, steering toward
  the route at a capped speed. It snaps only on a seek (story time jump > 1.5 s). `Story.release` restores the
  driven pose and hands the creature back.

## Jellies, particles, vegetation

- **Jellies** (`jellies.js`): procedural geometry, 4 clusters, additive, `fog: false` with manual attenuation.
  **renderOrder 11 (after the ocean)**. Kept ≥ 2 m under the surface and faded near the camera.
- **Particles:** `Splash` (spray + foam, per-jumper particles respawned on the GPU when its crossing time changes),
  marine snow around the camera, and bubble streams from vents.
- **Seagrass:** instanced blades with vertex sway (14k in story mode).

## Layers (`src/layers.js`)

- **DOM layers** (`html`, `iframe`, image / video with `render: dom`) are `.layer` divs in `#captions > .lays`.
  They are positioned in %, sized with container units, use `z-index = z`, and take `pointer-events` only when
  `interactive`.
- **GPU layers** (`image` / `video` with `render: gpu`, `text`, `glass`, and everything with `space: world`) use one
  `MeshBasicNodeMaterial` each (`layerMaterial`). The material does:
  - flow distortion,
  - a reveal mask (fade / dissolve / wipe / ripple, from caustic-texture noise) driven by the fade value, with a
    bright water edge,
  - chroma split (× scroll speed),
  - caustic light,
  - glow (HDR → bloom),
  - when `glass > 0` at build time, a frosted-glass rounded rect that samples a `viewportTexture` copy (5 taps).

  Screen GPU layers are planes posed in front of `story.cam` at `depth` m, so the scene's depth test makes nearer
  fish occlude them. They draw under all DOM overlays.
- **Text** is drawn into a 2048-wide canvas (Cormorant Garamond / Inter) after `document.fonts.ready`.
- **Model layers** (`kind: model`) load a GLB once (`loadGLTF` cache) and clone it per clip through `createAnimated`.
  Materials are made transparent once (opacity fades with no recompile). Position and rotation (YXZ °) come from
  keys, scale is `w·s`, and the animation is scrubbed by story time (`scrub` defaults to on).
- **Rebuilds:** items are keyed by track id and rebuilt only when kind / src / html / glass on-off / text / model
  flip+anim change. Everything else is a uniform or transform, so editing is live.

## Post (`buildPost` in main.js)

The chain is:
1. `pass(scene)`, then chromatic aberration.
2. Plus underwater god rays: a 28-step march over blurred caustics (only underwater).
3. Plus sky god rays: a 24-tap radial blur toward the sun's screen position over open sky (clamped samples, warm
   tint).
4. Plus bloom (`bloomNode`, strength from `post.bloom`).
5. `renderOutput` (ACES), then the colour grade, FXAA, grain, letterbox and fade.

`buildPost()` rebuilds the graph when the God rays / Bloom toggles change.

## Performance notes

- **What keeps it light:**
  - the pixel ratio is capped at 1.5, then **adaptive resolution** (−15% after about 1 s under 45 fps, down to 50%;
    +8% after about 3 s over 58 fps; `?noauto` disables it);
  - no shadow map in story mode;
  - tuna simplified, with a standard material;
  - 800 tuna drawn above water;
  - underwater-only systems hidden and not simulated above water.
- **Biggest costs:** drawing 2000 tuna underwater (vertex-bound), and each glass layer's framebuffer copy.
- **Measuring:** headless numbers are noisy. The designer's own editor tab shares the GPU. Warm up first, then A/B
  in the same session ([testing.md](testing.md)).

## Lab mode (`?lab`)

The original playground: a slider panel, orbit camera, presets, and `Director` shots (`director.js`: breach,
school, hunt, jelly bloom, whales, reef). It doesn't use `story.json`.
