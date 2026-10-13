# Working on Open Tuna as an AI agent

Recipes for the requests that come up. Read [CLAUDE.md](../CLAUDE.md) first (hard requirements, working rules).

## How requests arrive

The owner and the designer work in the editor (`?edit`) and talk to you in three ways:

1. **A pasted "Copy ref" block.** The editor's *Copy ref* button describes the exact moment they are looking at:
   ```
   Open Tuna — story.json @ 1:37.20 (t=97.20 s of 150 s, p=0.648), chapter "Along the route"
   active: sun.elevation=42.00 · tentacles.form 100% (26.4–55.2 s) · …
   camera: key #12 (t 90) → key #13 (t 100); at [6.1, -6.0, -40.2] looking at [-3.9, -7.0, -31.5]
   paths active: school "School route (demo)" (100%, 70–122 s, 5 waypoints)
   layers on screen: "Card 2 (glass, shader)" (image assets/demo/card-2-clear.svg, screen x 76% y 47%, …) · …
   selected: key on track "Camera" at t 90
   fps here: 48 · view: Game 16:9 · unsaved changes: no
   ```
   Map it to `story.json`. `t` is story time in seconds. Tracks, keys and clips are found by their times and
   labels, and layer / path entries carry their `label` and `src`. "Camera key #12" is the 12th key (1-based) of
   the `camera` track.
2. **Notes** in `story.json` → `notes: [{ t, text }]`, left at moments ("tentacle pops in here, should grow
   smoothly"). When asked to "check the notes", read them all, act on each, and tell them which ones you handled.
   Delete or update a note only when asked.
3. **Plain requests**, sometimes with screenshots. Find the moment with the chapters (`story.json` → `chapters`)
   and the story table in [story-format.md](story-format.md).

## Editing story.json safely

**Which story?** A Copy ref starting `Open Tuna — project "Name" (projects/<slug>/story.json)` is a .tuna project:
edit that file (its assets are in `projects/<slug>/assets/`). The designer must then press Ctrl+S to write it into
their .tuna file. If they send a `.tuna` itself, it's a zip: unzip it, edit `story.json`, zip it back (keep
`manifest.json`). Otherwise it's the repo's `story.json`. See [projects-build-data.md](projects-build-data.md).

The designer may have the editor open, and it **autosaves story.json about every minute**.

1. `git diff -- story.json` first. Uncommitted changes there are the designer's work. Keep them.
2. Edit the current file. Prefer a small Node script that loads it through the project's own `Timeline` class and
   writes `tl.serialize()`, so the formatting stays canonical (one key / clip per line, 4 decimals):
   ```js
   // node edit.mjs   (copy src/timeline.js next to it as tl.mjs, or import it by path)
   import fs from 'fs';
   import { Timeline } from './src/timeline.js';
   const tl = new Timeline(JSON.parse(fs.readFileSync('story.json', 'utf8')));
   const cam = tl.data.tracks.find((t) => t.type === 'camera');
   cam.keys.push({ t: 64, pos: [10, 6, 44], look: [0, 10, 0], follow: 0, fov: 50 });
   tl.changed();                                  // re-sorts keys, rebuilds indexes
   fs.writeFileSync('story.json', tl.serialize());
   ```
   Hand edits are fine too, as long as the result stays valid JSON with the same field names.
3. **Respect `locked: true`.** The designer locked those items. Don't change them unless asked to.
4. After writing, tell the user: *"reload the editor, or choose **Load theirs** when it says story.json changed"*.
   The server refuses saves from a tab that loaded an older file (409), so nothing is silently lost. But until
   they reload, their tab shows the old story.
5. Keep backups for yourself in your scratch space if you run destructive scripts. **Never** delete `saves/auto/*`.

## Common changes

| Request | Where |
|---|---|
| Timing of anything (when the 50 forms, leaps start, captions…) | `story.json`: clip `a`/`b`, key `t`, caption `a`/`b` |
| Camera path / framing | `story.json` `camera` track keys `{t, pos, look, follow, fov}` |
| Caption text | `story.json` `captions` clips `{title, sub, size, y}` |
| Sun, exposure, bloom, god rays, sea state, clarity, fish reactions | `PARAMS` constants in `settings.params` or a `curve` track |
| A creature should swim somewhere at some time | a `path` track ([story-format.md](story-format.md#path)) |
| An image / video / text / glass panel / web page / GUI over or in the scene | a `layer` track ([story-format.md](story-format.md#layer)) |
| A 3D model (GLB) appearing / moving at some time | a `layer` with `kind: "model"` |
| How the water 50 looks / grows | `src/tentacles.js` ([architecture.md](architecture.md#the-water-50)) |
| How fish school / leap | `src/swarm.js`, `flightTargets()` in `src/story.js` |
| Ocean look | `src/ocean.js` ([architecture.md](architecture.md#ocean)) |
| An editor feature | `src/editor/*` ([editor.md](editor.md)), then document it in EDITOR.md |

## Recipe: a new kind of story beat

The rule is that timing lives in `story.json` and behaviour lives in code.

- **A 0..1 ramp or an on/off gate** (e.g. "jellies glow brighter from 1:10 to 1:20"):
  1. Add `'jellies.flare': 'Jellies flare (ramp)'` to `DRIVERS` in `src/story.js`.
  2. In `Story.evaluate`, read `const v = tl.clip('jellies.flare', x)`. It returns 0 when there's no track or the
     track is muted, so the code must work with 0. Apply `v`.
  3. Add the track to story.json: `{ "id": "jelly-flare", "type": "clip", "label": "Jellies flare", "bind": "jellies.flare", "a": 70, "b": 80, "ease": "smooth" }`
     (put it in a group with `"parent": "group-beats"`). Or let the designer add it with **+ Track…**.
- **A scalar parameter the designer can animate**:
  1. Add an entry to `PARAMS` in `src/story.js` (`label, def, min, max, step`).
  2. Add a setter in `applyParam` in `src/main.js`. `Story.evaluate` calls every setter each frame with
     `tl.param(id, x, def)`.
  3. Optionally set a constant in `story.json` `settings.params`.
- **A new steerable creature**: add it to `ACTORS` in `src/story.js` and to the `actors` object in `src/main.js`
  as `{ obj, swim | hunter, speed }`. Path tracks with that `bind` then drive it.

## Recipe: add a layer or model clip by hand

Layers live in **lanes** (rows in the editor). Pick an existing lane id (`"type": "lane"` entries) or add one.
```json
{ "id": "lane-hero", "type": "lane", "label": "Hero", "parent": "group-demo" },
{ "id": "layer-logo", "type": "layer", "lane": "lane-hero", "label": "Logo", "kind": "image", "src": "assets/logo.png",
  "space": "screen", "render": "gpu", "depth": 8, "a": 64, "b": 72, "fade": 1.2, "w": 30,
  "reveal": "dissolve", "distort": 0.2, "caustic": 0.4, "chroma": 0.25, "glow": 0, "glass": 0,
  "keys": [ { "t": 64, "x": 50, "y": 40, "s": 1, "r": 0, "o": 1 } ] },
{ "id": "model-shark", "type": "layer", "lane": "lane-hero", "label": "Shark pass", "kind": "model",
  "src": "model_54a_-_caribbean_reef_shark.glb", "space": "world", "a": 80, "b": 90, "fade": 1, "w": 4,
  "keys": [ { "t": 80, "pos": [-20, -6, -10], "rot": [0, 90, 0], "s": 1, "o": 1 },
            { "t": 90, "pos": [20, -5, -14], "rot": [0, 90, 0], "s": 1, "o": 1 } ] }
```
Files must be under `assets/` (or be the root `.glb` models). Field reference: [story-format.md](story-format.md#layer).
Use HTML layers (`kind: "html"` / `"iframe"`) only for things visitors click.

## Verifying

Always do this before saying something works ([testing.md](testing.md)):
- Screenshot the moments you changed (`?noauto`, `__ocean.story.forceP = t / duration`). For creatures and the
  school, give them a few seconds to settle.
- Check zero console errors **and** zero WebGPU `uncapturederror`s (a black frame usually means a dropped command
  buffer).
- When rendering changed, compare fps against the previous commit in the same session, after warm-up. Headless
  numbers are noisy, especially while the designer's own editor tab is using the GPU.

## Committing and deploying

- Commit with a clear message. **Pushing to `main` publishes the site.** The owner wants work on `main`; mention
  each push.
- The editor's own git button commits only `story.json`, `saves/checkpoints` and `assets`. Your commits include code.
- Update docs (this folder, EDITOR.md, HANDOFF.md) in the same commit as the behaviour they describe.
