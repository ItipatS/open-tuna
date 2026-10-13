# Editor internals (`src/editor/`, loaded only by `editor.html`)

The designer's guide is [EDITOR.md](../EDITOR.md). This doc covers how the editor is built.

## Modules

| File | Role |
|---|---|
| `editor.js` | `Editor`: DOM shell (top bar + project button + avatars + activity ticker, left Scene / Assets / Data / History tabs (`showTab`), viewport + rewind bar, inspector, timeline, resizable panels), menus (`menuFile/Edit/View/Help`), right-click menus (`contextItems(target)`), selection (`sels` / `sel`, `select(sel, mode)`), locks (`lockedBy`), `commit` / undo / redo (per person), live hooks (`adoptServer`, `applyRemote`, `renderPresence`), rewind (`enterPreview` / `exitPreview` / `previewDiff`), play modes (+ In–Out loop), keyboard + clipboard events, Copy ref / links (`copyLink`), groups / lanes, path waypoints. Bulk editing comes from `edit-ops.js` |
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
| `doc.js` | The story as **entities** (`doc`, `meta`, `settings`, `params`, `order`, `t:<track>`, `k:<track>:<id>`, `c:<track>:<id>`, `ch:<id>`, `n:<id>`) and **changes** `{e, set: {field: [before, after]}} \| {e, add} \| {e, del}`: `ensureIds`, `roundAll`, `entities`, `diff` / `diffDocs`, `apply` (in place, returns what really changed), `invert`, `stillValid`, `summarize` (History labels). **Mirrored in `tools/collab.py`** — change both |
| `sync.js` | `Sync`: live team editing against the studio server — join (`sync/state`), push committed edits in order (a queue, retried while offline), long-poll the edit stream, presence (who / playhead / selection), field marks so a remote edit never overwrites a pending / later edit of mine. `live` stays false without the server |
| `history-panel.js` | `HistoryPanel`: the left **History** tab — every edit (who, when, label), rewind preview (`editor.enterPreview`), *Restore this version* (`sync/restore`), *Undo just this* (`sync/revert`), the rewind slider |
| `edit-ops.js` | Bulk editing, **mixed into `Editor.prototype`**: `timedSelection`, clipboard v3 (`clipboardOf` / `copy` / `cut` / `paste` / `pasteValues`, system clipboard events, cross-project media via `asset-import`), `cloneSelection` (Alt-drag), `deleteSelection`, `duplicate`, `nudge`, `scaleTiming` / `scaleDialog`, `alignToPlayhead`, `distribute`, `splitAtPlayhead` / `splitBar`, select all / after / in range, In / Out (`range`, `loop`), `insertTime` / `deleteTime` (ripple), `replaceAsset`, `colorItems`, `multiItems` (right-click on a multi-selection) |
| `import.js` | `Importer`: File ▸ Import into this story — reads a .tuna / story.json, picks tracks / marks, uploads its media (`upload?dir=`), merges via `paste()` (optionally after `insertTime`) |
| `library.js` | `Library`: team snippets (`/__editor/library*`): save the selection, insert at the playhead (media via `asset-import?from=lib:<id>`) |
| `check.js` | `Checker`: File ▸ Check project — missing media (relink), unknown `{{source}}` bindings, timing problems, duplicate binds, ignored stretches, invisible layers, empty captions, slow moments (`editor.perf`), open notes, locks. `summary()` feeds the Build dialog |
| `recorder.js` | `Recorder`: File ▸ Record a review video — plays at 1×, composites the canvas (`app.onFrame`) + the visible captions into a 2D canvas, `MediaRecorder` → MP4 (avc3/avc1) or WebM, saved from a click in the "ready" dialog |
| `menu.js` | context menus / drop-downs (`openMenu`), modal dialogs (`dialog`) |
| `dom.js` | `h()` element helper, icons, `btn`, `download` |
| `editor.css` | the dark shell; mode colours via `#ed[data-mode]` (scene / game / playing) |

## Data flow

- The editor mutates `timeline.data` (the parsed story.json) **directly**.
- `editor.changed()` is for live edits: it re-sorts, bumps `timeline.version`, and redraws. Views and the runtime
  rebuild from `version`.
- `editor.commit(label?)` ends an edit. It gives new items ids (`ensureIds`), rounds numbers like the file
  (`roundAll`), and **diffs `editor.base`** (the story as last committed) against the data: those changes are ONE
  step — pushed on *my* undo stack, applied to `base`, sent to the server (`sync.push`, live), labelled for the
  History (`summarize` unless a label is given). No change, no step.
- **Undo / redo** (`step`): invert my last step, keep only the parts nobody changed since (`stillValid` against
  `base`), apply, commit (onto the other stack). Others' edits are never undone. The result is selected.
- **Remote edits** (`applyRemote`): applied to the data — except fields I'm changing right now (data ≠ base there) —
  and to `base`. Objects are changed in place, so selections and drags keep working.
- **Ids:** every key / clip / chapter / note has a short random `id`, tracks have theirs. Anything that creates
  items must not reuse an id (copies go through `fresh()` / `copyTrack()`); `ensureIds` fixes duplicates at commit,
  and on load matches id-less items to identical ones of the current story (so a restored version keeps ids).
- **Rewind / compare** (`enterPreview(text, {label, sub, restore})`): the timeline and viewport show another
  version; `realData()` is still the story (remote edits keep landing there, `current()` serializes it). Every
  edit is refused (`isLocked` is true, `commit` → `previewRefuse()` reloads the preview copy). `previewDiff()`
  outlines what changed since.
- **Locks:** every mutating action must check `isLocked(sel)` / `guard()` (both cover the whole multi-selection).
  Locks are inherited from the lane / group (`tl.lockedTrack`); `lockedBy` records who (`lockOwner`).
- **Selection:** `editor.sels` (everything selected), `editor.sel` (the primary one, shown by the inspector),
  `isSel(x)` (by object). `select(sel, mode)` with `mode` `'add'` / `'toggle'`, `selectMany`, `selectEntities(keys)`,
  `keyOf(sel)` (entity key — presence). Shapes:

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
fpsInfo, setTunaCount, objects (outliner), setTimeScale, capture(), onFrame(fn)` (called after every rendered frame — the recorder). The editor calls `onResize()` when its viewport
changes, and `viewSize()` gives the render size.

## Saving

See [dev-server.md](dev-server.md).
- **Live** (the studio server answers `ping` with `sync: true`): `sync.start()` joins and adopts the server's story
  (`adoptServer`). There is nothing to save — `saves.dirty` = edits not sent yet, autosave / drafts / conflict
  dialogs are off, Save writes the `.tuna` (projects) or just says it's saved, and leaving only warns about unsent
  edits.
- **Save** posts to `/__editor/save` with `X-Base-Hash` (FNV-1a of the story.json bytes this tab loaded or last
  saved). A 409 means the file changed outside the editor: autosave pauses and a dialog offers *Load theirs*
  (undoable) or *Keep mine* (`X-Force: 1`).
- **Autosave** (default 60 s) waits for 2 s without edits.
- **Leaving:** `project.unsaved` (story dirty, .tuna out of date, upload / save running) drives the `beforeunload`
  prompt, the • in the title and `project.leave()` → *Save changes?* (Save / Don't save / Cancel) before any
  navigation inside the studio. Navigate with `project.go()` (sets `editor.leaving`, so the prompt doesn't fire twice).
- **Without the dev server:** the File System Access picker, or else a download.

## Adding an editor feature: checklist

1. Data in `story.json`? Document it in [story-format.md](story-format.md), and add migration if the shape changes.
2. Runtime support (story.js / layers.js) must work without the editor.
3. Editor UI: an inspector field, a right-click menu entry, a timeline drawing / hit-test if it's on the timeline.
   Respect locks.
4. User doc: EDITOR.md. Test with real mouse / keyboard events ([testing.md](testing.md)).
