# Handoff — Open Tuna / Thai Union 50th anniversary pitch

Last updated: 2026-10-01. Technical reference lives in `CLAUDE.md`; this file is the *why*, the
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
3. Above the sea, **multiple streams of water rise like tentacles, twisted together like a vortex, then fly
   and forge the "50"** — smooth and seamless with the scroll, nothing appearing randomly. Visual reference
   from the owner: glossy translucent blue water tentacles with glowing rims rising from a foaming sea.
   The 50 is water — **not all gold**: glimpses of golden thread. Golden-hour light.
4. Tuna are the gimmick: **most leap around / across the camera**; only **some** leap through the hole of the 0.

This first draft only covers the opening. More chapters (history timeline, sustainability, brands, etc.)
are expected but not defined yet — ask the owner.

### Decisions & feedback so far
- ❌ **A 50 formed by tuna** (tuna turning gold and holding the digit shape) — rejected, "uncanny".
- ❌ **A ray-marched solid golden-water 50 rising out of the sea** (v2) — rejected: it froze the owner's
  M1 Air when it emerged, read as golden jelly, and "rising block" wasn't the idea. Replaced by the particle vortex.
- ❌ **Particle water vortex** (v3: whirlpool → waterspout → particle "50" with gold eddies) — "just a giant
  tornado", particles read as glitter; owner wants tentacle-like streams (reference image). Replaced by tube tentacles.
- ❌ "Thai Union" hero label and "Thai Union · Fifty Years" end title — removed, "not professional".
- ❌ Lots of tuna leaping through the 0 — only a few should; most leap across the camera.
- ✅ Must run smoothly on mid-range devices (customer doesn't care about perf numbers, but lag kills the pitch).
- ✅ Stylised ocean; sky visible from underwater; don't polish the seabed / underwater caustics.
- ✅ Scroll-scrubbed and fully reversible (a pitch audience scrolls back and forth).
- ✅ Dropped the 56 MB photogrammetry reef + 32 MB starfish.
- ✅ Default 2000 tuna.
- Caption copy ("Fifty years of the open ocean", "It all begins beneath the surface", "Rising, together") is
  **placeholder** written by Claude — replace with real copy. No end caption now; the 50 is the finale.
- Brand assets (logo, colours) not provided yet — generic styling (Cormorant Garamond + Inter, gold end title).

## Current state

Working end to end, zero console errors, 60 fps (capped) above water / ~47 fps underwater in headless tests:
- Story mode default; 900vh scroll; captions fade by progress window.
- Underwater act: school, sharks, whales, jellies, particles, god rays; stylised Snell's window shows the sky.
- Ascent through a stylised sea; sun swings from midday to a low golden sun left of the 50 (never crossing the frame).
- Water tentacles: six translucent blue tubes with glowing rims braid up out of the foaming sea, unfurl,
  and four of them draw a monoline "50" with their tips (two curl beside it); stems then retract so the 50
  floats. Golden threads spiral around the water in travelling glimpses.
- ~70 tuna leap across / over / away from the camera on staggered loops, 14 leap through the 0 once it exists.
- Performance measures: see CLAUDE.md → Performance reference (dynamic resolution, no shadows in story,
  simplified tuna, underwater-only systems culled above water, etc.).

## Known issues / next steps (priority order)

1. **Owner review of the tentacle look** vs the reference — shapes of the digits (hand-placed control points in
   `tentacleDefs()`), braid height/timing, tube thickness, how much gold, whether stems should stay attached.
   Ideas: fish-like heads / fins on the side tentacles (reference), spray peeling off fast-moving tips, water
   droplets dripping from the 50, a bright pulse racing through the strokes when the 50 completes.
2. **Underwater perf** is now the heaviest part (~47 fps headless at 1360×780): 2000 tuna are vertex-bound.
   Options: GPU frustum/distance culling with indirect draws, a second lower-LOD mesh for far fish, or ~1500 tuna.
3. Real-device check on the M1 Air (and a mid-range Windows laptop) with auto-resolution on.
5. Sky god rays above water are subtle; could add a few light-shaft cards behind the 50 (cheap).
7. Loading: ~25 MB of GLBs, loader says "OPEN OCEAN" — rebrand, consider Draco/Meshopt compression.
8. Mobile / non-WebGPU: error panel only (owner rule: no WebGL fallback).
9. Later story chapters (TBD with the team).

## Tuning knobs (where to change things)

- Timeline windows: `src/story.js` → `Story.update` (all `range(p, a, b)` calls) + `data-in/out` on `.cap` in `index.html`.
- Water 50: `tentacleDefs()` control points (digit shapes, stem roots, decor tentacles); in `update()` — braid
  radius/pitch, `m`/`g`/`settle` timing, sway, radius profile; tube shading + gold thread mask in `tentacles.js`.
- Tuna leaps: `flightTargets(G, max, { hoop, free })` + the three free-leap types in `story.js`; `leapPeriod` in `swarm.js`.
- Sun path: `setSun(elevation, azimuth)` call in `Story.update`.
- Ocean look: above/below branches of the colour node in `ocean.js`.
- Perf: `MAX_PR`, `adaptResolution` thresholds, story-mode counts, tuna `simplifyGeometry` ratio (0.35) — all in `main.js`.

## Dev setup on a new machine

```sh
git clone https://github.com/ItipatS/open-tuna && cd open-tuna
python3 -m http.server 8123   # open http://127.0.0.1:8123 in Chrome/Edge and scroll
```
Pushing to `main` redeploys GitHub Pages publicly (https://itipats.github.io/open-tuna/) — use a branch
if the pitch shouldn't be public yet. Testing approach (headless persistent Chrome + puppeteer) is in `CLAUDE.md`.
