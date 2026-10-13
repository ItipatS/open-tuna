# Open Tuna Studio — a WebGPU tool for scroll-driven 3D stories

This repository is **the tool**: a studio (home page + Unity-style timeline editor + player + exporter) for
scroll-driven, cinematic WebGPU ocean stories, built on **three.js r180 WebGPU + TSL**. There is no build step: ES
modules, an import map, and three.js from a CDN.

Stories are **projects**, separate from the tool:
- **Demo projects** ship with the tool in `demos/<id>/`. The first one is **Thai Union's 50th anniversary
  (1977–2027)**, `demos/thai-union/`, our internal pitch: an underwater world (a 2000-fish GPU tuna school,
  sharks, whales, turtles, jellies) → the camera rises out of the sea → **tentacles of water** braid up and draw a
  **"50"** at golden hour while tuna leap → a demo chapter, "The Journey".
- **User projects** are `.tuna` files (a zip). Opening one makes a working copy in `projects/<slug>/`.
- **A customer gets an export**, not the tool: *File ▸ Build site* writes a standalone site (player + story +
  used media + models, no editor) to upload to any HTTPS host.

Each project's timing and content live in its **`story.json`** (camera, captions, media layers, 3D model clips,
creature paths, CMS data sources with `{{bindings}}`, and stretch scenes that grow with the CMS).

This file is the entry point. Details live in `docs/` — read the one you need:

| Doc | Read it when |
|---|---|
| [docs/ai-workflows.md](docs/ai-workflows.md) | **Start here for any task.** Recipes: a pasted "Copy ref", designer notes, adding a story beat / param / layer / model clip, editing a story safely, committing / deploying |
| [docs/story-format.md](docs/story-format.md) | Reading or editing a `story.json`: every track type and field, layers, paths, stretch, groups / lanes, params / drivers / actors |
| [docs/architecture.md](docs/architecture.md) | Changing the 3D runtime: main loop, ocean, fish school + leaps, water 50, creatures, layers renderer, post, performance |
| [docs/editor.md](docs/editor.md) | Changing the editor (`src/editor/`): modules, selection / undo model, timeline rows, gizmos, saves, play modes |
| [docs/projects-build-data.md](docs/projects-build-data.md) | Projects (demos, `.tuna` files, working copies), *Build site* (the export), live data sources and `{{bindings}}` |
| [docs/dev-server.md](docs/dev-server.md) | The studio servers (`tools/serve.py` / `serve.ps1`) and their `/__editor/*` API |
| [docs/deploy.md](docs/deploy.md) | Running the studio on a company server: HTTPS proxy, `--password`, `--no-git` |
| [docs/assets.md](docs/assets.md) | The built-in models (`models/`, per-model fixes), project `assets/`, the demo placeholder art |
| [docs/testing.md](docs/testing.md) | Verifying anything: headless Chrome + puppeteer recipes, fps, WebGPU errors, **test hygiene** |
| [docs/gotchas.md](docs/gotchas.md) | Before touching rendering / the editor: bugs already paid for |
| [EDITOR.md](EDITOR.md) | The designer's guide to the studio (user-facing; keep it in sync with features) |
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
- **The tool and the projects stay separate.** Customers get exported builds; nothing customer-specific goes into
  the tool's code.

## Run

```sh
python3 tools/serve.py --open        # the studio home: http://localhost:8123/
```
Use Chrome or Edge (WebGPU). For non-developers there are double-click launchers: `Open Editor.bat` (Windows,
which falls back to `tools/serve.ps1` without Python) and `Open Editor.command` (macOS).

Pages:
- `/` (`index.html`) — the studio start screen (like an Adobe app's Home): New project, Open…, Recent, Demos, Learn.
  Offline (no server, e.g. GitHub Pages) it says so and only plays demos. Old `/?t=` `/?edit` links redirect.
- `editor.html?project=<id>` — the editor. `<id>` = `demo/thai-union` (a demo) or a project slug.
- `play.html?project=<id>` — the player: the project as visitors will see the export. `&t=42` / `&p=0.7` open it at a
  point; `play.html?lab` (`&free`) is the old playground.
- `&noauto` — fixed resolution, for tests. `&debug` — facing arrows on the creatures.

**Deploy:** GitHub Pages serves the `main` branch root, so **every push to `main` is public within about a minute**
(https://itipats.github.io/open-tuna/: the studio home, read-only there; the pitch is
`play.html?project=demo/thai-union`). The owner is fine with working on `main`; still, say when a push is about to
happen. The team's real studio runs on a company server (docs/deploy.md). Keep paths relative.

## Where things are

```
index.html            the studio start screen (Home / Your projects / Demos / Learn); uses src/editor/project.js helpers
editor.html           the editor page    } the same page shell (src/page.css); window.OPEN_TUNA_PAGE says which.
play.html             the player page    } play.html is also the template of every exported site — keep them in sync
src/main.js           bootstrap, scene assembly, post, params -> uniforms, main loop
src/project.js        which project is open (?project=) -> BASE, assetURL(), editorURL / playURL, editorAPI(); build flag
src/story.js          Story: story time -> camera / sun / params / school / water 50 / leaps / paths / captions;
                      PARAMS, DRIVERS, ACTORS registries; flightTargets()
src/timeline.js       story.json model + evaluation + stretch (site time <-> story time) + migration + serializer
src/layers.js         media / text / glass / model layers (DOM overlays and GPU shader layers)
src/data.js           DataHub: API / CMS sources, {{binding}} / {{#each}} resolution, the current stretch item
src/swarm.js          GPU boids + leaps + breaching          src/tentacles.js   the water "50"
src/ocean.js          ocean, sky, seabed                     src/shared.js      global uniforms U, caustics, sky colour
src/creatures.js      animated GLB wrapper, SwimPath, Hunter src/particles.js   splashes, marine snow, bubbles
src/jellies.js        procedural jellyfish                   src/vegetation.js  seagrass
src/models.js         GLTF loading / baking / material conversion        src/director.js  lab-mode camera
src/editor/           the editor (editor.html only) — docs/editor.md; project.js (.tuna), build.js (export)
tools/serve.py|.ps1   studio servers (projects, saves, uploads, ranges, git for demos) — docs/dev-server.md
models/               the tool's built-in GLB models (creatures, coral)
demos/<id>/           demo projects: story.json, manifest.json, thumb.jpg, assets/, saves/checkpoints/ (committed)
demos/index.json      the demo list for the start screen when there's no server (GitHub Pages) — add new demos here
projects/<slug>/      working copies of .tuna projects (gitignored — may be someone's only copy: never delete)
EDITOR.md  HANDOFF.md  docs/
```

## Working rules (read before editing anything)

1. **Find the right story.** A Copy ref names the project and its folder (`demos/<id>/` or `projects/<slug>/`). The
   designer edits it live, with autosave. Before you write its `story.json`: diff it against git (demos), keep their
   changes, and build on the current file. After you write it, tell them to reload or choose "Load theirs". Respect
   `locked: true`. Details: docs/ai-workflows.md.
2. **Never delete `saves/auto/*`, `saves/checkpoints/*`, `projects/*` or files you didn't create.** Those are the
   designer's backups, projects and assets.
3. **Test in headless Chrome** (docs/testing.md), in a throwaway project when you need to edit. Screenshot the story
   points you changed. Check zero console *and* WebGPU errors (attach `uncapturederror`), and check fps when you
   touch rendering. Never leave an editor tab open with unsaved test edits (it autosaves).
4. **Timings belong in `story.json`, behaviour in code.** A new story beat = a `DRIVERS` / `PARAMS` / `ACTORS` entry
   plus code that reads it (docs/ai-workflows.md). Tool code stays generic; project content stays in the project.
5. **Keep the docs true.** When you change behaviour, update the doc that describes it, EDITOR.md for user-facing
   features, and HANDOFF.md's state.
6. **Two servers, one API.** `tools/serve.py` and `tools/serve.ps1` must stay in sync.
