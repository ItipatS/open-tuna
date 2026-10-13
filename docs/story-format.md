# story.json reference (version 2)

`story.json` is the whole story's timing and content. Code: `src/timeline.js` (model, evaluation, migration,
serializer), `src/story.js` (what each binding does), `src/layers.js` (layers). The site reads it at load. The
editor reads it, edits it in memory, and saves it (see [editor.md](editor.md), [dev-server.md](dev-server.md)).

**Time.** Everything is in **seconds of story time `x`** (0 … `meta.duration`). On the website, scroll progress
`p` (0..1, smoothed with `p += (target − p)·(1 − e^(−2.4·dt))`) maps to `x = p · duration`. All story state is a
pure function of `x` (plus simulation time for idle motion, fish, waves), so scrolling back rewinds. The creatures
and the school are simulated, so they converge rather than jump.

## Top level

```jsonc
{
  "version": 2,
  "meta": { "title": "…", "duration": 150, "scrollPerSecond": 15 },  // page height = duration × scrollPerSecond vh
  "settings": { "tunaCount": 2000, "params": { "post.exposure": 1.05, … } },  // constants for PARAMS
  "chapters": [ { "t": 0, "name": "Underwater" }, … ],   // labels for people (editor ruler, Copy ref)
  "notes": [ { "t": 60, "text": "…" } ],                  // feedback left at moments — read them when asked
  "tracks": [ … ],                                          // drawn top to bottom in the editor, see below
  "sources": [ { "id": "products", "url": "https://…", "refresh": 60, "sample": { … } } ]  // live data, see below
}
```
In a `.tuna` project the file is `projects/<slug>/story.json`, and `assets/…` paths are relative to that folder
([projects-build-data.md](projects-build-data.md)).
Version 1 files (positions as progress 0..1) are migrated on load (`migrate()` in timeline.js).

Common track fields:
- `id` — unique.
- `type`
- `label` — the name shown in the editor.
- `mute: true` — ignored by the story.
- `locked: true` — the editor won't change it. Respect it.
- `collapsed: true` — a thin row in the editor.
- `parent: <group id>` — the group it belongs to.
- `lane: <lane id>` — the lane it's drawn in (layers and paths only).

Keys and clips can carry `locked: true` too. **Muting or locking a group or lane applies to everything in it**:
use `tl.muted(t)` / `tl.lockedTrack(t)`, not the raw flags.

## Track types

### camera
```json
{ "id": "camera", "type": "camera", "label": "Camera", "drift": 1,
  "keys": [ { "t": 0, "pos": [-23.17, -9, 11.79], "look": [0, -9, 0], "follow": 1, "fov": 50 }, … ] }
```
- Position and look-at use a cubic Hermite spline through the keys in `t`, flat at both ends.
- `follow` (0..1) blends the look-at toward the tuna school's goal.
- `fov` is in degrees and eases between keys.
- `drift` scales a slow hand-held sway.
- World units are metres: the sea surface is at y = 0, the seabed at about −20 to −24, and the water 50 stands at
  z = 0 (x −19..19, y 2..24).

### curve
`{ type: "curve", bind: <PARAMS id>, keys: [ { t, v, ease } ] }` animates a scalar parameter. A key's `ease`
(`smooth` | `linear` | `in` | `out` | `hold`) shapes the segment *after* it. Without a curve, the parameter uses
`settings.params[id]`, or else its default.

**PARAMS** (`src/story.js`):

| id | Meaning | Default |
|---|---|---|
| `sun.elevation` / `sun.azimuth` | degrees | 55 / 51.6 |
| `post.exposure` / `post.bloom` | tone-mapping exposure / bloom strength | 1.05 / 0.28 |
| `post.skyRays` / `post.underRays` | god-ray strength above / below water | 0.6 / 0.34 |
| `sea.state` | wave amplitude | 0.45 |
| `water.clarity` | 0..1 (fog density) | 0.7 |
| `school.cursor` / `school.predators` | how much the tuna flee the cursor / predators | 0 / 1 |

### clip
`{ type: "clip", bind: <DRIVERS id>, a, b, ease }` drives a story beat. Across [a, b] it gives a 0→1 ramp shaped by
`ease`. With `ease: "gate"` it is 1 inside and 0 outside (`b ≥ duration` means until the end).

**DRIVERS**:

| id | Meaning |
|---|---|
| `school.gather` | the school gathers in front of the 50 (ramp) |
| `tentacles.fade` / `tentacles.form` | the water 50 fades in / forms: braid → unfurl → draw → settle (ramp) |
| `tuna.free` / `tuna.hoop` | tuna leap across / over the camera, and through the 0 (gates) |

### captions
`{ type: "captions", clips: [ { a, b, title, sub, size: "large"|"medium", y: <% from top>, fade } ] }`.
- `title` keeps `\n` line breaks.
- `a ≤ 0` means visible at load.
- Captions are DOM text over the canvas (z-index 10).

### path
A creature follows waypoints while `x ∈ [a, b]`, with **priority** over its own behaviour.
```json
{ "id": "demo-school-path", "type": "path", "label": "School route", "bind": "school", "lane": "lane-creatures",
  "a": 70, "b": 122, "blend": 4, "keys": [ { "t": 72, "pos": [30, -6, 4] }, … ] }
```
- **`bind` (ACTORS):** `school`, `bluewhale`, `humpback`, `shark1`, `shark2`, `turtle1`, `turtle2`.
- **Creatures** swim onto the route at their own speed and face their direction of travel. When the clip ends they
  resume their own behaviour from where they are.
- **The school's goal** blends to the route over `blend` seconds. While it's on the path, the school tightens up
  and ignores predators and the cursor.
- **Keep fish under water** (y < 0). Whales at y ≈ −2.5 swim *at* the surface.

### layer
Media / text / glass / GUI / 3D model clips. Rendered by `src/layers.js`.

| Field | Applies to | Meaning |
|---|---|---|
| `kind` | all | `image` `video` `text` `glass` `model` (GPU) · `html` `iframe` (DOM) |
| `src` | image, video, iframe, model | a path under `assets/`, or a root `*.glb` model |
| `html` | html | any HTML (inline styles) |
| `kicker` `title` `body` `size` `align` `color` | text | drawn into a canvas with the page fonts (`size` = headline px at 2048 px width) |
| `space` | | `screen` (follows the camera, positions in % of the view) or `world` (in the 3D scene) |
| `render` | image, video on screen | `gpu` (in the scene, shader effects) or `dom` (plain HTML overlay) |
| `a` `b` `fade` | all | visible window and fade / reveal time (s) |
| `w` `h` | | width / height: % of the view (screen) or metres (world, model). `h` 0 / missing = from the media's aspect |
| `depth` | GPU screen | metres in front of the camera. Fish nearer than this swim in front of it |
| `z` | DOM | stacking order (captions are 10) |
| `interactive` | DOM | clickable for visitors |
| `fit` | DOM image / video | `contain` / `cover` / `fill` |
| `loop` `scrub` `rate` | video, model | `scrub`: playback follows story time (scrolling plays and rewinds it; default for models) |
| `reveal` | GPU | `fade` `dissolve` `wipe` `ripple` |
| `distort` `caustic` `chroma` `glow` `glass` | GPU | 0..1 effect amounts (`glow` up to 3). `chroma` grows with scroll speed. `glass` = frosted glass refracting the scene behind |
| `radius` `tint` | glass | corner radius (uv units) / glass tint colour |
| `billboard` | world image / video / text | false = fixed facing (rotate with key `r`) |
| `flip` `anim` | model | flip facing / animation name (`none` = still; default = first clip) |
| `keys` | all | screen: `{t, ease, x, y, s, r, o}` (x / y in % of the view, r °, o opacity) · world: `{t, ease, pos[3], s, r, o}` · model: `{t, ease, pos[3], rot[3]° (YXZ), s, o}` |

All numeric and array key fields are interpolated (`evalKeys`). A layer with one key just sits still. The editor's
parallax preset writes two linear keys (start / end).

### group / lane (editor organisation)
```json
{ "id": "group-demo", "type": "group", "label": "Demo — The Journey", "collapsed": false },
{ "id": "lane-cards", "type": "lane", "label": "Cards", "parent": "group-demo" }
```
Tracks join a group with `parent`. Layers and paths join a lane with `lane`; a lane draws many clips in one row,
stacking overlaps. The order of `tracks` is the display order: a group's members appear under its header, and
lane members can sit anywhere in the array. These have no effect on the story except inherited mute / lock.

## sources (live data) and {{bindings}}

`sources: [{ id, url?, headers?, refresh?, sample? }]`: JSON loaded at runtime (`src/data.js`). A relative `url` is a
story file (`assets/data.json`); an absolute one must allow CORS. `refresh` = re-fetch every n s. `sample` = a saved
copy, shown first and kept if the fetch fails. `headers` are public (read-only tokens only).

Text fields can bind to them: `{{id.path}}` or `{{id.path | fallback}}`, with a path of `.key` / `[index]` parts,
e.g. `{{products.items[0].name | Coming soon}}`. This is resolved in layer `title`, `kicker`, `body`, `html`, `src`
and caption `title`, `sub`. Details: [projects-build-data.md](projects-build-data.md).

## The current story (approximate; the file is the truth)

| Time (s) | Chapter | What happens |
|---|---|---|
| 0 – 18 | Underwater | camera arcs around the school at y ≈ −9; hero caption |
| 13 – 27.6 | | the school gathers to (0, −4.5, 18) |
| 18 – 30 | Ascent, Surface | the camera rises and breaks the surface at ~26 s; the sun sinks to golden hour (24 – 39.6) |
| 25.8 – 27.6 / 26.4 – 55.2 | The 50 | the water 50 fades in / forms (braid → unfurl → draw → settle) |
| 30 – 60 / 50.4 – 60 | Finale | tuna leap across and over the camera / through the 0 |
| 60 – 150 | The Journey (demo) | the camera dives and rides with the school along a route (path), the blue whale passes, a parallax shader title + huge background type, glass cards, 3D billboards, and at the surface the humpback plus a glass product panel, an HTML button and an iframe page |

## Serialization

`Timeline.serialize()` writes readable, diff-friendly JSON: short objects (keys / clips) on one line, and numbers
rounded to 4 decimals. `*.json` is `eol=lf` (`.gitattributes`). The save-conflict check hashes the exact bytes.
