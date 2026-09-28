# Handoff — Open Tuna / Thai Union 50th anniversary pitch

Last updated: 2026-09-29. Technical reference lives in `CLAUDE.md`; this file is the *why*, the
current state, decisions made, and what to do next.

## The goal

An over-the-top interactive website for **Thai Union's 50th anniversary** (founded 1977 → 2027),
in the spirit of National Geographic / Amazon showcase pages — for the Sealect / Thai Union brand.
It's an **internal sales pitch / mock-up**, still being discussed within the team.

- Audience: the client pitch, not the public (yet). Visual extravagance > performance > compatibility.
- Why WebGPU: the team has no Blender artist for a pre-rendered film, and AI-generated video is ruled out.
  Real-time WebGPU gives cinematic visuals, interactivity, and scroll control.
- The original project was a "playground" (sliders, orbit camera, shot loop). It's being turned into a
  **scroll-driven story**. The playground still exists at `?lab`.

## The story (first draft, from the owner)

1. Open underwater: thousands of tuna and marine life (sharks hunting, whales, turtles, jellies, reef).
2. Scrolling moves the camera **up** out of the water (not down).
3. Above the sea: a **"50" made of water — golden water — with god rays**, rising out of the ocean.
4. Tuna are the gimmick around it: normal breaching, **leaping through the hole of the 0 / past the 50**,
   some **swimming inside** the water 50, swarming.

This first draft only covers the opening. More chapters (history timeline, sustainability, brands, etc.)
are expected but not defined yet — ask the owner.

### Decisions & feedback so far
- ❌ **A 50 formed by tuna (tuna turning gold and holding the digit shape) was rejected — "uncanny".**
  The 50 must be water. Tuna stay tuna.
- ✅ Scroll-scrubbed and fully reversible (a pitch audience scrolls back and forth).
- ✅ Dropped the 56 MB photogrammetry reef + 32 MB starfish; procedural seabed/corals/seagrass are enough.
- ✅ Default 2000 tuna (M1 Air handles it).
- Caption copy ("Fifty years of the open ocean", "It all begins beneath the surface", "Rising, together",
  "1977 — 2027 / Thai Union · Fifty Years") is **placeholder** written by Claude — replace with real copy.
- Brand assets (logo, colours) not provided yet — generic styling for now
  (Cormorant Garamond + Inter, gold gradient end title).

## Current state (working, uncommitted at time of writing)

Working end to end, zero console errors:
- Story mode default; 900vh scroll; captions fade by progress window.
- Underwater act unchanged from the playground (school, sharks, whales, jellies, particles, god rays).
- Ascent through the surface; sun animates midday → golden hour behind the 50.
- Ray-marched water "50" (SDF from text) rises from the sea with liquid tendrils that snap, drips,
  flowing surface, refraction, gold absorption, back-lit glow, sun glitter on the sea behind it.
- ~90 tuna ride inside the glyph; ~140 tuna loop-leap through the 0 (splashes on surface crossings).
- Above-water sky god rays (screen-space radial blur toward the sun).

Screens looked at (progress p): 0 (hero underwater, good), 0.62 (rising), 0.72 (tendrils, golden hour),
0.95 (final reveal).

## Known issues / next steps (priority order)

1. **Water material reads as frosted golden jelly**, not clear water. Ideas: much lower absorption +
   stronger refraction offset, chromatic dispersion, sharper spec, internal caustic light instead of flat
   scatter, less uniform milky "scatter" term, darker/clearer core with bright gold rim & edges.
   Fish inside currently look like gold flakes (absorption tint) — could be kept as a stylistic choice.
2. **God rays above water are too subtle** after taming (first version whited out the screen). Options:
   raise `uSkyRayK`, add volumetric light-shaft cards/cones behind the 50, raise glyph contribution to the mask,
   add airborne gold dust/sparkle particles lit by the rays.
3. **Hoop leaps**: fish bunch into dark clumps in the hole; spread phases/lanes, fewer at once, bigger arcs,
   maybe a few fish arcing *over* the 5 or diving through the body of the water (in one side, out the other).
4. More water spectacle: splash/foam ring where the glyph exits the sea, spray sheet off the rising glyph,
   water streaming down its surface (flow noise direction), mist.
5. Final caption overlaps the bottom of the 50 on 16:9 — reframe camera or move the caption.
6. Real-window perf check on M1 Air (headless numbers are unreliable ~20 fps); if needed lower glyph
   ray-march steps, render scale, or seagrass/jelly counts in story mode.
7. Loading: still ~25 MB of GLBs, loader copy says "OPEN OCEAN" — rebrand the loader, consider
   Draco/Meshopt compression, progressive loading.
8. Mobile / non-WebGPU: error panel only (owner rule: no WebGL fallback). Fine for an internal pitch.
9. Later chapters of the story (TBD with the team).

## Tuning knobs (where to change things)

- Timeline windows: `src/story.js` → `Story.update` (all `range(p, a, b)` calls) + `data-in/out` on `.cap` in `index.html`.
- Glyph text/size/position: `bakeGlyph({ text, width, bottom, thick })` in `main.js`; font in `glyph.js`.
- Water look: `createWaterGlyph` in `glyph.js` (absorption `trans`, `scatter`, rim, `back`, noise amplitude 0.32, R=0.9).
- Tuna stunts: `flightTargets(G, max, { inside, hoop })` in `story.js`; `hoopPeriod/hoopAir/hoopReach` uniforms in `swarm.js`.
- Sky god rays: `skyRays` in `main.js` (`uSkyRayK`, threshold, decay 0.965, 56 samples).
- Sun path: `setSun(elevation, azimuth)` call in `Story.update`.

## Dev setup on a new machine

```sh
git clone https://github.com/ItipatS/open-tuna && cd open-tuna
python3 -m http.server 8123   # open http://127.0.0.1:8123 in Chrome/Edge and scroll
```
Pushing to `main` redeploys GitHub Pages publicly (https://itipats.github.io/open-tuna/) — use a branch
if the pitch shouldn't be public yet. Testing approach (headless persistent Chrome + puppeteer) is in `CLAUDE.md`.
