# Open Tuna — WebGPU ocean

Scroll-driven, cinematic brand experience for **Thai Union's 50th anniversary (1977–2027)** —
internal sales pitch / mock-up (see `HANDOFF.md` for vision, status and next steps).
Underwater world (GPU tuna school hunted by sharks, whales, turtles, bioluminescent jellies,
procedural ocean/sky/seabed, particles, colour-graded post) → camera rises out of the sea →
a **"50" sculpted from golden water** rises from the ocean under a golden-hour sun and god rays,
with tuna leaping through it and swimming inside it.
Built on **three.js r180 WebGPU renderer + TSL** (node shading language).

## Hard requirements (from the owner)

- **100% WebGPU.** No WebGL fallback. `main.js` refuses to run if `renderer.backend.isWebGPUBackend`
  is false. Do not add `forceWebGL` or a fallback path.
- **Spectacle first.** It's a pitch: extravagant, over-the-top visuals matter most. Performance is
  secondary but keep it presentable — ~2000 tuna runs on a MacBook Air M1 and that's "good enough".
- **At least 200 tuna** swimming as a swarm (slider min 200; default 2000; max 4096). Simulation stays
  on the GPU; each creature system is one instanced draw.
- **The "50" is made of water (golden water + god rays), NOT of fish.** A tuna-shaped 50 was tried and
  rejected as uncanny. Tuna are accents: normal breaching, leaping through/past the 50, a few swimming inside it.
- **Fully procedural ocean** (waves, sky, seabed, caustics, foam) and procedural 50. Only creatures/reef
  pieces come from GLB assets. No pre-rendered video, no AI video.
- Style target: cinematic, clear tropical turquoise water (Abzû-like) underwater; warm golden hour above.

## Deploy

Live: **https://itipats.github.io/open-tuna/** — GitHub Pages serves `main` branch root as-is
(repo is public; `.nojekyll` disables Jekyll). Every push to `main` redeploys in ~1 min.
Keep all asset paths relative (`./file.glb`) — the site lives under the `/open-tuna/` subpath.

## Run

No build step, no npm dependencies. ES modules + import map (three from jsDelivr CDN, Google Fonts;
needs internet).

```sh
python3 -m http.server 8123      # must be served over HTTP; file:// cannot fetch the .glb files
# open http://127.0.0.1:8123 and scroll
```

Modes / URL flags:
- default — **story mode**: page scrolls (900vh spacer), canvas fixed, captions overlaid, no UI panel.
- `?lab` — the old playground: slider panel, orbit camera, looping shot director.
- `?lab&free` — lab without the director (free orbit camera).
- `?debug` — velocity arrows on tuna, a reef fish, sharks, turtles and whales (verify facing).

Browser: current Chrome/Edge (WebGPU). The page shows an error panel if WebGPU is unavailable.

## Files

```
index.html          story captions (.cap, data-in/data-out = progress window), scroll spacer, lab panel, import map, fonts
src/main.js         bootstrap, asset loading/placement, post-processing (underwater + sky god rays), UI, main loop
src/story.js        Story: scroll progress -> camera, sun, school, glyph rise, tuna stunts, captions; flightTargets()
src/glyph.js        bakeGlyph (text -> SDF texture + hole/anchors/inside points), createWaterGlyph (ray-marched water 50), createGlyphDrips
src/shared.js       global uniforms U, palette, baked caustic texture, sky, underwater colour, fog, IBL env
src/ocean.js        Gerstner ocean surface (polar grid), sky dome, seabed (+ CPU wave height query)
src/swarm.js        FishSwarm: compute-shader boids + breach state machine + scripted flights (inside/hoop) + instanced swim-wave rendering
src/particles.js    Splash (spray + foam, driven by the swarm `state` buffer), marine snow, bubble streams
src/jellies.js      procedural bioluminescent jellyfish bloom (generated geometry, GPU animated)
src/vegetation.js   procedural seagrass meadows (instanced blades, vertex sway)
src/creatures.js    whale flex shader, animated (skinned) model wrapper, SwimPath, Hunter (shark AI), scatterInstanced
src/models.js       GLTF loader (+ KHR_materials_pbrSpecularGlossiness plugin), bakeModel, axis canonicalisation, material conversion
src/director.js     lab-mode cinematic camera: shot list, fade cuts, letterbox, shot choreography
*.glb               assets (Sketchfab exports) — see Assets
```

## Story timeline (`story.js`, progress p = smoothed scroll 0..1)

All state is a pure function of p (plus time for idle motion), so scrolling back rewinds exactly.
`story.forceP = x` pins progress (used by tests). Smoothing: `p += (target - p)·(1 - e^(-2.4·dt))`.

| p | What happens |
|---|---|
| 0 – 0.30 | Underwater. Camera arcs around the school at y≈-9 (radius 26). Hero caption. |
| 0.22 – 0.46 | School goal gathers under the glyph (y -4.5). |
| 0.30 – 0.50 | Camera ascends (0,-9,26) → (0,5,50), breaks the surface ~0.43, tilts up to the glyph. |
| 0.40 – 0.66 | Sun: 55° / az 0.9 (midday) → 9° / az π-0.1 (golden hour, behind the 50 as seen from +z). |
| 0.44 – 0.62 | "Inside" tuna swim into the (still submerged) glyph. |
| 0.48 – 0.68 | Glyph rises from lift -(height+4) to 0; drips strong 0.5–0.7, then a trickle. |
| 0.50 – 0.78 | Liquid tendrils join glyph to sea; snap off 0.71–0.78. |
| 0.50 – 1.00 | Above water: camera arcs (a 0→-0.3 rad) and pushes in (r 50→42), looks at glyph centre. |
| > 0.72 | "Hoop" tuna loop-leap through the hole of the 0. |
| 0.90 – 1 | End caption "1977 — 2027 / Thai Union · Fifty Years". |

## Stage size

Everything lives in a compact play area (`STAGE = 42` m in `main.js`):
- The photogrammetry reef (`underwater_environment.glb`) and hero starfish are **no longer loaded**
  (−88 MB). `reefTop = seabedHeight(0,0) + 5` stands in for the old rock top.
- Tuna goal: story mode drives it (see timeline); lab mode wanders ±16/±14 m. Boid box half-extent =
  `STAGE` + hard radial wall at 1.2×STAGE. `goalSpread = clamp(6 + sqrt(n)·0.38, 10, 30)` m.
- Sharks: orbit 20 m around the school, lunge 1.9 s, leashed at 0.8×STAGE.
- Whale loops: humpback 44×34 m, blue whale 62×50 m (predator slot 2).
- Corals 160 instanced at r 14–84 m, seagrass 30k blades everywhere, bubble vents 12–47 m.
- Glyph: 40 m wide × ~21.6 m tall × 5 m thick, centred x=0,z=0, bottom at y=1.8 when risen.
  Hole of the "0" and its size are measured from the canvas (`G.hole`, `G.holeSize`).

## Architecture

### Global uniforms (`shared.js` → `U`)
`time, under (camera below water 0/1), sunDir, sunColor, sunIntensity, camDepth, deep/mid/shallow`
(tropical palette, linear), `causticStrength, fogDensity`. Everything reads these; `main.js` updates them per frame.
`WATER_Y = 0`, `SEABED_BASE = -24`. `setSun(elevationDeg, azimuth = 0.9)` in `main.js` sets sun dir/colour/
intensity + light, hemi, env intensity; story calls it every frame.

### Water "50" (`glyph.js`)
- `bakeGlyph({ text, width, bottom, thick })`: draws the text on a canvas (`900 560px "Arial Black"`),
  downsamples to 512×320, runs a CPU Felzenszwalb EDT inside+outside → signed distance in metres
  stored as an R16F `DataTexture` (row 0 = bottom). Also returns `hole` / `holeSize` (counter of the "0"),
  tendril `anchors` (x of columns touching the glyph bottom), `insidePoints(n, margin)`.
- `createWaterGlyph(G)`: a box mesh (transparent, `depthWrite:false`, renderOrder 14) whose fragment
  ray-marches (80 steps, slab-clipped) the SDF: extruded 2D SDF with rounded edges (R=0.9) + flowing
  `mx_noise` displacement (0.32 m) + smooth-min capsule tendrils down to the sea. Hits below y=-0.2 are discarded.
  Shading: tetrahedral normal; Fresnel sky reflection (`skyColor`); screen-space refraction through its own
  HalfFloat `FramebufferTexture` (so fish inside/behind show through) with thickness from a short inward march;
  Beer–Lambert gold absorption; caustic veins; sun specular; gold rim + back-lit translucency (`glow`).
  Uniforms (`mesh.userData.u`): `lift`, `tendril`, `glow`.
- `createGlyphDrips(G)`: 7k procedural sprites falling from inside the letters (`lift`, `drip` 0..1 amount).

### Fish school (`swarm.js` — `FishSwarm`)
- Storage buffers (`instancedArray`): `pos` (xyz + swim phase), `vel` (xyz + speed), `state` (jumpers only),
  and when `targets` is given: `target` (vec4) + `origin` (last schooling position).
- Compute boids: separation/alignment/cohesion, personal goal offsets, soft box, floor/ceiling,
  up to 3 predators (uniform vec4 xyz+radius), cursor-ray scare. Neighbour scan is exhaustive up to
  256 fish, above that a rotating strided sample of 256 (cost stays flat as count grows).
- **Scripted flights** (`targets` Float32Array(max·4), built by `flightTargets()` in story.js):
  - `w < 0` — plain schooling.
  - `0 ≤ w < 1` — **inside** fish: xyz = spot inside the glyph, w = launch delay. When `form > w`,
    s = (form-w)/formSpan; quadratic Bezier from `origin` to target(+`lift`), then milling loops.
  - `w ≥ 10` — **hoop** fish: xyz = lane jitter (x, y, sign(z) = direction), w-10 = loop phase. While
    `hoop` is on and fract(time/hoopPeriod + w) < hoopAir, flies a parabola through `hole` (apex = hole.y+lift),
    easing in from its schooling position over the first 18%.
  - Flights write `origin` only while schooling, so a fish resumes boids exactly where the flight left it.
    Surface crossings during flights write `state` → splashes. Indices: inside 0..89, hoop 90..229 (< jumpers 256).
- Rendering: the skinned tuna GLB is **baked to a static bind pose** (`bakeModel`), canonicalised to
  forward=+Z, up=+Y, length 1, then drawn as ONE `InstancedMesh`. A thunniform travelling wave
  (amplitude ∝ tail distance^2.4) bends the body in `positionNode`; normals are rotated with the slope.
  Orientation from velocity.
- Breaching (only fish `idx < jumpers`, tuna uses 256): state machine
  `0 schooling → 1 rush to surface → 2 airborne (ballistic, g=9.81) → 3 re-entry → 0`, triggered by hash
  per `jumpPeriod` slot with `jumpChance`, only when shallower than `jumpDepth` and within `jumpRadius` of the goal.
  Each surface crossing writes `state = (mode, x, z, time)`.
- Reef fish reuse `FishSwarm` (static mesh, smaller, no breaching, no targets).

### Particles (`particles.js`)
- `Splash(tuna, 110)`: `per` particles owned by each jumper (256×110). A compute pass respawns them when the
  owner's crossing time changes (pure GPU→GPU). 65% spray sprites, 35% flat foam patches.
- Marine snow: 26k sprites, procedural, wrapped around the camera, brighter in light shafts.
- Bubbles: streams from seabed vents.

### Jellyfish (`jellies.js`)
Generated geometry (lathe bell + oral-arm ribbons + tentacle strips, ~1.4k tris), per-instance cluster
placement (4 clusters), additive glow with manual fog attenuation (`fog:false`).

### Creatures (`creatures.js`)
- Humpback: static mesh + vertical fluke flex. Blue whale, sharks, turtles: skinned GLBs with `AnimationMixer`,
  wrapped so forward=+Z via `createAnimated` (+ `CONFIG` flip/yaw overrides).
- `Hunter` (sharks): cruise orbit → stalk → lunge (15 m/s) through the school → peel away.
- `SwimPath`: smooth closed loops for whales/turtles.

### Post (`main.js`)
`pass(scene)` → chromatic aberration → + underwater god rays (28-step march on blurred caustics, under water only)
→ + **sky god rays** (above water: 56-sample radial blur toward the sun's screen position `uSunUV`, samples
clamped to 2.5, mask `smoothstep(0.9, 2.2, lum)` × "open" (depth == 1: sky and the non-depth-writing glyph),
× `uSunVis` (sun in front / near screen), × `uSkyRayK` 0.6, warm tint) → + bloom → `renderOutput` (ACES)
→ colour grade → FXAA → grain, letterbox, fade. `buildPost()` rebuilds the graph when toggles change.

### Director (`director.js`, lab mode only)
Shots: Breach—surface, School, Hunt, Breach—below, Jelly bloom, Blue whale, Reef, Humpback.
Breach framing reads back the jumper `state` buffer every 250 ms while active.

## Assets and per-model fixes

| File | Use | Notes |
|---|---|---|
| tuna_fish.glb | school | skinned; forward from `Head_`→`UpperTail_` bones |
| coral_fish.glb | reef school | **flip: true** |
| model_54a_-_caribbean_reef_shark.glb | 2 hunters | animated, correct as-is |
| model_50a_-_hawksbill_sea_turtle.glb | 2 turtles | **yaw: π/2**; spec/gloss material |
| blue_whale_-_textured.glb | animated whale | **flip: true** |
| game-ready_humpback_whale.glb | flexing whale | **flip: true** |
| coral_piece.glb | 160 instanced corals | |
| underwater_environment.glb | **not loaded** (56 MB) | removed for load time; file still in repo |
| starfish__sarcophyton_…glb | **not loaded** (32 MB) | 800k tris |
| prins_jellyfish.glb | **not used** | replaced by procedural bloom |

Orientation rule: if a creature swims backwards/sideways, fix it with `CONFIG` in `main.js`
(`flip` / `yaw`) and verify with `?debug` arrows — don't change the swim shaders.

## Gotchas (learned the hard way)

- Do **not** toggle `light.castShadow` at runtime in WebGPU — throws `reading 'depthTexture'` every frame.
  The Shadows toggle uses `shadow.intensity = 0` + `shadow.autoUpdate = false` instead.
- Refraction copy textures must be `HalfFloatType` (scene target is rgba16float). Ocean and glyph each own one.
- The ocean grid needs a `normal` attribute even though the shader computes normals.
- `hash()` seeds: add `uint(...)`, never raw JS numbers derived from nodes.
- Additive materials must set `fog:false` and attenuate manually.
- Keep the camera away from exactly `y = wave height` (clamped to ±0.35 m).
- `main.js` already has a `G` (loaded GLTFs) — the glyph info object is `glyphInfo`.
- The HDR sun disk is ~40× the sky; anything screen-space that samples it must clamp or it whites out the frame.
- In story mode the canvas has `pointer-events:none` (so the page scrolls); pointer listeners are on `window`.

## Performance reference

- Old build (RTX-class desktop, 1360×780): 700 tuna + 600 reef + 520 jellies ~75–90 fps; 3000 tuna ~45–75 fps.
- Story build on the dev Mac in *headless* Chrome: ~20–27 fps at 2000 tuna (headless numbers are not
  reliable — measure in a real window). Owner reports 2000 tuna fine on an M1 Air (old build).
- Biggest costs: shadow map, jellies, glyph ray-march (80 steps + noise per step, full-screen-ish box),
  sky god rays (56 taps). Render-scale slider (lab) is the escape hatch.

## Testing

No test suite. Verify in a real browser. **Don't pop up browser windows on the owner's screen**: run ONE
persistent headless Chrome and reuse it (headless WebGPU works on macOS/Metal):

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --enable-unsafe-webgpu \
  --remote-debugging-port=9333 --user-data-dir=<scratch>/chrome-profile --window-size=1360,780 about:blank
```

Then a puppeteer-core script (`puppeteer-core@19` works with Node 16) does
`puppeteer.connect({ browserURL: 'http://127.0.0.1:9333' })`, reuses the first tab, waits for
`window.__ocean` + loader hidden, sets `__ocean.story.forceP = p` for each progress point, waits ~2.5 s,
screenshots, collects console errors, then navigates the tab to `about:blank` and disconnects.
Lab shots: `__ocean.director.shotIndex = n - 1; __ocean.director.next()`.
`window.__ocean` exposes camera, controls, tuna, reef, sharks, turtles, director, story, glyph, glyphInfo,
renderer, scene and systems.

Before claiming a visual change works: screenshot the affected progress points and check zero console errors.
