# .tuna projects, building a site, live data

Open Tuna is a web graphics tool. The **editor** edits a **document**. The document is either the repo's own story or
a **.tuna project file**. **Build** turns a document into a standalone website. **Data sources** let the site pull
content from an API or CMS at runtime.

```
 .tuna file (anywhere on disk)  ──open──►  projects/<slug>/  (working copy, served by the dev server)
        ▲                                        │  autosave, checkpoints, uploads
        └──────────── Save (Ctrl+S) ─────────────┘
 repo story (story.json + assets/ at the root)  ──  saved to git, deployed by GitHub Pages
 either one  ──File ▸ Build site──►  <title>-site.zip / a folder  ──►  any static host (HTTPS)
```

## The .tuna format (`src/editor/project.js`)

A zip (rename it to .zip to look inside):

| Entry | What |
|---|---|
| `manifest.json` | `{ format: "open-tuna", version: 1, name, title, created, modified, duration }`. `version` is `TUNA_VERSION`; bump it when the layout changes, and keep reading older ones. |
| `story.json` | the timeline (see [story-format.md](story-format.md)) |
| `assets/**` | every file in the project's `assets/` (uploads, pages, models): the project's library |
| `saves/checkpoints/*.json` | named checkpoints |
| `thumb.webp` | a 640 px frame of the viewport at save time (the preview in File ▸ Projects) |

Media that's already compressed (images, video, audio, glb) is stored as-is; JSON / SVG / HTML are deflated. The
built-in creature models are part of the engine and are **not** in the file. Autosaves (`saves/auto/`) are not
included either.

### Working copy

Opening a .tuna (File ▸ Open, Ctrl+O, or dropping it on the editor) unzips it in the browser (fflate, from the
import map) and writes it file by file into **`projects/<slug>/`** through the dev server (`project/new` + `put`,
see [dev-server.md](dev-server.md)). Then the editor reloads on `?edit&project=<slug>`. `projects/` is
gitignored: it's a cache of opened files. Do **not** delete a working copy whose .tuna was never saved: it might be
the only copy.

With `?project=<slug>`:
- `src/project.js` sets `BASE = "projects/<slug>/"`. The runtime fetches `BASE + story.json`.
- `assetURL(src)` maps story paths `assets/…` to `BASE + assets/…`. Everything that loads a story file must use it
  (layers, the data hub, thumbnails, the Assets tab). Root paths (`tuna_fish.glb`) are left alone.
- `fixHTML()` rewrites `src= / href= / poster= / url(` references to `assets/` inside HTML layers.
- Every `/__editor/*` call carries `&project=<slug>` (`editorAPI()`), so save / autosave / checkpoints / uploads /
  the asset list all work inside the working copy. Git is off for projects.

### Saving

- **Ctrl+S** in a project: saves the working copy (the usual conflict-checked save), then **writes the .tuna file**.
  It goes to the same file you opened, through a File System Access handle kept in IndexedDB (`open-tuna` → `kv` →
  `handle:<slug>`). The first time (or with *Save .tuna as…*), a save dialog asks where. Without the API, the file
  is downloaded.
- **Autosave** only writes the working copy. The status bar then says *.tuna not saved* (`saved:<slug>` in
  IndexedDB = fnv1a of the story last written to the file).
- **Repo story:** Ctrl+S saves `story.json` as before. *File ▸ Save as .tuna file…* packages it (story + assets +
  checkpoints) into a .tuna without switching to it.
- **New project:** blank (ocean, a camera, an empty timeline) or a copy of the current story. Either way it's packed
  and unpacked like an opened file.

## Build site (`src/editor/build.js`)

File ▸ **Build site…** collects a standalone site and saves it as a zip, or writes it into a chosen folder:
- `index.html` with `window.OPEN_TUNA_BUILD = true` (then `main.js` ignores `?edit`, `?lab` and `?project`) and the
  story's title.
- The runtime modules, found by following `import` statements from `src/main.js`. **`src/editor/` is never
  included.** A new runtime module is picked up automatically as long as it's imported with a relative path
  (static `import … from './x.js'` or `import('./x.js')`).
- Models: every quoted `*.glb` literal in the runtime modules (the scene's creatures), plus built-in models used by
  model clips.
- `story.json`: the editor's current text, unsaved changes included.
- `assets/…`: every `assets/` path mentioned in the story, plus files that its `.html` / `.svg` / `.css` assets
  reference with relative paths. Unused uploads are left out.
- `.nojekyll` and `README.txt` (how to host it).

The dialog lists the files and warns about data sources (CORS, no sample, public headers) and other sites the story
loads from. Hosting needs **HTTPS** (WebGPU only runs in secure contexts) and internet (three.js and the fonts come
from CDNs). Verified: a build served by `python -m http.server` runs with zero errors.

## Live data (`src/data.js`)

`story.json` → `"sources": [{ id, url, headers?, refresh?, sample? }]`. A `DataHub` (in `main.js`, re-synced
whenever the timeline version changes) does three things:
- It shows each source's `sample` at once, then the live JSON when `url` answers (`refresh` = poll every n
  seconds).
- On error (offline, CORS, HTTP errors) it keeps the sample and records `status[id] = { state: 'error', error }`.
- It bumps `version` whenever a value changes. `Layers` and the captions rebuild when that happens.

**Bindings:** `{{id.path}}` or `{{id.path | fallback}}`, where the path is made of `.key` and `[index]` parts. They
are resolved in layer `title` / `kicker` / `body` / `html` / `src` and in caption `title` / `sub`. Objects render as
JSON; a missing value or an empty string gives the fallback.

A relative `url` is a file of the story (`assets/data.json`, through `assetURL`). Absolute URLs are fetched from the
visitor's browser, so the API must send CORS headers for the site's domain.

**Security:** `headers` ship to every visitor. Only public, read-only tokens belong there (a CMS "delivery" key).
For anything secret, put a small proxy / serverless function in front and point `url` at that.

Editor: the **Data** tab (`src/editor/data-panel.js`) adds and edits sources and shows their status. It browses
the JSON as a tree; clicking a value copies its binding or puts it into the selected text / media layer or caption.
*Save the current data as the sample* snapshots the live response. The inspector shows what each bound field
resolves to right now. Renaming a source rewrites the bindings that use it.

Not done yet (ideas): repeating a layer per array item (product cards from a list), images from a CMS in GPU layers
needing CORS on the image CDN (DOM layers don't), and secrets through a proxy.
