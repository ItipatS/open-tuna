# Editor internals (`src/editor/`, loaded only by `editor.html`)

The designer's guide is [EDITOR.md](../EDITOR.md). This doc covers how the editor is built.

## Modules

| File | Role |
|---|---|
| `editor.js` | `Editor`: DOM shell (top bar + project button, left Scene / Assets / Data tabs (`showTab`), viewport, inspector, timeline, resizable panels), menus (`menuFile/Edit/View/Help`), right-click menus (`contextItems(target)`), selection, locks, clipboard, undo, play modes, keyboard, Copy ref (`reference()`), groups / lanes (`addGroup`, `addLane`, `defaultLane`, `removeContainer`, `groupMenu`, `laneMenu`), path waypoints (`addPathKey`) |
| `timeline-view.js` | `TimelineView`: one canvas covering the ruler (chapters, notes, playhead, END flag), rows (`layout()`: groups → indented members, lanes with clips packed into sub-rows by `pack()`, collapsed rows → `drawSummary`), the performance lane, hit testing (`hit` → `hitBar` / `hitTrack`), dragging (scrub, keys, clip edges / body incl. moving between lanes, END, markers), snapping, zoom / pan, drops of files / assets |
| `inspector.js` | `Inspector`: property panels per selection (project, track, group / lane `container`, key, caption, chapter, note, layer + layer key, path + waypoint, object). Field widgets bind getters / setters; `input` = live (`ed.changed()`), `change` / drag end = undo step (`ed.commit()`); read-only when locked |
| `layer-tools.js` | `LayerTools`: add layers (file / URL / HTML / text / glass / model / asset), `LOOKS` presets, parallax, auto-key (`keyAt`), Game-view picking / dragging / scaling (DOM layers by element, GPU layers by `Layers.rect`), drops on the viewport / timeline (`dropOnTimeline`) |
| `assets-panel.js` | `AssetsPanel`: grid of `GET /__editor/assets` (assets/ plus the built-in root GLBs), drag source (`application/x-opentuna-asset`), upload, usage count, delete |
| `scene-gizmos.js` | `SceneGizmos`: camera path line, camera keys (blue) / look targets (orange), path lines + waypoints (lime), shot frustum, `TransformControls` on a proxy: camera key pos / look, path waypoint, 3D layer pos (auto-key), model rotation (`layerMode`) |
| `saves.js` | `Saves`: save with conflict detection, autosave, checkpoints, Restore dialog, import / export, browser draft, upload, git dialog. All calls go through `editorAPI()` (adds `&project=`); a manual save in a project then calls `project.saveTuna()` |
| `project.js` | `ProjectFiles`: .tuna pack / unpack (fflate), open (picker, Ctrl+O, drop), save / save as (File System Access handle in IndexedDB), new (blank / copy), Projects dialog, `busy()` progress — [projects-build-data.md](projects-build-data.md) |
| `build.js` | `SiteBuilder`: File ▸ Build site — collects the runtime (import crawl from `src/main.js`, no `src/editor/`), models, used assets → zip / folder |
| `data-panel.js` | `DataPanel`: the left **Data** tab — sources, status, JSON tree, binding menu, sample / headers dialogs |
| `thumbs.js` | `ModelThumbs`: turntable previews of GLBs rendered on the editor's renderer (24 frames into a webp strip, Cache API), `spin(asset)` element |
| `menu.js` | context menus / drop-downs (`openMenu`), modal dialogs (`dialog`) |
| `dom.js` | `h()` element helper, icons, `btn`, `download` |
| `editor.css` | the dark shell; mode colours via `#ed[data-mode]` (scene / game / playing) |

## Data flow

- The editor mutates `timeline.data` (the parsed story.json) **directly**.
- `editor.changed()` is for live edits: it re-sorts, bumps `timeline.version`, and redraws. Views and the runtime
  rebuild from `version`.
- `editor.commit()` ends an edit: it pushes an undo snapshot (the serialized JSON, max 300), writes the browser
  draft, and refreshes the inspector.
- **Undo / redo** restore a snapshot with `tl.set()`. The selection is held by object reference, so it is mapped
  to indices first (`selPath` / `resolve`).
- **Locks:** every mutating action must check `isLocked(sel)` / `guard()`. Locks are inherited from the lane /
  group (`tl.lockedTrack`).
- **Selections:**

  | Selection | Shape |
  |---|---|
  | track (including groups, lanes, and a layer / path clip as a whole) | `{kind:'track', track}` |
  | camera / curve / layer / path key | `{kind:'key', track, item}` |
  | caption | `{kind:'clip', track, item}` |
  | chapter / note | `{kind:'chapter'\|'note', item}` |
  | outliner object | `{kind:'object', item}` |

## Time and play

- **Playhead:** `editor.time` (s), always **story time**. Every frame `story.forceP = time / duration` (no
  smoothing), with `story.authored = true`: stretch regions show one cycle, for item `story.previewItem` (the
  stretch inspector's ◀ ▶). *Open site* converts with `tl.warp(time, previewItem)`.
- **Play (`playMode 'site'`):** wheel, keys, page drag or the scrollbar move `scrollT`. The px → s conversion uses
  the site's real page length: `(duration·scrollPerSecond − 100) vh`. `time` eases toward `scrollT` with the site's
  smoothing, and `layers.editing = false`, so clickable layers work.
- **Auto-play (`'auto'`):** time advances × speed.
- **Stop** returns to where Play started.
- **Views:** the Scene view uses OrbitControls plus WASD fly on the render camera, and the gizmos are visible. The
  Game view copies `story.cam`. Play forces the Game view.

## Hooks from main.js (the `app` object)

`renderer, scene, camera, controls, story, timeline, layers, data (DataHub), tuna, opts, buildPost, onResize, hidden (Set),
fpsInfo, setTunaCount, objects (outliner), setTimeScale, capture()`. The editor calls `onResize()` when its viewport
changes, and `viewSize()` gives the render size.

## Saving

See [dev-server.md](dev-server.md).
- **Save** posts to `/__editor/save` with `X-Base-Hash` (FNV-1a of the story.json bytes this tab loaded or last
  saved). A 409 means the file changed outside the editor: autosave pauses and a dialog offers *Load theirs*
  (undoable) or *Keep mine* (`X-Force: 1`).
- **Autosave** (default 60 s) waits for 2 s without edits.
- **Without the dev server:** the File System Access picker, or else a download.

## Adding an editor feature: checklist

1. Data in `story.json`? Document it in [story-format.md](story-format.md), and add migration if the shape changes.
2. Runtime support (story.js / layers.js) must work without the editor.
3. Editor UI: an inspector field, a right-click menu entry, a timeline drawing / hit-test if it's on the timeline.
   Respect locks.
4. User doc: EDITOR.md. Test with real mouse / keyboard events ([testing.md](testing.md)).
