# Open Tuna — WebGPU ocean

Scroll-driven, cinematic brand experience for **Thai Union's 50th anniversary (1977–2027)** —
internal sales pitch / mock-up (see `HANDOFF.md` for vision, status and next steps).
Underwater world (GPU tuna school hunted by sharks, whales, turtles, bioluminescent jellies,
procedural ocean/sky/seabed, particles, colour-graded post) → camera rises out of the sea →
**tentacles of water** rise from the sea braided like a vortex, unfurl, and their tips **draw a monoline "50"**
(glimpses of golden thread spiral around them), at golden hour, while tuna leap across the camera (a few through the 0).
Built on **three.js r180 WebGPU renderer + TSL** (node shading language).

## Hard requirements (from the owner)

- **100% WebGPU.** No WebGL fallback. `main.js` refuses to run if `renderer.backend.isWebGPUBackend`
  is false. Do not add `forceWebGL` or a fallback path.
- **Spectacle first, but smooth.** It's a pitch: extravagant visuals, yet it must stay fluid on mid-range hardware.
- **At least 200 tuna** swimming as a swarm (slider min 200; default 2000; max 4096). Simulation stays
  on the GPU; each creature system is one instanced draw.
- **The "50" is water, NOT fish** (a tuna-shaped 50 was rejected as uncanny). Reference look: glossy translucent
  blue **water tentacles** with glowing rims rising from the sea (owner's reference image, "tentacle + vortex").
  **Multiple streams fly and forge the 50, smooth and seamless — nothing pops in randomly.** **Not all gold**:
  only glimpses of golden thread. No brand label text on screen ("Thai Union" labels removed as unprofessional).
- **Tuna**: most leap around / across / over the camera; only a few leap through the hole of the 0.
- **Must not lag on a mid-range device** (an M1 Air "exploded" on the old ray-marched 50 — never again).
  No full-screen ray marching; prefer particles + cheap shading. Check fps at every story point.
- **Ocean is stylised** (clean two-tone water, crisp foam/glints), and the sky must be visible from underwater.
  Don't spend effort on the seabed or underwater caustics.
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
python3 tools/serve.py           # dev server (no caching, editor save system); file:// cannot fetch the .glb files
# site: http://localhost:8123   editor: http://localhost:8123/?edit
```
Double-click launchers for non-developers: `Open Editor.bat` (Windows; falls back to `tools/serve.ps1` when
Python is missing) and `Open Editor.command` (macOS). Designer guide: `EDITOR.md`. Any static server works for
the site itself; only the editor's in-place Save needs `tools/serve.py` / `serve.ps1`.

Modes / URL flags:
- default — **story mode**: page scrolls (`meta.duration × meta.scrollPerSecond` vh spacer), canvas fixed, captions overlaid.
- `?t=42` (seconds) / `?p=0.7` (progress) — story mode opened at that point (the editor's "Open site" uses `?t`).
- `?edit` — **timeline editor** around the story (see "Story data & editor" below).
- `?lab` — the old playground: slider panel, orbit camera, looping shot director.
- `?lab&free` — lab without the director (free orbit camera).
- `?noauto` — disable dynamic resolution (use for screenshots/perf comparisons).
- `?debug` — velocity arrows on tuna, a reef fish, sharks, turtles and whales (verify facing).

Browser: current Chrome/Edge (WebGPU). The page shows an error panel if WebGPU is unavailable.

## Files

```
index.html          #captions layer (filled from story.json), scroll spacer, lab panel, import map, fonts
story.json          THE STORY DATA: camera keys, captions, sun curves, beat timings, chapters, notes, settings (edited by ?edit)
src/timeline.js     Timeline: story.json model + evaluation (Hermite camera, eased curves, clips/gates, captions, evalKeys) + serializer
src/layers.js       Layers: media layer tracks -> DOM overlays (image / video / HTML / iframe in #captions) or 3D planes (image /
                    video textures); fades, keyframed x/y/s/r/o or pos; scrubbed videos; incremental rebuild by track id
src/editor/         ?edit only: editor.js (shell, menus, play mode, locks, clipboard, context menus, undo, Copy ref),
                    saves.js (save / autosave / checkpoints / restore / import-export / git), timeline-view.js (canvas
                    timeline), inspector.js, scene-gizmos.js (camera path, key balls, TransformControls), menu.js
                    (context menus, drop-downs, dialogs), layer-tools.js (add / drop / drag / scale / auto-key / parallax
                    for layers), editor.css, dom.js
tools/serve.py      dev server: no-store caching + editor save system endpoints (tools/serve.ps1 = same, PowerShell; keep in sync)
saves/              editor-made: checkpoints/ (named, committed with the story) and auto/ (previous versions, gitignored)
assets/             editor-uploaded media for layers (images, videos, .html pages); referenced as "assets/x.png" 
src/main.js         bootstrap, asset loading/placement, post-processing (underwater + sky god rays), UI, main loop
src/story.js        Story: progress -> evaluates the timeline into camera, sun, params, school, tentacles, tuna gates,
                    captions; PARAMS (curve-bindable) + DRIVERS (clip-bindable) registries; flightTargets()
src/tentacles.js    createWaterTentacles: the water 50 — CPU-built tentacle paths -> float texture -> instanced water tubes,
                    gold thread helices, root foam; also exports the 0's hole for the hoop tuna
src/shared.js       global uniforms U, palette, baked caustic texture, sky, underwater colour, fog, IBL env
src/ocean.js        Gerstner ocean surface (polar grid), sky dome, seabed (+ CPU wave height query)
src/swarm.js        FishSwarm: compute-shader boids + breach state machine + scripted flights (inside/hoop) + instanced swim-wave rendering
src/particles.js    Splash (spray + foam, driven by the swarm `state` buffer), marine snow, bubble streams
src/jellies.js      procedural bioluminescent jellyfish bloom (generated geometry, GPU animated)
src/vegetation.js   procedural seagrass meadows (instanced blades, vertex sway)
src/creatures.js    whale flex shader, animated (skinned) model wrapper, SwimPath, Hunter (shark AI), scatterInstanced
src/models.js       GLTF loader (+ spec/gloss plugin), bakeModel, axis canonicalisation, simplifyGeometry (meshoptimizer), material conversion
src/director.js     lab-mode cinematic camera: shot list, fade cuts, letterbox, shot choreography
*.glb               assets (Sketchfab exports) — see Assets
```

## Story timeline (story time x = p · duration, p = smoothed scroll 0..1)

**Timings live in `story.json` (seconds), not in code** — edit them there or in the editor. The table below is the
original 60 s act in progress terms (seconds = p × 60). All state is a pure function of x (plus time for idle
motion), so scrolling back rewinds exactly. The story can be extended past 60 s (`meta.duration`); keys stay put.
`story.forceP = p` pins progress (used by tests / the editor). Smoothing: `p += (target - p)·(1 - e^(-2.4·dt))`.

| p (×60 s) | What happens |
|---|---|
| 0 – 0.30 | Underwater. Camera arcs around the school at y≈-9 (radius 26). Hero caption. |
| 0.22 – 0.46 | School goal gathers to (0, -4.5, 18) — under the leap band in front of the 50. |
| 0.30 – 0.50 | Camera ascends (0,-9,26) → (0,5,50), breaks the surface ~0.43. |
| 0.40 – 0.66 | Sun: 55° / az 0.9 → 7° / az 0.42-π (golden hour, left of the 50). Az swings *behind the camera* so the sun never crosses the frame. |
| 0.43 – 0.46 | Tentacles fade in (`u.visible`). `form = range(p, 0.44, 0.92)` → `tentacles.userData.update(form, t)`. |
| form 0 – 0.38 | Six tentacles grow ~20 m out of the sea, braided around one rising axis (vortex), staggered starts. |
| form 0.36 – 0.72 | Braid → final shapes (unfurl), sway fades. |
| form 0.42 – 0.90 | Growth continues: each stroke tentacle's rounded tip travels along its stroke and draws it. |
| form 0.86 – 1 | Stroke tentacles' stems retract up into the letters (rounded tail) → the 50 floats; side tentacles stay. |
| > 0.50 | "Free" tuna leaps on (across / over / away from the camera). |
| > 0.84 | "Hoop" tuna leaps through the 0 on. |
| 0.50 – 1.00 | Camera arcs (a 0→-0.3 rad) and pushes in (r 50→42); look-at rises from the braid (y 4) to the 50's centre (y 13). |

## Stage size

Everything lives in a compact play area (`STAGE = 42` m in `main.js`):
- The photogrammetry reef (`underwater_environment.glb`) and hero starfish are **no longer loaded**
  (−88 MB). `reefTop = seabedHeight(0,0) + 5` stands in for the old rock top.
- Tuna goal: story mode drives it (see timeline); lab mode wanders ±16/±14 m. Boid box half-extent =
  `STAGE` + hard radial wall at 1.2×STAGE. `goalSpread = clamp(6 + sqrt(n)·0.38, 10, 30)` m.
- Sharks: orbit 20 m around the school, lunge 1.9 s, leashed at 0.8×STAGE.
- Whale loops: humpback 44×34 m, blue whale 62×50 m (predator slot 2).
- Corals 160 instanced at r 14–84 m, seagrass 30k blades everywhere, bubble vents 12–47 m.
- The 50: monoline strokes at z=0, x −19..19, y 2..24 (tube radius 1.75); "0" is an ellipse centre (11, 13),
  rx 7.6, ry 10.8. Stems root at z −10..−14 (behind the letters). Side tentacles at x ±28. Tuna leap band: z 10–64.

## Architecture

### Story data & editor (`story.json`, `timeline.js`, `story.js`, `src/editor/`)
- **Split of responsibilities:** `story.json` says *when* (keys, clips, captions, constants); `story.js` says
  *what* a beat does. To add a new story beat: add an entry to `DRIVERS` (clip, 0..1 ramp or `gate`) or
  `PARAMS` (curve, scalar with default/range) in `story.js`, read it in `Story.evaluate` via
  `tl.clip(id, x)` / `tl.param(id, x, def)` (x = story time in s; params also need a setter in `applyParam` in `main.js`), then add
  the track to `story.json` (or let the designer add it with "+ Track…"). Missing/muted tracks evaluate to 0 /
  the constant in `settings.params`, so code must tolerate that.
- **story.json v2 is in seconds** (`meta.duration`, `meta.scrollPerSecond`; `migrate()` upgrades v1 files, which
  stored progress 0..1). Track types: `camera` (keys `{t,pos,look,follow,fov}`, Hermite in t, flat ends; `drift` =
  hand-held sway; `follow` blends the look-at to the school goal), `curve` (`{t,v,ease}`; ease shapes the segment
  *after* the key), `clip` (`a,b,ease` in s; `gate` = on inside; `b ≥ duration` = until the end), `captions`
  (`{a,b,title,sub,size,y,fade}`; a ≤ 0 = visible at load). Plus `chapters` / `notes` `{t, …}` (people only —
  **read `notes` when asked to act on designer feedback**). Any of them can carry `locked: true` (the editor
  won't change it — respect it when editing story.json by hand unless asked) and tracks `mute: true`.
  `Timeline.serialize()` writes one key/clip per line, numbers rounded to 4 dp; segment lookup is a binary search.
- `Story` owns a separate shot camera `story.cam` (+ `story.look`); `main.js` copies it into the render camera
  unless the editor's Scene view is active. Captions are DOM nodes (in `#captions > .caps`, z-index 10) rebuilt
  when `timeline.version` changes; story time is `story.x`.
- **Layers** (`layer` tracks, `layers.js`): `{id, kind image|video|html|iframe, src | html, space screen|world, a, b,
  fade, z, w (% view or m), h, fit, interactive, loop, scrub, rate, billboard, keys[{t, ease, x,y | pos[3], s, r, o}]}`.
  Screen layers are `.layer` divs in `#captions > .lays` positioned in % with container units (cqw/cqh) and
  `z-index = z` (captions are 10); `pointer-events` only when `interactive`. World layers are `MeshBasicNodeMaterial`
  planes (renderOrder 15, created after the image/video loads, `fog:false`) in `layers.group`. Items are keyed by
  track id and only rebuilt when kind/space/src/html change, so videos / iframes don't reload on edits. A
  scrubbed video sets `currentTime = (x − a)·rate` — needs HTTP range support (tools/serve.* have it).
  `main.js` calls `layers.update(story.x, camera)` every frame.
- Editor (`?edit`, dynamically imported so the site doesn't load it): playhead `editor.time` (s) → pins
  `story.forceP = time / duration`; Play advances in real time × play speed (no smoothing). Edits mutate
  `timeline.data` directly → `editor.changed()` (live) / `editor.commit()` (undo snapshot = serialized JSON).
  Selection is held by object reference and re-resolved by index after undo. Every action that changes data
  must go through `isLocked()` / `guard()`. Context menus are built in `Editor.contextItems(target)`; menu bar in
  `menuFile/Edit/View/Help`. The Performance lane records fps per 0.5 s bucket. The Scene | Game state is
  `#ed[data-mode]` (scene / game / playing) → frame + badge colour.
- Saves (`saves.js` + `tools/serve.py`): Save → `POST /__editor/save` (server copies the previous story.json to
  `saves/auto/<stamp>.json`, keeps 100) → else File System Access picker → else download. Autosave (default 60 s,
  2 s after the last edit, per-browser setting). Checkpoints `POST /__editor/checkpoint?name=` →
  `saves/checkpoints/`. Restore lists `GET /__editor/list` (checkpoints, autos, `git log -- story.json`) and loads
  with `GET /__editor/load?file=|?git=` — loading is one undo step. Git: `git/status`, `git/commit` (only
  `story.json` + `saves/checkpoints` + `assets`), `git/push` (`-u origin HEAD` if no upstream; `GIT_TERMINAL_PROMPT=0`).
  Uploads: `POST /__editor/upload?name=` → `assets/<slug>.<ext>` (whitelisted extensions, never overwrites; an
  identical re-upload reuses the file). The server only reads/deletes `story.json` and `saves/**/*.json`; both
  servers answer byte-range GETs (206) — without them Chrome can't seek videos.
  Hooks it uses from `main.js`: `hidden` set (outliner), `setTimeScale` (sim speed / freeze), `capture()`
  (PNG of the next frame), `fpsInfo`, `onResize` (render size = `editor.viewSize()`), `setTunaCount`.
- "Copy ref" (`editor.reference()`) produces a text block like `@ 0:37.20 (t=37.20 s of 60 s, p=0.620), chapter
  "The 50" … active: tentacles.form 37% … camera: key #6 → #7 …`. When a user pastes one, map it to the tracks
  in `story.json`.

### Global uniforms (`shared.js` → `U`)
`time, under (camera below water 0/1), sunDir, sunColor, sunIntensity, camDepth, deep/mid/shallow`
(tropical palette, linear), `causticStrength, fogDensity`. Everything reads these; `main.js` updates them per frame.
`WATER_Y = 0`, `SEABED_BASE = -24`. `setSun(elevationDeg, azimuth = 0.9)` in `main.js` sets sun dir/colour/
intensity + light, hemi, env intensity; story calls it every frame.

### Water "50" (`tentacles.js`)
- `tentacleDefs()`: 4 stroke tentacles (5: top bar + upright; 5: bowl; 0: left half; 0: right half, overlapping
  so the 0 closes) — each = stem control points from the sea + stroke control points (`strokeFrom` = first
  stroke point) — plus 2 decorative curling tentacles. Final shapes: centripetal Catmull-Rom, resampled by
  arc length to SEG=256 points; `stemFrac` = stem length / total.
- `update(form, t)` (CPU, every frame while visible, 6×256 points): braid position (helix around x=0,z=−4,
  radius 4.2+, turning with time) lerped to the final shape by `m`; sway (fades with `m`) + breathing;
  parallel-transport frames; radius profile (stem 2.0→1.25, stroke 1.75, decor root→tip taper, ×0.72 while
  braiding); growth `g` with a rounded travelling tip; stem retraction with a rounded tail (`settle`).
  Uploaded to a `DataTexture` (RGBA32F, SEG × tentacles·3 rows: pos+radius, normal+arc length, binormal+g).
- Water tubes: one `InstancedMesh` (22 radial segments) — vertices read the texture with `textureLoad`.
  **Triangle winding must face outward** (it was inverted once: every pixel became rim glow). Shading: screen-space
  refraction of the scene (own HalfFloat copy) absorbed toward deep blue, flowing caustic veins up the tube
  (kept dim — bright veins bleach the tube white), glowing cyan Fresnel rim, faint sky reflection, sun glint.
- Gold threads: 2 thin helices per tentacle (`InstancedMesh`, radius 0.1) at 1.12× the tube radius, visible
  only in travelling stretches (`sin` mask) → glimpses. HDR amber, bloomed.
- Root foam: 420 sprites per tentacle churning around the texture sample 10 points up from the root.
- Precompiled at load (`tentacles.visible = true` during `compileAsync`) so there is no hitch when it appears.
- Cost: negligible in headless tests (60 fps cap held).

### Fish school (`swarm.js` — `FishSwarm`)
- Storage buffers (`instancedArray`): `pos` (xyz + swim phase), `vel` (xyz + speed), `state` (jumpers only),
  and when `targets` is given: `target` (vec4) + `origin` (last schooling position).
- Compute boids: separation/alignment/cohesion, personal goal offsets, soft box, floor/ceiling,
  up to 3 predators (uniform vec4 xyz+radius), cursor-ray scare. Neighbour scan is exhaustive up to
  256 fish, above that a rotating strided sample of 256 (cost stays flat as count grows).
- **Scripted leaps** (`targets = { launch, land }`, Float32Array(max·4) each, built by `flightTargets()` in story.js):
  launch = (x, y, z, w): `w < 0` plain schooling; `10 ≤ w < 11` "hoop" group (gate `u.hoop`); `20 ≤ w < 21`
  "free" group (gate `u.free`); `fract(w)` = loop phase. land = (x, y, z, apexY).
  Each fish loops on its own period (`leapPeriod` 14 s × 0.6–1.5): schooling, then a ballistic arc launch → land
  whose duration matches real gravity for that apex (+20%), easing in from its schooling position over the
  first 20%. `origin` is written only while schooling, so boids resume exactly where the leap ends.
  Surface crossings write `state` → splashes. Default: 14 hoop (idx 0–13), 70 free (idx 14–83), all < jumpers.
  Free leaps: 60% across the view (z 10–32), 20% toward/over the camera (z 18→64, apex 8–11), 20% from under
  the camera away toward the 50.
- Rendering: the skinned tuna GLB is **baked to a static bind pose** (`bakeModel`), canonicalised to
  forward=+Z, up=+Y, length 1, **simplified 6k → ~2.1k tris in story mode** (`simplifyGeometry`, meshoptimizer
  from jsDelivr via the import map), then drawn as ONE `InstancedMesh`. Story mode uses a plain standard
  material (lab keeps iridescence + clearcoat). Above water only the first 800 instances are drawn. A thunniform travelling wave
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
→ + **sky god rays** (above water: 24-sample radial blur toward the sun's screen position `uSunUV`, samples
clamped to 2.5, mask `smoothstep(0.9, 2.2, lum)` × "open" (depth == 1: sky only; fish, sea and the water tentacles occlude),
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
- Refraction copy textures must be `HalfFloatType` (scene target is rgba16float).
- The ocean grid needs a `normal` attribute even though the shader computes normals.
- `hash()` seeds: add `uint(...)`, never raw JS numbers derived from nodes.
- Additive materials must set `fog:false` and attenuate manually.
- Keep the camera away from exactly `y = wave height` (clamped to ±0.35 m).
- `main.js` has a `G` (loaded GLTFs) — don't shadow it.
- The HDR sun disk is ~40× the sky; anything screen-space that samples it must clamp or it whites out the frame.
- Plain `python -m http.server` refuses/resets connections under the page's parallel module + GLB burst (listen
  backlog 5) and has no Range support (videos can't seek). `tools/serve.py` fixes both; use that.
- Waterline: the camera is kept out of a ±0.35 m band around the surface, pushed *through* it in the direction of
  travel (`camY0` in the main loop). Pushing it back to the side it came from made the Scene camera "stick".
- **three r180 viewport-texture resize bug** (patched at the top of `main.js`): a `viewportTexture` copy used
  inside a render target is a clone sharing its `image` with the original, so after the canvas grows it never
  reallocates its GPU texture → out-of-bounds copy → every frame dropped (**black screen** after resize /
  fullscreen / in the editor viewport). The patch tracks each copy's size and sets `needsUpdate`. Keep it until
  three is upgraded and the bug is verified fixed (test: load at 1600×900, resize to 2000×860).
- In story mode the canvas has `pointer-events:none` (so the page scrolls); pointer listeners are on `window`.

## Ocean look (`ocean.js`, stylised)
- Above: two-tone body (deep teal at grazing → turquoise looking down), **clear water**: screen-space refraction of
  what's below (seabed, corals, fish) with per-channel Beer–Lambert absorption along the view-ray thickness
  (`exp(-(0.32, 0.06, 0.045)·d)`, red dies first) + body colour as in-scatter; Fresnel sky reflection *without*
  per-pixel clouds, crest glow (turquoise, warm when backlit), soft sun sheen + crisp star glints, thresholded foam
  (two caustic samples at unrelated scales/angles so it doesn't tile); 12 irregular fragment ripple waves, far
  normals calmed from 120 m. Underwater-only systems (seagrass, reef fish, jellies…) are still hidden above water.
- Below: widened, soft-edged Snell's window (eta 1.18 instead of 1.333, `smoothstep` on the refraction
  discriminant), bright rim at the window edge, turquoise rippled mirror (TIR) outside it.

## Performance reference

Measures (story mode): pixel ratio capped at 1.5 then **dynamic resolution** (`adaptResolution`: −15% after ~1 s
under 45 fps, down to 50%; +8% after ~3 s over 58 fps; label shows "% res"), **no shadow map** (`sun.castShadow
= LAB`), tuna simplified + standard material, only 800 tuna drawn above water, underwater-only systems
(seagrass, jellies, bubbles, snow, reef fish) hidden and not simulated when above water, seagrass 14k,
snow 16k, jellies 220, reef fish 400, sky rays 24 taps.

Headless Chrome on the dev Mac, 1360×780, `?noauto`, 2000 tuna: underwater ~47 fps, whole above-water act
60 fps (capped). Before these changes: ~20 fps, and the ray-marched 50 froze an M1 Air.
Biggest remaining cost: drawing 2000 tuna underwater (vertex-bound). Next lever: GPU culling / distance LOD.

## Testing

No test suite. Verify in a real browser. **Don't pop up browser windows on the owner's screen**: run ONE
persistent headless Chrome and reuse it (headless WebGPU works on macOS/Metal and Windows/D3D12):

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --enable-unsafe-webgpu \
  --remote-debugging-port=9333 --user-data-dir=<scratch>/chrome-profile --window-size=1360,780 about:blank
# Windows: "/c/Program Files/Google/Chrome/Application/chrome.exe" with the same flags
```

Then a puppeteer-core script (`puppeteer-core@19` works with Node 16) does
`puppeteer.connect({ browserURL: 'http://127.0.0.1:9333' })`, reuses the first tab, **`page.setCacheEnabled(false)`**
(otherwise stale JS modules are served), loads `?noauto`, waits for
`window.__ocean` + loader hidden, sets `__ocean.story.forceP = p` for each progress point, waits ~2.5 s,
screenshots, collects console errors, then navigates the tab to `about:blank` and disconnects.
Lab shots: `__ocean.director.shotIndex = n - 1; __ocean.director.next()`.
`window.__ocean` exposes camera, controls, tuna, reef, sharks, turtles, director, story, tentacles, timeline, opts,
buildPost, renderer, scene, systems, and in `?edit` the `editor` (`editor.setTime(s)`, `setView('scene'|'game')`,
`select({kind:'key', track, item})`, `addKey()`, `toggleLock()`, `copy()/paste()`, `setDuration(s)`, `undo()`,
`saves.save()`, `reference()`, `contextItems(target)`, `perf`).
Editor checks: drive it with real mouse/keyboard events (scrub the ruler canvas, K, Ctrl+Z, drag a clip, Space)
and back up `story.json` first if a test saves (and delete the `saves/` files a test creates). Also test a resize to a wider aspect (black-frame regression).
WebGPU validation errors don't reach the console — attach `renderer.backend.device.addEventListener('uncapturederror', …)`
when a frame renders black.

Before claiming a visual change works: screenshot the affected progress points and check zero console errors.
