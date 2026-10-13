# Open Tuna — WebGPU ocean story + timeline editor

Scroll-driven, cinematic brand experience for **Thai Union's 50th anniversary (1977–2027)**. It's an internal
sales pitch / mock-up, built on **three.js r180 WebGPU + TSL**. There is no build step: ES modules, an import map,
and three.js from a CDN.

The story: an underwater world (a 2000-fish GPU tuna school, sharks, whales, turtles, jellies) → the camera rises
out of the sea → **tentacles of water** braid up and draw a **"50"** at golden hour while tuna leap → a demo
chapter, "The Journey" (1:00–2:30). An in-repo, Unity-style **editor (`?edit`)** edits *when* things happen, plus
camera, captions, media layers, 3D model clips and creature paths. All of that is stored in **`story.json`**:
either the repo's own story, or a **`.tuna` project file** (a zip, opened into `projects/<slug>/`). *Build site*
exports a standalone website, and **data sources** bind API / CMS JSON into layers with `{{bindings}}`.

This file is the entry point. Details live in `docs/` — read the one you need:

| Doc | Read it when |
|---|---|
| [docs/ai-workflows.md](docs/ai-workflows.md) | **Start here for any task.** Recipes: a pasted "Copy ref", designer notes, adding a story beat / param / layer / model clip, editing story.json safely, committing / deploying |
| [docs/story-format.md](docs/story-format.md) | Reading or editing `story.json`: every track type and field, layers, paths, groups / lanes, params / drivers / actors |
| [docs/architecture.md](docs/architecture.md) | Changing the 3D runtime: main loop, ocean, fish school + leaps, water 50, creatures, layers renderer, post, performance |
| [docs/editor.md](docs/editor.md) | Changing the editor (`src/editor/`): modules, selection / undo model, timeline rows, gizmos, saves, play modes |
| [docs/projects-build-data.md](docs/projects-build-data.md) | `.tuna` project files, `?project=` working copies, *Build site*, live data sources and `{{bindings}}` |
| [docs/dev-server.md](docs/dev-server.md) | The local servers (`tools/serve.py` / `serve.ps1`) and their `/__editor/*` API |
| [docs/deploy.md](docs/deploy.md) | Running the studio on a company server: HTTPS proxy, `--password`, `--no-git`, `--landing` |
| [docs/assets.md](docs/assets.md) | GLB models (per-model fixes), `assets/`, the demo placeholder art |
| [docs/testing.md](docs/testing.md) | Verifying anything: headless Chrome + puppeteer recipes, fps, WebGPU errors, **test hygiene** |
| [docs/gotchas.md](docs/gotchas.md) | Before touching rendering / the editor: bugs already paid for |
| [EDITOR.md](EDITOR.md) | The designer's guide to the editor (user-facing; keep it in sync with features) |
| [HANDOFF.md](HANDOFF.md) | Vision, decisions made with the owner, current state, next steps |

## Hard requirements (from the owner)

- **100% WebGPU.** No WebGL fallback: `main.js` refuses to run without a WebGPU backend. Don't add `forceWebGL`.
- **Spectacle, but smooth on mid-range hardware.** The old ray-marched 50 froze an M1 Air; never again. No
  full-screen ray marching. Check fps at the story points you touch.
- **At least 200 tuna** as a GPU swarm (default 2000, max 4096). Each creature system is one instanced draw.
- **The "50" is water, NOT fish.** Glossy translucent blue water tentacles, glimpses of golden thread (not all
  gold), formed smoothly, with nothing popping in. No brand label text on screen.
- **Tuna:** most leap around / across / over the camera; only a few leap through the 0. No teleporting fish.
- **The ocean is stylised and procedural** (waves, sky, seabed, caustics, foam). The sky is visible from underwater,
  and the water is see-through from above. Only creatures and props come from GLBs. No pre-rendered or AI video.
- **Directed creatures obey.** A path clip has priority over a creature's own behaviour (no sliding, no snapping back).
- **The UI should be art-directed.** Media should live *in* the shader scene (GPU layers), not as flat web boxes.
  HTML is for real interaction only.

## Run

```sh
python3 tools/serve.py --open        # home http://localhost:8123/studio.html · editor /index.html?edit · site /
```
Use Chrome or Edge (WebGPU). For non-developers there are double-click launchers: `Open Editor.bat` (Windows,
which falls back to `tools/serve.ps1` without Python) and `Open Editor.command` (macOS).

URL flags:
- `studio.html` — the studio home page (demo, new / open / recent projects). The launchers open it.
- `?edit` — the editor (`&project=<slug>`: an opened .tuna project in `projects/<slug>/`).
- `?t=42` / `?p=0.7` — open the site at that point (seconds / progress).
- `?lab` (`&free`) — the old playground.
- `?noauto` — fixed resolution, for tests.
- `?debug` — facing arrows on the creatures.

**Deploy:** GitHub Pages serves the `main` branch root. **Every push to `main` is public within about a minute**
(https://itipats.github.io/open-tuna/). The owner is fine with working on `main`; still, say when a push is about
to happen. Keep asset paths relative.

## Where things are

```
story.json            THE STORY DATA (times in seconds). Edited by the editor — see docs/story-format.md
index.html            page shell: import map, fonts, #captions overlay (captions + DOM layers), lab panel
studio.html           the studio home page (+ studio/*.jpg, frames of the demo); uses src/editor/project.js helpers
src/main.js           bootstrap, scene assembly, post, params -> uniforms, main loop
src/story.js          Story: story time -> camera / sun / params / school / water 50 / leaps / paths / captions;
                      PARAMS, DRIVERS, ACTORS registries; flightTargets()
src/timeline.js       story.json model + evaluation + migration + serializer
src/layers.js         media / text / glass / model layers (DOM overlays and GPU shader layers)
src/project.js        which story is open (repo / ?project=) -> BASE, assetURL(), editorAPI(); build flag
src/data.js           DataHub: API / CMS sources, {{binding}} resolution
src/swarm.js          GPU boids + leaps + breaching          src/tentacles.js   the water "50"
src/ocean.js          ocean, sky, seabed                     src/shared.js      global uniforms U, caustics, sky colour
src/creatures.js      animated GLB wrapper, SwimPath, Hunter src/particles.js   splashes, marine snow, bubbles
src/jellies.js        procedural jellyfish                   src/vegetation.js  seagrass
src/models.js         GLTF loading / baking / material conversion        src/director.js  lab-mode camera
src/editor/           the editor (only loaded with ?edit) — docs/editor.md
tools/serve.py|.ps1   dev servers (save system, uploads, ranges) — docs/dev-server.md
assets/               editor-uploaded media (+ assets/demo placeholder art)     *.glb  creature / prop models
saves/                checkpoints/ (committed) and auto/ (backups of story.json, gitignored — never delete)
projects/             working copies of opened .tuna files (gitignored — may be someone's only copy: never delete)
EDITOR.md  HANDOFF.md  docs/
```

## Working rules (read before editing anything)

1. **The designer edits `story.json` live** in the editor, with autosave. Before you write it: diff it against git,
   keep their changes, and build on the current file. After you write it, tell them to reload or choose "Load
   theirs" (the save-conflict check will prompt them). Respect `locked: true`. Details: docs/ai-workflows.md.
2. **Never delete `saves/auto/*`, `saves/checkpoints/*`, `projects/*` or files you didn't create.** Those are the
   designer's backups, projects and assets.
3. **Test in headless Chrome** (docs/testing.md). Screenshot the story points you changed. Check zero console *and*
   WebGPU errors (attach `uncapturederror`), and check fps when you touch rendering. If an editor test made edits,
   restore them, and never leave an editor tab open with unsaved test edits (it autosaves into `story.json`).
4. **Timings belong in `story.json`, behaviour in code.** A new story beat = a `DRIVERS` / `PARAMS` / `ACTORS` entry
   plus code that reads it (docs/ai-workflows.md).
5. **Keep the docs true.** When you change behaviour, update the doc that describes it, EDITOR.md for user-facing
   features, and HANDOFF.md's state.
6. **Two servers, one API.** `tools/serve.py` and `tools/serve.ps1` must stay in sync.
